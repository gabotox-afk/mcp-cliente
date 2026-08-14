import Anthropic from "@anthropic-ai/sdk";
import { listTools, callTool, SessionExpiredError, type AnthropicTool, type McpSession } from "./mcp-client.ts";
import { buildChart, type ChartData } from "./charts.ts";
import { ANTHROPIC_API_KEY, MODEL, EFFORT, SUPPORTS_EFFORT, AGENT_MODE, MAX_TOOL_ITERATIONS } from "./config.ts";

// Eventos que el agente le va emitiendo al front. El server los serializa a SSE.
export type ChatEvent =
  | { type: "text";       text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end";   name: string; ok: boolean }
  | { type: "chart";      chart: ChartData }
  | { type: "session_expired" }
  | { type: "done" }
  | { type: "error";      message: string };

export type Emit = (e: ChatEvent) => void;

export type ChatMessage = { role: "user" | "assistant"; content: string };

// Prompt del sistema. Es configuración por despliegue: acá va lo que el chat
// debe saber del dominio. Deliberadamente NO enumera tools — el modelo las ve
// en el catálogo que le pasamos, así que este prompt sirve igual para
// cualquier MCP.
//
// Lleva la fecha de hoy. Sin eso, un asistente de analítica no puede responder
// nada relativo al tiempo: "el año pasado" o "el último trimestre" no tienen
// referencia y el modelo termina inventando un año.
//
// La fecha va con precisión de día, así que el prefijo cacheado cambia una vez
// por día y no una vez por request. Es la única parte variable admisible acá:
// meterle el nombre del usuario o la hora exacta rompería el cache de verdad.
// Se calcula por request y no al importar el módulo porque el server queda
// levantado varios días y la fecha se quedaría vieja.
function systemPrompt(): string {
  const hoy = new Date().toISOString().slice(0, 10);
  return `Sos un asistente de analítica que responde preguntas consultando las herramientas disponibles.

Hoy es ${hoy}. Usalo para resolver cualquier referencia temporal relativa ("este año", "el mes pasado", "los últimos 6 meses") antes de armar los filtros de fecha.

Reglas:
- Respondé SIEMPRE en base a lo que devuelven las herramientas. Nunca inventes cifras ni completes datos que no obtuviste.
- NUNCA completes una lista. Si una herramienta devolvió 8 resultados, son 8: no agregues elementos para que parezca más completa, no inventes nombres de personas, y no rellenes con valores plausibles. Una lista corta y cierta sirve; una larga con inventos es peor que no responder. Si sospechás que faltan datos, decilo en vez de taparlo.
- Nunca inventes un nombre de persona. Los nombres salen de las herramientas o no se mencionan.
- No uses tablas markdown. La burbuja del chat es angosta — una tabla con varias columnas queda amontonada o cortada, ilegible. Para listar varios ítems con datos cada uno, usá una lista con viñetas, un ítem por línea, con lo importante en negrita: "**kiosk1** — Autoservicio, libre, sin conectar desde el 07/08". Si de verdad hace falta una tabla (pocas columnas, muchas filas, todas del mismo tipo de dato), que sea corta y sin abusar de columnas.
- Si ninguna herramienta puede responder la pregunta, decilo claramente en vez de aproximar.
- Los datos de pacientes vienen anonimizados a propósito: no tienen nombre. No inventes nombres ni intentes identificar personas.
- Respondé en castellano rioplatense, de forma concisa y directa. Dar el número o el hallazgo primero, el detalle después.
- Si una pregunta necesita varias consultas, hacelas y después resumí.
- Si el pedido admite una lectura razonable, resolvelo con esa lectura y aclarala al responder. No pidas permiso ni aclaraciones para algo que podés asumir: el usuario corrige si no era lo que quería, y pedirle que reformule le cuesta más que ver un resultado y ajustarlo. Preguntá solo si hay dos lecturas muy distintas y elegir mal lo mandaría para cualquier lado.
- Si no te dan un rango de fechas, usá todos los datos disponibles. No pidas fechas.
- Antes de decir que un dato no existe, fijate en lo que devuelven las herramientas. Los campos interesantes suelen venir anidados: el profesional de una atención está en professional.name, no en un campo suelto.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools locales: las resuelve este backend, no el MCP.
//
// Dibujar es asunto del cliente, no del dato. El MCP expone números; qué se
// hace con ellos lo decide quien los consume. Por eso `generate_chart` vive
// acá y no en el MCP de la empresa — que además ni siquiera sabe que existe un
// chat. Es el mismo razonamiento por el que en su momento se sacaron del MCP
// las tools de generar PDF e imágenes.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_TOOLS: AnthropicTool[] = [
  {
    name: "generate_chart",
    description:
      "Dibuja un gráfico en la conversación a partir de los datos de una herramienta de listado. " +
      "Usala cuando el usuario pida ver algo graficado, visualizado, en torta, en barras o como evolución. " +
      "No le pases números: vos elegís QUÉ graficar (qué entidad y por qué campo agrupar) y el gráfico se " +
      "construye consultando los datos directamente. Después de llamarla, comentá brevemente el hallazgo; " +
      "no hace falta que repitas todos los valores porque el usuario ya ve el gráfico.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "Herramienta de listado de la que salen los datos, por ejemplo 'list_videovisits' o 'list_sessions'. " +
            "Tiene que empezar con list_ — las count_ devuelven un número y no sirven para agrupar.",
        },
        group_by: {
          type: "string",
          description:
            "Campo de cada fila por el que agrupar, por ejemplo 'specialty', 'status', 'type' o 'date'. " +
            "Acepta rutas anidadas con punto: 'professional.name' agrupa por el nombre del profesional " +
            "que está adentro del objeto 'professional'. Si el campo no existe o es un objeto, el error " +
            "te va a decir qué rutas hay disponibles — probá de nuevo con una de ésas.",
        },
        type: {
          type: "string",
          enum: ["bar", "doughnut", "line"],
          description: "Tipo de gráfico. 'doughnut' para torta, 'line' para evolución en el tiempo.",
        },
        bucket: {
          type: "string",
          enum: ["day", "month"],
          description:
            "Solo cuando agrupás por una fecha: si cada punto es un día o un mes. Usá 'month' para " +
            "rangos largos — un punto por día sobre dos años son cientos de puntos ilegibles. " +
            "Por defecto agrupa por día.",
        },
        title: { type: "string", description: "Título del gráfico, en castellano." },
        from: { type: "string", description: "Fecha de inicio ISO (opcional)." },
        to:   { type: "string", description: "Fecha de fin ISO (opcional)." },
      },
      required: ["source", "group_by"],
    },
  },
];

const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

// Ejecuta una tool local. Devuelve el texto que ve el modelo; el gráfico en sí
// viaja al front por separado, vía `emit`.
async function callLocalTool(
  session: McpSession,
  name: string,
  input: Record<string, unknown>,
  emit: Emit,
): Promise<{ text: string; isError: boolean }> {
  if (name !== "generate_chart") {
    return { text: `Tool local desconocida: ${name}`, isError: true };
  }
  try {
    const chart = await buildChart(session, input as Parameters<typeof buildChart>[1]);
    emit({ type: "chart", chart });

    // Al modelo le devolvemos los valores agrupados igual. No es para que los
    // transcriba —el gráfico ya salió— sino para que pueda comentar el
    // resultado sin tener que hacer otra consulta.
    const resumen = chart.labels.map((l, i) => `${l}: ${chart.values[i]}`).join(", ");
    return {
      text:
        `Gráfico "${chart.title}" mostrado al usuario (${chart.type}). ` +
        `Datos: ${resumen}.` +
        (chart.truncated ? ` OJO: es una muestra de ${chart.counted} sobre ${chart.total} registros.` : ""),
      isError: false,
    };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agente real: loop de tool use contra la API de Claude.
// ─────────────────────────────────────────────────────────────────────────────

// Devuelve una copia de los mensajes con un punto de cache en el último bloque.
// Va sobre una copia y no sobre el array original: si el marcador quedara
// pegado en el historial, la vuelta siguiente mandaría dos marcadores en
// posiciones distintas y el prefijo cambiaría en cada iteración — justo lo que
// rompe el cache.
function withHistoryBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const out = [...messages];
  const last = out[out.length - 1]!;
  const blocks = Array.isArray(last.content) ? [...last.content] : null;
  if (!blocks || blocks.length === 0) return out;

  const lastBlock = blocks[blocks.length - 1]!;
  blocks[blocks.length - 1] = {
    ...lastBlock,
    cache_control: { type: "ephemeral" },
  } as typeof lastBlock;

  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

// Suma el uso de tokens de todas las vueltas del loop, para poder ver si el
// cache está funcionando. Si `cacheRead` queda en cero entre requests con el
// mismo prefijo, hay algo que lo está invalidando.
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

function logUsage(u: Usage) {
  const total = u.input + u.cacheRead + u.cacheWrite;
  const pct = total > 0 ? Math.round((u.cacheRead / total) * 100) : 0;
  process.stderr.write(
    `[chat] tokens — entrada:${u.input} cache_leido:${u.cacheRead} ` +
      `cache_escrito:${u.cacheWrite} salida:${u.output} (${pct}% del prompt vino del cache)\n`,
  );
}

async function runReal(session: McpSession, history: ChatMessage[], emit: Emit, signal?: AbortSignal): Promise<void> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // El catálogo de tools sale del MCP, no está hardcodeado. A eso se le suman
  // las locales, que resuelve este backend. El orden es fijo (MCP primero,
  // locales después) porque el cache es coincidencia exacta de bytes.
  const tools = [...(await listTools(session)), ...LOCAL_TOOLS];

  // Contenido siempre como array de bloques (nunca string suelto): el cache es
  // coincidencia exacta de bytes, así que la forma tiene que ser idéntica en
  // todas las requests o el prefijo deja de matchear.
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: [{ type: "text" as const, text: m.content }],
  }));

  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    // Se chequea en cada vuelta y no solo al principio: una consulta que encadena
    // varias tools puede tardar, y cancelar tiene que frenarla en la vuelta
    // siguiente en vez de esperar a que termine sola.
    if (signal?.aborted) { logUsage(usage); return; }

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      // Punto de cache 1 — el grande. El orden de armado es tools → system →
      // messages, así que marcar el final del system deja cacheados el catálogo
      // de tools (~12k tokens) y el prompt juntos. Ese bloque es idéntico para
      // todos los usuarios y todas las conversaciones: lo escribe el primero que
      // pregunta y lo leen todos los demás a ~10% del precio.
      //
      // Por eso el system prompt tiene que ser una constante: si se le mete la
      // fecha, el nombre del usuario o cualquier cosa variable, cada request
      // pasa a tener su propio prefijo y el cache deja de servir.
      system: [
        { type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } },
      ],
      // NO desactivar el thinking en Opus 5 / Sonnet 5: con thinking apagado el
      // modelo a veces escribe la llamada a la tool como texto en vez de emitir
      // el bloque estructurado, y la llamada nunca se ejecuta — sin error, sin
      // aviso. Para controlar costo se baja el effort, no se apaga el thinking.
      // (En Haiku el thinking no aplica y effort no existe; ver SUPPORTS_EFFORT.)
      ...(SUPPORTS_EFFORT
        ? { output_config: { effort: EFFORT as "low" | "medium" | "high" } }
        : {}),
      tools,
      // Punto de cache 2 — el historial. Cada vuelta del loop reenvía todo lo
      // anterior (incluidos los resultados de tools, que pueden ser grandes),
      // así que marcar el final del último mensaje hace que la vuelta siguiente
      // lea en vez de reprocesar.
      messages: withHistoryBreakpoint(messages),
    }, { signal });

    // Los tokens de texto se van al front a medida que llegan.
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        emit({ type: "text", text: event.delta.text });
      }
    }

    const message = await stream.finalMessage();

    usage.input      += message.usage.input_tokens;
    usage.output     += message.usage.output_tokens;
    usage.cacheRead  += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason !== "tool_use") {
      logUsage(usage);
      return;
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // En paralelo: si el modelo pide varias tools en un mismo turno, no hay
    // razón para serializarlas. Los resultados vuelven todos en un único
    // mensaje de usuario, que es lo que la API espera.
    if (signal?.aborted) { logUsage(usage); return; }

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const input = (tu.input ?? {}) as Record<string, unknown>;
        emit({ type: "tool_start", name: tu.name, input });
        const r = LOCAL_TOOL_NAMES.has(tu.name)
          ? await callLocalTool(session, tu.name, input, emit)
          : await callTool(session, tu.name, input);
        emit({ type: "tool_end", name: tu.name, ok: !r.isError });
        return {
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: r.text,
          is_error: r.isError,
        };
      }),
    );

    messages.push({ role: "user", content: results });
  }

  logUsage(usage);
  emit({
    type: "text",
    text: "\n\n(Corté acá: la consulta necesitó demasiadas vueltas de herramientas.)",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Agente stub: sin API key. Elige una tool por similitud de palabras y muestra
// el resultado crudo. No entiende nada — existe para verificar que el circuito
// front → back → MCP → back → front funciona de punta a punta.
// ─────────────────────────────────────────────────────────────────────────────

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function pickTool(question: string, tools: { name: string; description: string }[]) {
  const q = normalize(question);
  const words = q.split(/[^a-z0-9_]+/).filter((w) => w.length >= 4);
  const quiereLista = /\blist|\bmostra|\bdame|\btrae/.test(q);

  let best = null as null | { tool: (typeof tools)[number]; score: number };

  for (const tool of tools) {
    // Solo la PRIMERA oración: ahí está lo que la tool hace. Lo que sigue es
    // la lista de filtros, y esa menciona entidades ajenas — la descripción de
    // count_sessions nombra "paciente" (por el filtro patient_id), así que
    // puntuar contra el texto completo hace que una pregunta sobre pacientes
    // matchee sesiones.
    const purpose = normalize(tool.description).split(/\.\s/)[0] ?? "";

    let score = 0;
    for (const w of words) {
      // Raíz, para que "sesiones" matchee "sesión" y "registradas" a "registrados".
      const stem = w.slice(0, Math.max(4, w.length - 2));
      if (purpose.includes(stem)) score++;
    }
    if (score === 0) continue;

    // Desempate count_ vs list_ según cómo esté formulada la pregunta.
    if (quiereLista) { if (tool.name.startsWith("list_")) score += 0.5; }
    else if (tool.name.startsWith("count_")) score += 0.5;

    if (!best || score > best.score) best = { tool, score };
  }

  return best?.tool ?? null;
}

async function runStub(session: McpSession, history: ChatMessage[], emit: Emit): Promise<void> {
  const question = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const tools = await listTools(session);

  emit({
    type: "text",
    text: "[modo stub — sin API key de Anthropic, no hay modelo interpretando]\n\n",
  });

  const tool = pickTool(question, tools);
  if (!tool) {
    emit({
      type: "text",
      text: `No encontré ninguna herramienta que se parezca a tu pregunta.\nHay ${tools.length} disponibles, por ejemplo: ${tools.slice(0, 5).map((t) => t.name).join(", ")}.`,
    });
    return;
  }

  emit({ type: "tool_start", name: tool.name, input: {} });
  const result = await callTool(session, tool.name, {});
  emit({ type: "tool_end", name: tool.name, ok: !result.isError });

  emit({ type: "text", text: `Ejecuté \`${tool.name}\` y el MCP devolvió:\n\n${result.text}` });
}

// ─────────────────────────────────────────────────────────────────────────────

export async function runAgent(
  session: McpSession,
  history: ChatMessage[],
  emit: Emit,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (AGENT_MODE === "real") await runReal(session, history, emit, signal);
    else await runStub(session, history, emit);
    emit({ type: "done" });
  } catch (err) {
    // Cancelar es lo que el usuario pidió, no una falla: se sale en silencio.
    // El front ya sabe que canceló porque fue él quien abortó.
    if (signal?.aborted || (err as { name?: string })?.name === "AbortError") return;

    // La sesión vencida no es "un error del chat": no hay nada que reintentar y
    // el usuario no puede hacer nada desde acá. Va como evento propio para que
    // el front avise claro en vez de mostrar un mensaje técnico.
    if (err instanceof SessionExpiredError) {
      emit({ type: "session_expired" });
      return;
    }
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

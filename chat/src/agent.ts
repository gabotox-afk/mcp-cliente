import Anthropic from "@anthropic-ai/sdk";
import { listTools, callTool, type McpSession } from "./mcp-client.ts";
import { ANTHROPIC_API_KEY, MODEL, EFFORT, SUPPORTS_EFFORT, AGENT_MODE, MAX_TOOL_ITERATIONS } from "./config.ts";

// Eventos que el agente le va emitiendo al front. El server los serializa a SSE.
export type ChatEvent =
  | { type: "text";       text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end";   name: string; ok: boolean }
  | { type: "done" }
  | { type: "error";      message: string };

export type Emit = (e: ChatEvent) => void;

export type ChatMessage = { role: "user" | "assistant"; content: string };

// Prompt del sistema. Es configuración por despliegue: acá va lo que el chat
// debe saber del dominio. Deliberadamente NO enumera tools — el modelo las ve
// en el catálogo que le pasamos, así que este prompt sirve igual para
// cualquier MCP.
const SYSTEM_PROMPT = `Sos un asistente de analítica que responde preguntas consultando las herramientas disponibles.

Reglas:
- Respondé SIEMPRE en base a lo que devuelven las herramientas. Nunca inventes cifras ni completes datos que no obtuviste.
- Si ninguna herramienta puede responder la pregunta, decilo claramente en vez de aproximar.
- Los datos de pacientes vienen anonimizados a propósito: no tienen nombre. No inventes nombres ni intentes identificar personas.
- Respondé en castellano rioplatense, de forma concisa y directa. Dar el número o el hallazgo primero, el detalle después.
- Si una pregunta necesita varias consultas, hacelas y después resumí.`;

// ─────────────────────────────────────────────────────────────────────────────
// Agente real: loop de tool use contra la API de Claude.
// ─────────────────────────────────────────────────────────────────────────────

async function runReal(session: McpSession, history: ChatMessage[], emit: Emit): Promise<void> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // El catálogo de tools sale del MCP, no está hardcodeado.
  const tools = await listTools(session);

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      // NO desactivar el thinking en Opus 5 / Sonnet 5: con thinking apagado el
      // modelo a veces escribe la llamada a la tool como texto en vez de emitir
      // el bloque estructurado, y la llamada nunca se ejecuta — sin error, sin
      // aviso. Para controlar costo se baja el effort, no se apaga el thinking.
      // (En Haiku el thinking no aplica y effort no existe; ver SUPPORTS_EFFORT.)
      ...(SUPPORTS_EFFORT
        ? { output_config: { effort: EFFORT as "low" | "medium" | "high" } }
        : {}),
      tools,
      messages,
    });

    // Los tokens de texto se van al front a medida que llegan.
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        emit({ type: "text", text: event.delta.text });
      }
    }

    const message = await stream.finalMessage();
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason !== "tool_use") return;

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // En paralelo: si el modelo pide varias tools en un mismo turno, no hay
    // razón para serializarlas. Los resultados vuelven todos en un único
    // mensaje de usuario, que es lo que la API espera.
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const input = (tu.input ?? {}) as Record<string, unknown>;
        emit({ type: "tool_start", name: tu.name, input });
        const r = await callTool(session, tu.name, input);
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

export async function runAgent(session: McpSession, history: ChatMessage[], emit: Emit): Promise<void> {
  try {
    if (AGENT_MODE === "real") await runReal(session, history, emit);
    else await runStub(session, history, emit);
    emit({ type: "done" });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

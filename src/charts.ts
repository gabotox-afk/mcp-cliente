import { callTool, type McpSession } from "./mcp-client.ts";

// Dos cosas viven acá:
//
//   - buildChart: arma un gráfico agrupando las filas de una tool de listado.
//     Lo usan tanto el modelo (vía generate_chart) como el front cuando el
//     usuario cambia el período o el tipo de un gráfico ya dibujado.
//
//   - buildSummary: los indicadores del panel de apertura, con comparación
//     contra el período anterior. No agrupa nada: son count_* con fechas, que
//     el backend responde con un número exacto.
//
// Antes había además un catálogo fijo de siete gráficos predeterminados. Se
// eliminó: eran combinaciones elegidas mirando qué campos existían, no qué le
// interesa a alguien, y desde que el chat grafica cualquier cosa a pedido eran
// una versión peor de lo mismo.

export type ChartType = "bar" | "doughnut" | "line";

// Todo lo necesario para reconstruir el gráfico. Viaja de vuelta al front con
// los datos justamente para eso: sin el spec, un gráfico es una foto muerta y
// no se puede cambiar el período ni el tipo sin volver a preguntar.
export type Bucket = "day" | "month";

export type ChartSpec = {
  source: string;
  group_by: string;
  type: ChartType;
  title: string;
  /** Solo cuando se agrupa por una fecha: si cada punto es un día o un mes. */
  bucket?: Bucket;
  from?: string;
  to?: string;
};

export type ChartData = ChartSpec & {
  labels: string[];
  values: number[];
  /** Filas efectivamente agrupadas. */
  counted: number;
  /** Total que reporta el backend. Si es mayor que `counted`, esto es una muestra. */
  total: number;
  truncated: boolean;
};

// Cuántas filas se piden para agrupar.
//
// El MCP no tiene group_by: no hay forma de pedirle "sesiones por estado", solo
// "dame las sesiones". Así que se traen las filas y se agrupan acá. Funciona
// para volúmenes acotados y no escala — y peor, una muestra cortada no es una
// muestra aleatoria: si el backend devuelve ordenado, las primeras N son un
// tramo y las proporciones pueden estar sesgadas. Por eso `truncated` se
// reporta y el front lo muestra.
const ROW_LIMIT = 1000;

// Resuelve una ruta con puntos: "professional.name" baja un nivel. Sin esto,
// cualquier campo anidado queda fuera de alcance — y los datos interesantes
// suelen estar anidados (el médico de una atención, por ejemplo).
function valueAt(row: Record<string, unknown> | undefined, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// Rutas agrupables de una fila de ejemplo, bajando un nivel en los objetos.
// Es lo que se le ofrece al modelo cuando pide un campo que no sirve.
function paths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${k}` : k;
    // Un solo nivel de profundidad: alcanza para los casos reales y evita
    // devolverle al modelo un árbol enorme.
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !prefix) {
      out.push(...Object.keys(v as Record<string, unknown>).map((sub) => `${full}.${sub}`));
    } else {
      out.push(full);
    }
  }
  return out;
}

// Un punto por día sobre dos años son 700 puntos ilegibles. Por mes son 24.
// Cuál corresponde depende de la pregunta, así que lo elige quien la hace.
function fechaEn(value: unknown, bucket: Bucket): string | null {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, bucket === "month" ? 7 : 10);
}

export type ChartRequest = {
  source: string;
  group_by: string;
  type?: ChartType;
  title?: string;
  bucket?: Bucket;
  from?: string;
  to?: string;
};

export async function buildChart(session: McpSession, req: ChartRequest): Promise<ChartData> {
  if (!req?.source || !req?.group_by) throw new Error("Faltan 'source' y/o 'group_by'.");

  // Solo tools de listado: son las únicas que devuelven filas para agrupar.
  // Las count_* devuelven un escalar y no sirven acá.
  if (!req.source.startsWith("list_")) {
    throw new Error(
      `'source' tiene que ser una herramienta de listado (list_*), y "${req.source}" no lo es.`,
    );
  }

  const esFecha = /date|fecha|_at$/i.test(req.group_by);
  const bucket: Bucket = req.bucket === "month" ? "month" : "day";
  const type: ChartType = req.type ?? (esFecha ? "line" : "bar");
  const title = req.title?.trim() || `${req.source.replace(/^list_/, "")} por ${req.group_by}`;

  const res = await callTool(session, req.source, {
    limit: ROW_LIMIT,
    ...(req.from ? { from: req.from } : {}),
    ...(req.to ? { to: req.to } : {}),
  });

  // Un error de la tool llega como texto, no como excepción: puede ser que el
  // MCP esté caído, que el token no sirva, o que la tool esté fuera de
  // CHAT_ALLOWED_TOOLS. Vale la pena distinguirlo de "no hay datos".
  if (res.isError) throw new Error(res.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error(`${req.source} devolvió algo que no es JSON.`);
  }

  const body = parsed as { data?: unknown[]; total?: number };
  const rows = Array.isArray(parsed) ? parsed : (body.data ?? []);
  if (!Array.isArray(rows)) throw new Error(`${req.source} no devolvió una lista.`);

  const total = typeof body.total === "number" ? body.total : rows.length;

  const tally = new Map<string, number>();
  let missing = 0;
  let objectValued = false;

  for (const row of rows as Array<Record<string, unknown>>) {
    const raw = valueAt(row, req.group_by);
    if (raw === undefined || raw === null || raw === "") {
      missing++;
      continue;
    }
    // Agrupar por un campo que es un objeto daría String(objeto) =
    // "[object Object]" para todas las filas: un gráfico de una sola barra, sin
    // error y sin sentido. Hay que agrupar por algo de adentro.
    if (typeof raw === "object") {
      objectValued = true;
      missing++;
      continue;
    }
    const key = esFecha ? fechaEn(raw, bucket) : String(raw);
    if (key === null) {
      missing++;
      continue;
    }
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  // Que ninguna fila agrupe no es "no hay datos": o el campo no existe, o es un
  // objeto. Devolver un gráfico vacío se leería como "no pasó nada", que es
  // mentira. Los dos errores nombran las rutas disponibles para que el modelo
  // se corrija solo, sin que haya que mantener un catálogo de campos por
  // entidad.
  if (rows.length > 0 && tally.size === 0) {
    const sample = (rows[0] ?? {}) as Record<string, unknown>;
    if (objectValued) {
      const head = req.group_by.split(".")[0]!;
      throw new Error(
        `"${req.group_by}" es un objeto, no se puede agrupar por ahí. ` +
          `Probá con una de estas rutas: ${paths(sample[head], head).join(", ")}.`,
      );
    }
    throw new Error(
      `Ninguna de las ${rows.length} filas de ${req.source} tiene el campo "${req.group_by}". ` +
        `Los campos disponibles son: ${paths(sample).join(", ")}.`,
    );
  }

  const entries = [...tally.entries()].sort(
    esFecha
      ? (a, b) => a[0].localeCompare(b[0])   // cronológico
      : (a, b) => b[1] - a[1],              // de mayor a menor
  );

  return {
    source: req.source,
    group_by: req.group_by,
    type,
    title,
    ...(esFecha ? { bucket } : {}),
    from: req.from,
    to: req.to,
    labels: entries.map(([k]) => k),
    values: entries.map(([, v]) => v),
    counted: rows.length - missing,
    total,
    truncated: rows.length < total,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resumen del período
//
// La pregunta que casi todos tienen al abrir un panel no es "¿cuántas sesiones
// hay?" sino "¿venimos mejor o peor que antes?". Eso es un número contra otro
// número, no un gráfico.
//
// Y sale barato y exacto: count_* con from/to lo responde el backend con un
// entero. No hay que listar nada, así que no aparece el problema de la muestra
// truncada que sí tienen los gráficos.
// ─────────────────────────────────────────────────────────────────────────────

const METRICS = [
  { key: "sessions",     tool: "count_sessions",     label: "Sesiones" },
  { key: "videovisits",  tool: "count_videovisits",  label: "Videoconsultas" },
  { key: "attentions",   tool: "count_attentions",   label: "Atenciones" },
  { key: "appointments", tool: "count_appointments", label: "Turnos" },
  { key: "exams",        tool: "count_exams",        label: "Exámenes" },
] as const;

export type Metric = {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  error?: string;
};

export type Summary = {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  metrics: Metric[];
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function count(
  session: McpSession,
  tool: string,
  from: string,
  to: string,
): Promise<number> {
  const res = await callTool(session, tool, { from, to });
  if (res.isError) throw new Error(res.text);
  const parsed = JSON.parse(res.text) as { count?: number };
  if (typeof parsed.count !== "number") throw new Error(`${tool} no devolvió un count.`);
  return parsed.count;
}

export async function buildSummary(
  session: McpSession,
  from: string,
  to: string,
): Promise<Summary> {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Rango de fechas inválido.");
  }

  // El período anterior es uno del mismo largo, pegado atrás. Comparar contra
  // algo de otra duración daría una variación sin sentido.
  const span = end.getTime() - start.getTime();
  const prevTo = new Date(start.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - span);

  const metrics = await Promise.all(
    METRICS.map(async (m): Promise<Metric> => {
      try {
        const [value, previous] = await Promise.all([
          count(session, m.tool, from, to),
          count(session, m.tool, iso(prevFrom), iso(prevTo)),
        ]);
        return { key: m.key, label: m.label, value, previous };
      } catch (err) {
        // Una métrica que falla no debería vaciar el panel entero: puede estar
        // fuera de CHAT_ALLOWED_TOOLS, o no existir en otro MCP.
        return {
          key: m.key,
          label: m.label,
          value: null,
          previous: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return { from, to, prevFrom: iso(prevFrom), prevTo: iso(prevTo), metrics };
}

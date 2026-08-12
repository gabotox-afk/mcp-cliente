import { callTool, type McpSession } from "./mcp-client.ts";

// Gráficos predeterminados: un catálogo fijo que el usuario elige de una lista.
//
// No pasan por el modelo. Cada uno es una consulta al MCP más una agrupación,
// así que el resultado es determinista, instantáneo y no gasta tokens. Un
// gráfico que sale de un menú no tiene por qué costar plata.
//
// Esto vive en el chat y no en el MCP a propósito: dibujar es asunto del
// cliente, no del dato. El MCP expone números; qué se hace con ellos es
// decisión de quien los consume.

export type ChartType = "bar" | "doughnut" | "line";

type Spec = {
  id: string;
  title: string;
  type: ChartType;
  tool: string;
  /** Campo de cada fila por el que se agrupa. */
  field: string;
  /** Si es "day", agrupa fechas por día y ordena cronológicamente. */
  bucket?: "day";
};

// Los campos de abajo son los que devuelven las tools del MCP de Diagnostica.
// Si se apunta el chat a otro MCP, este catálogo hay que rehacerlo — es la
// única parte del chat que sabe algo concreto del dominio.
const CATALOG: Spec[] = [
  { id: "sessions_by_status",     title: "Sesiones por estado",   type: "doughnut", tool: "list_sessions",     field: "status" },
  { id: "sessions_by_type",       title: "Sesiones por tipo",     type: "bar",      tool: "list_sessions",     field: "type" },
  { id: "sessions_over_time",     title: "Sesiones por día",      type: "line",     tool: "list_sessions",     field: "date", bucket: "day" },
  { id: "appointments_by_status", title: "Turnos por estado",     type: "doughnut", tool: "list_appointments", field: "status" },
  { id: "attentions_by_status",   title: "Atenciones por estado", type: "doughnut", tool: "list_attentions",   field: "status" },
  { id: "exams_by_type",          title: "Exámenes por tipo",     type: "bar",      tool: "list_exams",        field: "exam_type" },
  { id: "videovisits_by_specialty", title: "Videoconsultas por especialidad", type: "doughnut", tool: "list_videovisits", field: "specialty" },
];

// Cuántas filas se piden para agrupar.
//
// El MCP no tiene group_by: no hay forma de pedirle "sesiones por estado", solo
// "dame las sesiones". Así que se traen las filas y se agrupan acá. Funciona
// para volúmenes acotados; contra un histórico grande no escala, y por eso cada
// gráfico avisa cuando se quedó corto (ver `truncated`).
//
// La solución de fondo es un group_by en el backend. Mientras tanto, esto.
const ROW_LIMIT = 1000;

export type ChartData = {
  id: string;
  title: string;
  type: ChartType;
  labels: string[];
  values: number[];
  /** Filas efectivamente agrupadas. */
  counted: number;
  /** Total que reporta el backend. Si es mayor que `counted`, el gráfico es una muestra. */
  total: number;
  truncated: boolean;
};

export function chartCatalog(): Array<Pick<Spec, "id" | "title" | "type">> {
  return CATALOG.map(({ id, title, type }) => ({ id, title, type }));
}

function dayOf(value: unknown): string | null {
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function buildChart(
  session: McpSession,
  id: string,
  range: { from?: string; to?: string } = {},
): Promise<ChartData> {
  const spec = CATALOG.find((c) => c.id === id);
  if (!spec) throw new Error(`No existe el gráfico "${id}".`);

  const res = await callTool(session, spec.tool, {
    limit: ROW_LIMIT,
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
  });

  // Un error de la tool llega como texto, no como excepción: puede ser que el
  // MCP esté caído, que el token no sirva, o que la tool esté fuera de
  // CHAT_ALLOWED_TOOLS. Vale la pena distinguirlo de "no hay datos".
  if (res.isError) throw new Error(res.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error(`${spec.tool} devolvió algo que no es JSON.`);
  }

  const body = parsed as { data?: unknown[]; total?: number };
  const rows = Array.isArray(parsed) ? parsed : (body.data ?? []);
  if (!Array.isArray(rows)) throw new Error(`${spec.tool} no devolvió una lista.`);

  const total = typeof body.total === "number" ? body.total : rows.length;

  const tally = new Map<string, number>();
  let missing = 0;

  for (const row of rows as Array<Record<string, unknown>>) {
    const raw = row?.[spec.field];
    if (raw === undefined || raw === null || raw === "") {
      missing++;
      continue;
    }
    const key = spec.bucket === "day" ? dayOf(raw) : String(raw);
    if (key === null) {
      missing++;
      continue;
    }
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  // Que ninguna fila tenga el campo no es "no hay datos": es que el backend
  // cambió de forma y este gráfico quedó viejo. Callarlo devolvería un gráfico
  // vacío, que se lee como "no pasó nada" y es mentira.
  if (rows.length > 0 && tally.size === 0) {
    throw new Error(
      `Ninguna de las ${rows.length} filas de ${spec.tool} tiene el campo "${spec.field}".`,
    );
  }

  const entries = [...tally.entries()].sort(
    spec.bucket === "day"
      ? (a, b) => a[0].localeCompare(b[0])   // cronológico
      : (a, b) => b[1] - a[1],              // de mayor a menor
  );

  return {
    id: spec.id,
    title: spec.title,
    type: spec.type,
    labels: entries.map(([k]) => k),
    values: entries.map(([, v]) => v),
    counted: rows.length - missing,
    total,
    truncated: rows.length < total,
  };
}

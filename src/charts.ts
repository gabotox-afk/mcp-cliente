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

// ─────────────────────────────────────────────────────────────────────────────
// Gráficos pedidos por el modelo durante la conversación.
//
// El modelo elige QUÉ graficar; los números los sigue trayendo el backend desde
// el MCP. Nunca pasa por su contexto un valor que después tenga que transcribir
// a la llamada — un número mal copiado produce un gráfico que se ve perfecto y
// es falso, y eso no hay forma de detectarlo mirándolo.
// ─────────────────────────────────────────────────────────────────────────────

export type ChartRequest = {
  source: string;
  group_by: string;
  type?: ChartType;
  title?: string;
  from?: string;
  to?: string;
};

export async function generateChart(
  session: McpSession,
  req: ChartRequest,
): Promise<ChartData> {
  if (!req?.source || !req?.group_by) {
    throw new Error("Faltan 'source' y/o 'group_by'.");
  }
  // Solo tools de listado: son las únicas que devuelven filas para agrupar.
  // Las count_* devuelven un escalar y no sirven acá.
  if (!req.source.startsWith("list_")) {
    throw new Error(
      `'source' tiene que ser una herramienta de listado (list_*), y "${req.source}" no lo es.`,
    );
  }

  const byDay = /date|fecha|_at$/i.test(req.group_by);

  return build(
    session,
    {
      id: `adhoc:${req.source}:${req.group_by}`,
      title: req.title?.trim() || `${req.source.replace(/^list_/, "")} por ${req.group_by}`,
      type: req.type ?? (byDay ? "line" : "bar"),
      tool: req.source,
      field: req.group_by,
      ...(byDay ? { bucket: "day" as const } : {}),
    },
    { from: req.from, to: req.to },
  );
}

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
  return build(session, spec, range);
}

// Motor único. Los gráficos predeterminados y los que pide el modelo pasan por
// acá: la diferencia entre unos y otros es solamente de dónde salen los
// parámetros, no cómo se construye el gráfico.
async function build(
  session: McpSession,
  spec: Spec,
  range: { from?: string; to?: string } = {},
): Promise<ChartData> {
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
  let objectValued = false;

  for (const row of rows as Array<Record<string, unknown>>) {
    const raw = valueAt(row, spec.field);
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
    const key = spec.bucket === "day" ? dayOf(raw) : String(raw);
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
      const inner = paths(sample[spec.field.split(".")[0]!], spec.field.split(".")[0]!);
      throw new Error(
        `"${spec.field}" es un objeto, no se puede agrupar por ahí. ` +
          `Probá con una de estas rutas: ${inner.join(", ")}.`,
      );
    }
    throw new Error(
      `Ninguna de las ${rows.length} filas de ${spec.tool} tiene el campo "${spec.field}". ` +
        `Los campos disponibles son: ${paths(sample).join(", ")}.`,
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ALLOWED_TOOLS, MCP_BASE_URL } from "./config.ts";

// Cliente MCP propio: el chat backend es el ÚNICO que habla con el MCP.
// Claude nunca se conecta al MCP — recibe definiciones de tools y resultados
// ya ejecutados. Eso es lo que permite que el MCP del cliente viva detrás de
// una VPN o una allowlist de IPs, y lo que nos deja auditar cada llamada.
//
// Nada de este archivo sabe qué tools existen ni qué hacen: las descubre con
// tools/list. Sirve para el MCP de Diagnostica o para cualquier otro.

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

// Forma que espera la API de Claude. La traducción es casi 1:1 — ambos usan
// JSON Schema; solo cambia el nombre del campo (inputSchema → input_schema).
export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
};

export type McpSession = {
  brandId: string;
  token: string;
};

// El token del usuario venció o dejó de ser válido.
//
// Se distingue de cualquier otro fallo porque la reacción es distinta: no hay
// nada que reintentar ni que explicarle al modelo, hay que pedirle al usuario
// que vuelva a entrar. Sin esta distinción, un token vencido llega al modelo
// como un resultado de error cualquiera y el modelo improvisa una respuesta
// —cara, y que no le dice al usuario lo único que necesita saber.
export class SessionExpiredError extends Error {
  constructor(message = "La sesión del usuario expiró.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

// El fallo de auth llega por dos caminos distintos, y hay que cubrir los dos.
//
// 1. El MCP rechaza la conexión (falta el header, por ejemplo). Ahí el
//    transporte lanza una excepción con el status HTTP en `code`.
function esFalloDeAuth(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 401 || code === 403;
}

// 2. El MCP acepta la request, se la pasa al backend de la empresa, y es el
//    BACKEND el que responde 401 — token vencido, típicamente. Ahí el MCP
//    devuelve un resultado de tool normal, con isError, y el status viaja
//    adentro del texto. No hay excepción y `code` nunca aparece.
//
//    Este es el caso real de una sesión que expira mientras alguien usa el
//    chat, así que es el que más importa.
//
//    Se busca el status con su palabra ("HTTP 401", "401 Unauthorized") y no un
//    "401" suelto: un resultado que traiga ese número entre los datos no debería
//    hacernos cerrar la sesión de nadie. Y solo se evalúa sobre resultados que
//    ya vinieron marcados como error.
const PATRON_AUTH = /\bHTTP (401|403)\b|\b401 Unauthorized\b|\b403 Forbidden\b/i;

function resultadoEsFalloDeAuth(res: { text: string; isError: boolean }): boolean {
  return res.isError && PATRON_AUTH.test(res.text);
}

function mcpUrlFor(brandId: string): URL {
  return new URL(`${MCP_BASE_URL}/${brandId}/mcp`);
}

// Abre una conexión, ejecuta `fn`, y cierra. Conexión por request en vez de
// pool: es inmune a que el MCP se reinicie (sus sesiones viven en memoria del
// proceso) y evita tener que manejar reconexión. Si más adelante la latencia
// molesta, acá es donde se introduce un pool.
async function withMcp<T>(session: McpSession, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(
    { name: "diagnostica-chat", version: "0.1.0" },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(mcpUrlFor(session.brandId), {
    // El JWT del usuario viaja tal cual al MCP. El MCP ya lo valida contra el
    // backend de la empresa, así que los permisos y la marca del usuario se
    // respetan sin que el chat tenga que saber nada de autorización.
    requestInit: {
      headers: { Authorization: `Bearer ${session.token}` },
    },
  });

  try {
    await client.connect(transport);
    return await fn(client);
  } catch (err) {
    if (esFalloDeAuth(err)) throw new SessionExpiredError();
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}

// Cache de tools/list. El catálogo de tools de un MCP cambia con un deploy,
// no entre requests, así que no tiene sentido pedirlo cada vez.
//
// OJO: la clave no incluye al usuario. Vale mientras el MCP exponga el mismo
// catálogo a todos (es el caso del nuestro: registra las 28 tools siempre, y
// recién al ejecutarlas valida el token). Un MCP que muestre distintas tools
// según el usuario necesitaría al usuario en la clave.
const toolCache = new Map<string, { tools: AnthropicTool[]; at: number }>();
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

// Se cachea el catálogo completo y se filtra al leer: así el cache representa
// lo que el MCP ofrece, no lo que nosotros dejamos pasar.
function applyWhitelist(tools: AnthropicTool[]): AnthropicTool[] {
  if (ALLOWED_TOOLS.size === 0) return tools;
  return tools.filter((t) => ALLOWED_TOOLS.has(t.name));
}

// Una whitelist con nombres que el MCP ya no expone se degrada en silencio: la
// tool simplemente no aparece y el modelo responde peor sin que nadie se
// entere. Avisamos una vez por catálogo.
const warnedFor = new Set<string>();
function warnUnknownNames(key: string, tools: AnthropicTool[]): void {
  if (ALLOWED_TOOLS.size === 0 || warnedFor.has(key)) return;
  warnedFor.add(key);

  const available = new Set(tools.map((t) => t.name));
  const missing = [...ALLOWED_TOOLS].filter((n) => !available.has(n));
  if (missing.length > 0) {
    console.warn(
      `[mcp] CHAT_ALLOWED_TOOLS nombra ${missing.length} tool(s) que el MCP no expone: ${missing.join(", ")}`,
    );
  }
}

export async function listTools(session: McpSession): Promise<AnthropicTool[]> {
  const key = `${MCP_BASE_URL}|${session.brandId}`;
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.at < TOOL_CACHE_TTL_MS) return applyWhitelist(hit.tools);

  const tools = await withMcp(session, async (client) => {
    const res = await client.listTools();
    return res.tools.map((t): AnthropicTool => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: {
        ...(t.inputSchema as Record<string, unknown> | undefined),
        type: "object",
      },
    }));
  });

  toolCache.set(key, { tools, at: Date.now() });
  warnUnknownNames(key, tools);
  return applyWhitelist(tools);
}

export type ToolCallResult = {
  text: string;
  isError: boolean;
};

// Ejecuta una tool contra el MCP y devuelve el resultado como texto plano,
// que es lo que la API de Claude espera en un tool_result.
export async function callTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  // La whitelist se aplica también acá, no solo al armar el catálogo. El modelo
  // puede pedir una tool que no le ofrecimos: por alucinación, o porque el
  // catálogo cambió a mitad de conversación y el historial todavía la menciona.
  // Filtrar solo en listTools sería una restricción sugerida, no aplicada.
  if (ALLOWED_TOOLS.size > 0 && !ALLOWED_TOOLS.has(name)) {
    return { text: `La herramienta "${name}" no está habilitada en este chat.`, isError: true };
  }

  try {
    return await withMcp(session, async (client) => {
      const res = await client.callTool({ name, arguments: args });

      const blocks = Array.isArray(res.content) ? res.content : [];
      const text = blocks
        .map((b: any) => (b?.type === "text" ? b.text : JSON.stringify(b)))
        .join("\n");

      const resultado = { text: text || "(sin contenido)", isError: Boolean(res.isError) };
      if (resultadoEsFalloDeAuth(resultado)) throw new SessionExpiredError();
      return resultado;
    });
  } catch (err) {
    // La sesión vencida sí tumba la conversación, a propósito: es la única
    // excepción que se propaga en vez de volver como resultado de error.
    //
    // Se chequean las dos formas: withMcp ya la convirtió si el fallo fue de la
    // conexión, pero un 401 que aparezca recién al ejecutar la tool llega crudo.
    if (err instanceof SessionExpiredError) throw err;
    if (esFalloDeAuth(err)) throw new SessionExpiredError();

    // El resto de los fallos no deben tumbarla: se le devuelven al modelo como
    // resultado de error para que pueda reaccionar.
    return {
      text: `Error al ejecutar ${name}: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

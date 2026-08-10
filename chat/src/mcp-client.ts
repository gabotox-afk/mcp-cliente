import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_BASE_URL } from "./config.ts";

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

  await client.connect(transport);
  try {
    return await fn(client);
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

export async function listTools(session: McpSession): Promise<AnthropicTool[]> {
  const key = `${MCP_BASE_URL}|${session.brandId}`;
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.at < TOOL_CACHE_TTL_MS) return hit.tools;

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
  return tools;
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
  try {
    return await withMcp(session, async (client) => {
      const res = await client.callTool({ name, arguments: args });

      const blocks = Array.isArray(res.content) ? res.content : [];
      const text = blocks
        .map((b: any) => (b?.type === "text" ? b.text : JSON.stringify(b)))
        .join("\n");

      return { text: text || "(sin contenido)", isError: Boolean(res.isError) };
    });
  } catch (err) {
    // Un fallo de tool no debe tumbar la conversación: se lo devolvemos al
    // modelo como resultado de error para que pueda reaccionar.
    return {
      text: `Error al ejecutar ${name}: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_HTTP_URL = process.env.MCP_HTTP_URL ?? "http://localhost:3000";

// Cada request abre y cierra su propia sesion MCP, autenticada con el token del
// usuario logueado en la pagina de Diagnostica (recibido via postMessage por el widget).
// mcp-diagnostica/src/http.ts ya crea un McpServer nuevo por sesion, cerrado sobre ese
// token exacto -- no hay credencial de servicio ni estado compartido entre usuarios.
export async function withMcpClient<T>(
  token: string,
  brandId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_HTTP_URL}/${brandId}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "diagnostica-widget", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

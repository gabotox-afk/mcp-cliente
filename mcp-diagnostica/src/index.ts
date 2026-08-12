import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getCachedToken, startAuthFlowInBackground } from "./auth.ts";
import { registerAnalyticsTools } from "./tools/analytics.ts";

// Intenta cargar token cacheado sin bloquear
const cached = await getCachedToken();
if (cached) {
  process.env.BACKEND_TOKEN = cached;
} else {
  // Inicia OAuth en background — el MCP arranca igual y avisa al usuario cuando usa una tool
  startAuthFlowInBackground();
}

const server = new McpServer({
  name: "mcp-diagnostica",
  version: "0.1.0",
});

registerAnalyticsTools(server, () => process.env.BACKEND_TOKEN ?? "", () => process.env.BRAND_ID ?? "");

const transport = new StdioServerTransport();
await server.connect(transport);

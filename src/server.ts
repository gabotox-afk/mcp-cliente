import { join } from "path";
import { runAgent, type ChatEvent, type ChatMessage } from "./agent.ts";
import { PORT, MCP_BASE_URL, DEMO_BACKEND_URL, DEMO_BRAND_ID, AGENT_MODE, MODEL } from "./config.ts";

// Backend del chat. Es la única pieza que hospedamos nosotros y la única que
// tiene la API key de Anthropic — por eso el chat no puede ser solo frontend.
//
// Flujo por mensaje:
//   navegador --(JWT del usuario)--> este server --(mismo JWT)--> MCP
//                                          |
//                                          +--> Claude (tools + resultados)

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

// En producción esto tiene que ser una allowlist de los dominios donde se
// embebe el chat, no "*".
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 120, // el loop de tools puede tardar; que no lo corte el server

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // ── Config pública ───────────────────────────────────────────────────────
    // El bloque `demo` le dice a la página de prueba dónde está el backend de
    // la empresa, para que haga el login contra él directamente. En producción
    // la página ya conoce su propio backend y este bloque no existe.
    //
    // Este backend NO tiene endpoint de login a propósito: nunca debe recibir
    // contraseñas, solo tokens ya emitidos. Ver el README.
    if (url.pathname === "/config") {
      return json({
        agentMode: AGENT_MODE,
        model: MODEL,
        mcp: MCP_BASE_URL,
        demo: { backendUrl: DEMO_BACKEND_URL, brandId: DEMO_BRAND_ID },
      });
    }

    // ── Chat ─────────────────────────────────────────────────────────────────
    if (url.pathname === "/chat" && req.method === "POST") {
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token) return json({ error: "Falta el token del usuario." }, 401);

      const body = (await req.json()) as { brandId?: string; messages?: ChatMessage[] };
      const brandId = body.brandId;
      const messages = body.messages ?? [];

      if (!brandId) return json({ error: "Falta brandId." }, 400);
      if (messages.length === 0) return json({ error: "No hay mensajes." }, 400);

      // SSE por POST: EventSource solo hace GET, así que del lado del front se
      // consume con fetch() y un reader del body.
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (e: ChatEvent) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
            } catch {
              // El cliente cerró la pestaña a mitad de camino.
            }
          };

          await runAgent({ brandId, token }, messages, emit);
          try {
            controller.close();
          } catch {}
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...CORS,
        },
      });
    }

    // ── Página demo ──────────────────────────────────────────────────────────
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(PUBLIC_DIR, path));
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
});

process.stderr.write(`[chat] escuchando en http://localhost:${PORT}\n`);
process.stderr.write(`[chat] MCP: ${MCP_BASE_URL}\n`);
process.stderr.write(`[chat] agente: ${AGENT_MODE}${AGENT_MODE === "real" ? ` (${MODEL})` : " — sin API key, no interpreta"}\n`);

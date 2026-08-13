import { join } from "path";
import { runAgent, type ChatEvent, type ChatMessage } from "./agent.ts";
import { buildChart, buildSummary } from "./charts.ts";
import { checkRateLimit } from "./rate-limit.ts";
import { PORT, MCP_BASE_URL, DEMO_BACKEND_URL, DEMO_BRAND_ID, AGENT_MODE, MODEL, ALLOWED_ORIGINS } from "./config.ts";

// Backend del chat. Es la única pieza que hospedamos nosotros y la única que
// tiene la API key de Anthropic — por eso el chat no puede ser solo frontend.
//
// Flujo por mensaje:
//   navegador --(JWT del usuario)--> este server --(mismo JWT)--> MCP
//                                          |
//                                          +--> Claude (tools + resultados)

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

// Con CHAT_ALLOWED_ORIGINS seteado se devuelve el origen que pidió, si está en
// la lista. Sin la variable cae a "*", que sirve para desarrollo y no para
// producción.
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const permitido =
    ALLOWED_ORIGINS.length === 0 ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...(ALLOWED_ORIGINS.length > 0 ? { Vary: "Origin" } : {}),
  };
}

function bearer(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function jsonFor(req: Request) {
  return (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...corsFor(req) },
    });
}

// 429 con Retry-After, que es lo que un cliente necesita para reintentar bien.
function tooMany(req: Request, retryAfter: number) {
  return new Response(
    JSON.stringify({ error: `Demasiadas consultas. Probá de nuevo en ${retryAfter} segundos.` }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        ...corsFor(req),
      },
    },
  );
}

Bun.serve({
  port: PORT,
  idleTimeout: 120, // el loop de tools puede tardar; que no lo corte el server

  async fetch(req) {
    const url = new URL(req.url);
    const json = jsonFor(req);

    if (req.method === "OPTIONS") return new Response(null, { headers: corsFor(req) });

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
        // El widget usa esto para descartar mensajes de orígenes ajenos.
        allowedOrigins: ALLOWED_ORIGINS,
        demo: { backendUrl: DEMO_BACKEND_URL, brandId: DEMO_BRAND_ID },
      });
    }

    // Chart.js servido desde node_modules, no desde un CDN. El chat va embebido
    // en el producto de una empresa, que puede estar detrás de un firewall sin
    // salida a internet; y una dependencia de dibujo no debería ser un pedido a
    // un tercero en cada carga. Se maneja por package.json como cualquier otra.
    if (url.pathname === "/vendor/chart.umd.js") {
      const file = Bun.file(join(import.meta.dir, "..", "node_modules", "chart.js", "dist", "chart.umd.js"));
      if (!(await file.exists())) return new Response("Falta chart.js — corré bun install", { status: 500 });
      return new Response(file, {
        headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=86400" },
      });
    }

    // ── Gráficos y resumen ───────────────────────────────────────────────────
    // Los dos piden el token del usuario: salen de las mismas tools del MCP y
    // respetan los mismos permisos que el chat.

    // Rearmar un gráfico con otros parámetros. Es lo que usa el front cuando el
    // usuario cambia el período o el tipo de un gráfico ya dibujado, sin tener
    // que volver a pasar por el modelo.
    if (url.pathname === "/chart" && req.method === "POST") {
      const token = bearer(req);
      if (!token) return json({ error: "Falta el token del usuario." }, 401);

      const rl = checkRateLimit("datos", token);
      if (!rl.allowed) return tooMany(req, rl.retryAfter ?? 60);

      const body = (await req.json().catch(() => ({}))) as Record<string, string | undefined>;
      if (!body.brandId) return json({ error: "Falta brandId." }, 400);

      try {
        const { brandId, ...spec } = body;
        return json(await buildChart({ brandId, token }, spec as never));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    }

    if (url.pathname === "/summary" && req.method === "POST") {
      const token = bearer(req);
      if (!token) return json({ error: "Falta el token del usuario." }, 401);

      const rl = checkRateLimit("datos", token);
      if (!rl.allowed) return tooMany(req, rl.retryAfter ?? 60);

      const body = (await req.json().catch(() => ({}))) as {
        brandId?: string; from?: string; to?: string;
      };
      if (!body.brandId) return json({ error: "Falta brandId." }, 400);
      if (!body.from || !body.to) return json({ error: "Faltan 'from' y 'to'." }, 400);

      try {
        return json(await buildSummary({ brandId: body.brandId, token }, body.from, body.to));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    }

    // ── Chat ─────────────────────────────────────────────────────────────────
    if (url.pathname === "/chat" && req.method === "POST") {
      const token = bearer(req);
      if (!token) return json({ error: "Falta el token del usuario." }, 401);

      // Este es el carril caro: cada mensaje es una llamada paga a la API.
      const rl = checkRateLimit("chat", token);
      if (!rl.allowed) return tooMany(req, rl.retryAfter ?? 60);

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
          ...corsFor(req),
        },
      });
    }

    // ── Widget embebible ─────────────────────────────────────────────────────
    // Es lo que va dentro del <iframe> en la página de la empresa. El
    // frame-ancestors dice quién tiene permitido embeberlo: sin eso, cualquier
    // sitio puede montar el widget y quedarse esperando un token.
    if (url.pathname === "/widget") {
      const file = Bun.file(join(PUBLIC_DIR, "widget.html"));
      const ancestors = ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(" ") : "*";
      return new Response(file, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `frame-ancestors 'self' ${ancestors}`,
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

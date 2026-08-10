import { createHash, randomBytes } from "crypto";
import { runChat, getDashboardCharts, type ChatMessage } from "./agent.ts";

const PORT             = parseInt(process.env.PORT ?? "5000");
const MOCK_SERVER_URL  = process.env.MOCK_SERVER_URL ?? "http://localhost:4000";
const DEFAULT_BRAND_ID = process.env.DEFAULT_BRAND_ID ?? "diagnostica";

const DEMO_HOST_HTML = await Bun.file(new URL("../public/demo-host.html", import.meta.url)).text();
const WIDGET_HTML     = await Bun.file(new URL("../public/widget.html", import.meta.url)).text();

function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" && req.method === "GET") {
      return new Response(DEMO_HOST_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (pathname === "/widget" && req.method === "GET") {
      return new Response(WIDGET_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Simula que el usuario ya está logueado en la página real de Diagnostica.
    // En la integración real esto no existe: la página host ya tiene el token
    // y se lo pasa al iframe por postMessage.
    if (pathname === "/demo-login" && req.method === "POST") {
      const { email, password } = (await req.json()) as { email: string; password: string };

      const codeVerifier  = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const redirectUri   = "http://localhost:4242/callback";

      const loginRes = await fetch(
        `${MOCK_SERVER_URL}/oauth/login?client_id=mcp-diagnostica&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) },
      );
      const loginData = (await loginRes.json()) as { redirect?: string; error?: string };
      if (!loginData.redirect) {
        return Response.json({ error: loginData.error ?? "Credenciales inválidas." }, { status: 401 });
      }
      const code = new URL(loginData.redirect).searchParams.get("code");

      const tokenRes = await fetch(`${MOCK_SERVER_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: "mcp-diagnostica",
          client_secret: "mcp-secret-123",
          code_verifier: codeVerifier,
        }),
      });
      const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokenData.access_token) {
        return Response.json({ error: tokenData.error ?? "No se pudo obtener el token." }, { status: 401 });
      }

      return Response.json({ token: tokenData.access_token, brandId: DEFAULT_BRAND_ID });
    }

    if (pathname === "/chat" && req.method === "POST") {
      const token = extractToken(req);
      if (!token) return Response.json({ error: "Falta el token del usuario." }, { status: 401 });
      const brandId = req.headers.get("x-brand-id") ?? DEFAULT_BRAND_ID;

      const { messages } = (await req.json()) as { messages: ChatMessage[] };
      try {
        const reply = await runChat(token, brandId, messages);
        return Response.json({ reply });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
      }
    }

    if (pathname === "/dashboard-charts" && req.method === "GET") {
      const token = extractToken(req);
      if (!token) return Response.json({ error: "Falta el token del usuario." }, { status: 401 });
      const brandId = req.headers.get("x-brand-id") ?? DEFAULT_BRAND_ID;

      try {
        const charts = await getDashboardCharts(token, brandId);
        return Response.json({ charts });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`diagnostica-widget corriendo en http://localhost:${PORT}`);

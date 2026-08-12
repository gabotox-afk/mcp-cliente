import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHash, randomUUID } from "crypto";
import { redis } from "bun";

import { registerAnalyticsTools } from "./tools/analytics.ts";

const PORT       = parseInt(process.env.PORT ?? "3000");
const PUBLIC_URL = process.env.PUBLIC_URL   ?? `http://localhost:${PORT}`;

if (!process.env.PUBLIC_URL) {
  process.stderr.write(
    "[mcp-diagnostica] ADVERTENCIA: PUBLIC_URL no está seteada, usando " +
      `${PUBLIC_URL}. Los endpoints de discovery OAuth van a anunciar esta URL ` +
      "a clientes externos — en un deploy real hay que setearla explícitamente.\n",
  );
}

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4000";

// El backend real no tiene servidor OAuth propio (no expone /oauth/authorize ni
// /oauth/token en ninguna rama, incluida la rama "mcp-server" pensada para este
// integración). Solo expone POST /users/login (email+password+brandId → JWT) y
// POST /users/multi_refresh_token. Este servidor actúa como wrapper OAuth: valida
// credenciales contra ese login real y emite los authorization codes/tokens él mismo.
//
// Todo (discovery, authorize, login, token y el propio endpoint MCP) vive bajo
// /:brand_id/..., para que el brandId salga siempre del link que se le da al
// cliente (ej: https://mcp.tudominio.com/<brandId real de Mongo>/mcp) y no haga
// falta pedirlo de nuevo en el form de login. Es un solo backend (BACKEND_URL);
// brand_id es el ObjectId real de la marca, se pasa tal cual a /users/login.

// Transports MCP vivos (una conexión streamable-HTTP en curso). Son objetos en
// proceso, no datos — no se pueden mover a Redis. Si este server corre en más
// de una réplica, el load balancer TIENE que enrutar todas las requests de un
// mismo mcp-session-id a la misma réplica (sticky sessions/session affinity);
// de lo contrario una request puede llegarle a una réplica que nunca creó esa
// sesión y fallar con 404 más abajo.
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

// Clientes registrados vía DCR (RFC 7591) y códigos de autorización: viven en
// Redis (no en memoria) para que cualquier réplica pueda validarlos — con
// varias réplicas detrás de un load balancer, el registro puede caer en una y
// el login/token-exchange en otra.
//
// Son "public clients" (no pueden guardar un secret de forma segura — corren
// en la laptop del usuario), así que no emitimos client_secret: la seguridad
// del intercambio de código la da PKCE (code_challenge/code_verifier), no un
// secret compartido. Lo que sí hace falta es recordar qué redirect_uris
// declaró cada client_id, para no redirigir el resultado del login a una URL
// que el cliente nunca registró (si no se valida esto, cualquiera podría
// armar un link de /oauth/authorize con su propio redirect_uri, mandárselo a
// una víctima, y robarse el token cuando la víctima loguea con sus
// credenciales reales).

type RegisteredClient = { redirect_uris: string[] };

type OAuthCodeEntry = {
  client_id:      string;
  redirect_uri:   string;
  code_challenge: string;
  access_token:   string;
  refresh_token:  string;
  expires:        number;
};

const OAUTH_CODE_TTL_SECONDS = 5 * 60;

async function setRegisteredClient(clientId: string, data: RegisteredClient): Promise<void> {
  await redis.set(`oauth:client:${clientId}`, JSON.stringify(data));
}

async function getRegisteredClient(clientId: string): Promise<RegisteredClient | null> {
  if (!clientId) return null;
  const raw = await redis.get(`oauth:client:${clientId}`);
  return raw ? JSON.parse(raw) as RegisteredClient : null;
}

async function setOAuthCode(code: string, entry: OAuthCodeEntry): Promise<void> {
  await redis.set(`oauth:code:${code}`, JSON.stringify(entry), "EX", OAUTH_CODE_TTL_SECONDS);
}

// GETDEL es atómico: garantiza que el código se pueda canjear una sola vez
// incluso si dos requests concurrentes (en la misma o distinta réplica)
// intentan canjearlo al mismo tiempo.
async function takeOAuthCode(code: string): Promise<OAuthCodeEntry | null> {
  if (!code) return null;
  const raw = await redis.getdel(`oauth:code:${code}`);
  return raw ? JSON.parse(raw) as OAuthCodeEntry : null;
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

function unauthorized(brand_id: string) {
  return new Response(JSON.stringify({ error: "Authorization: Bearer <token> requerido" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="${PUBLIC_URL}", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/${brand_id}/mcp"`,
    },
  });
}

function verifyPKCE(verifier: string, challenge: string): boolean {
  const hash = createHash("sha256").update(verifier).digest();
  const encoded = hash.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return encoded === challenge;
}

// Best-effort: lee el "exp" del JWT del backend para calcular expires_in.
// Si no se puede decodificar, usa un fallback conservador.
function jwtExpiresIn(token: string, fallbackSeconds = 3600): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8"));
    if (typeof payload.exp === "number") {
      return Math.max(payload.exp - Math.floor(Date.now() / 1000), 0);
    }
  } catch {}
  return fallbackSeconds;
}

// Diseño "pulido" (el de la vieja SPA de React, frontend/App.tsx + App.css)
// embebido directo acá como un único string — sin carpeta aparte, sin build
// step. La lógica de submit (fetch a /oauth/login con querystring + body
// JSON) es la misma que ya tenía main; solo cambió el markup/CSS.
function loginHtml(brand_id: string, params: { client_id: string; redirect_uri: string; state: string; code_challenge: string }, error?: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP Diagnostica — Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --navy: #313a5c;
      --navy-hover: #262e4a;
      --navy-light: #47517a;
      --panel: #1a2140;
      --panel-light: #2a3358;
    }

    html, body { font-family: system-ui, -apple-system, sans-serif; height: 100%; }

    .page { min-height: 100vh; display: flex; }

    /* --- Panel izquierdo, oscuro --- */

    .side {
      flex: 0 0 42%;
      background: var(--panel);
      color: white;
      padding: 3rem 2.75rem;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2.75rem;
      position: relative;
      overflow: hidden;
    }

    .side::before {
      content: "";
      position: absolute;
      width: 420px;
      height: 420px;
      border-radius: 50%;
      background: var(--panel-light);
      opacity: .35;
      top: -180px;
      right: -180px;
    }

    .side-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.2rem;
      font-weight: 700;
      z-index: 1;
      position: absolute;
      top: 3rem;
      left: 2.75rem;
    }

    .side-brand .dot { width: 9px; height: 9px; border-radius: 50%; background: #7c86b8; }

    .side-content { display: flex; flex-direction: column; gap: 2.5rem; z-index: 1; }

    .side-headline { font-size: 2.6rem; font-weight: 700; line-height: 1.2; max-width: 420px; }

    .side-permissions { z-index: 1; }

    .side-permissions-title {
      font-size: .8rem; font-weight: 600; color: #9aa3cc;
      text-transform: uppercase; letter-spacing: .05em; margin-bottom: 1rem;
    }

    .side-permissions ul { list-style: none; display: flex; flex-direction: column; gap: .8rem; }

    .side-permissions li {
      display: flex; align-items: flex-start; gap: .6rem;
      font-size: 1rem; color: #cbd2f0; line-height: 1.5;
    }

    .side-permissions li .check { color: #8791c4; font-weight: 700; flex-shrink: 0; }

    /* --- Panel derecho, formulario --- */

    .form-panel {
      flex: 1; background: #f8fafc;
      display: flex; align-items: center; justify-content: center;
      padding: 2rem;
    }

    .form-wrap { width: 100%; max-width: 400px; }

    .form-wrap h1 { font-size: 1.75rem; font-weight: 700; color: #1e293b; margin-bottom: .4rem; }

    .form-wrap .subtitle { font-size: 1rem; color: #94a3b8; margin-bottom: 2.25rem; }

    label {
      display: block; font-size: .88rem; font-weight: 500; color: #475569;
      margin-bottom: .35rem; margin-top: 1.25rem;
    }

    input {
      width: 100%; padding: .8rem .95rem; border: 1.5px solid #e2e8f0;
      border-radius: 9px; font-size: 1rem; color: #1e293b; background: white;
      transition: border-color .15s; outline: none;
    }

    input:focus { border-color: var(--navy-light); }
    input.err   { border-color: #f87171; }

    button {
      margin-top: 1.85rem; width: 100%; padding: .9rem;
      background: var(--navy); color: white; border: none;
      border-radius: 999px; font-size: 1rem; font-weight: 600;
      cursor: pointer; transition: background .15s;
    }

    button:hover    { background: var(--navy-hover); }
    button:disabled { background: #94a3b8; cursor: not-allowed; }

    .msg { margin-top: 1.1rem; padding: .75rem .9rem; border-radius: 8px; font-size: .9rem; line-height: 1.45; display: none; }
    .msg.err { background: #fee2e2; color: #991b1b; display: block; }

    .security-note { text-align: center; margin-top: 1.5rem; font-size: .8rem; color: #94a3b8; }

    @media (max-width: 760px) {
      .page { flex-direction: column; }
      .side { flex: none; padding: 2.5rem 1.75rem 2rem; justify-content: flex-start; gap: 1.75rem; }
      .side-brand { position: static; }
      .side-headline { font-size: 1.85rem; }
      .form-panel { padding: 2rem 1.5rem 3rem; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="side">
      <div class="side-brand">
        <span class="dot"></span>
        Diagnóstica MCP
      </div>

      <div class="side-content">
        <h1 class="side-headline">Conectá tu asistente de IA a tu ecosistema de datos clínicos</h1>

        <div class="side-permissions">
          <div class="side-permissions-title">Este acceso permite</div>
          <ul>
            <li><span class="check">✓</span> Consultar analytics de pacientes, sesiones, turnos y exámenes</li>
            <li><span class="check">✓</span> No accede a nombres ni datos personales de pacientes</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="form-panel">
      <div class="form-wrap">
        <h1>Iniciá sesión</h1>
        <div class="subtitle">para autorizar la conexión</div>

        <form id="form">
          <label for="email">Email</label>
          <input id="email" type="email" name="email" required autocomplete="email" placeholder="usuario@diagnostica.com.ar">
          <label for="password">Contraseña</label>
          <input id="password" type="password" name="password" required autocomplete="current-password" placeholder="••••••••">
          <div id="msg" class="msg${error ? " err" : ""}">${error ?? ""}</div>
          <button type="submit" id="btn">Autorizar</button>
        </form>

        <div class="security-note">Conexión cifrada</div>
      </div>
    </div>
  </div>
  <script>
    const form = document.getElementById('form');
    const btn  = document.getElementById('btn');
    const msg  = document.getElementById('msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Iniciando sesión...';
      msg.className = 'msg';
      try {
        const res  = await fetch('/${brand_id}/oauth/login?${new URLSearchParams(params).toString()}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: form.email.value, password: form.password.value }),
        });
        const data = await res.json();
        if (data.redirect) {
          window.location.href = data.redirect;
        } else {
          msg.className = 'msg err';
          msg.textContent = data.error || 'Credenciales inválidas.';
          btn.disabled = false;
          btn.textContent = 'Autorizar';
        }
      } catch {
        msg.className = 'msg err';
        msg.textContent = 'Error de red.';
        btn.disabled = false;
        btn.textContent = 'Autorizar';
      }
    });
  </script>
</body>
</html>`;
}

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url   = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // ── OAuth Discovery (RFC 8414 / RFC 9728) ─────────────────────────────────
    // Cuando el issuer o el resource tienen un path (ej. /diagnostica), el sufijo
    // well-known va ENTRE el host y ese path, no después — así arman la URL los
    // clientes OAuth (claude.ai incluido):
    //   /.well-known/oauth-protected-resource/{brand_id}/mcp
    //   /.well-known/oauth-authorization-server/{brand_id}

    if (parts[0] === ".well-known" && parts[1] === "oauth-protected-resource") {
      const brand_id = parts[2] ?? "";
      if (!brand_id || parts[3] !== "mcp") return new Response("Not found", { status: 404 });

      const base = `${PUBLIC_URL}/${brand_id}`;
      return Response.json({
        resource:               `${base}/mcp`,
        authorization_servers: [base],
      });
    }

    if (parts[0] === ".well-known" && parts[1] === "oauth-authorization-server") {
      const brand_id = parts[2] ?? "";
      if (!brand_id) return new Response("Not found", { status: 404 });

      const base = `${PUBLIC_URL}/${brand_id}`;
      return Response.json({
        issuer:                              base,
        authorization_endpoint:             `${base}/oauth/authorize`,
        token_endpoint:                      `${base}/oauth/token`,
        registration_endpoint:              `${base}/oauth/register`,
        response_types_supported:           ["code"],
        grant_types_supported:              ["authorization_code", "refresh_token"],
        code_challenge_methods_supported:   ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }

    // Todo lo demás cuelga de /:brand_id/... — el brandId sale del link, nunca del form.
    // brand_id es el ObjectId real de la marca en el backend (un solo backend, BACKEND_URL).
    const brand_id = parts[0] ?? "";
    if (!brand_id) return new Response("Brand id requerido en la URL.", { status: 404 });

    const subpath = "/" + parts.slice(1).join("/");
    const base    = `${PUBLIC_URL}/${brand_id}`;

    // Mismos endpoints de discovery, también accesibles bajo /{brand_id}/.well-known/...
    // por si algún cliente usa esa otra convención en vez de la de arriba.

    if (subpath === "/.well-known/oauth-protected-resource") {
      return Response.json({
        resource:               `${base}/mcp`,
        authorization_servers: [base],
      });
    }

    if (subpath === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer:                              base,
        authorization_endpoint:             `${base}/oauth/authorize`,
        token_endpoint:                      `${base}/oauth/token`,
        registration_endpoint:              `${base}/oauth/register`,
        response_types_supported:           ["code"],
        grant_types_supported:              ["authorization_code", "refresh_token"],
        code_challenge_methods_supported:   ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }

    // ── Dynamic Client Registration (RFC 7591) ────────────────────────────────
    // Claude Code intenta registrarse como cliente OAuth automáticamente

    if (subpath === "/oauth/register" && req.method === "POST") {
      const body = await req.json() as Record<string, unknown>;

      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
      if (redirectUris.length === 0) {
        return Response.json({ error: "invalid_client_metadata", error_description: "redirect_uris requerido" }, { status: 400 });
      }
      for (const uri of redirectUris) {
        try {
          new URL(uri);
        } catch {
          return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
        }
      }

      const client_id = randomUUID();
      await setRegisteredClient(client_id, { redirect_uris: redirectUris });

      return Response.json({
        client_id,
        client_id_issued_at:        Math.floor(Date.now() / 1000),
        client_name:                body.client_name ?? "MCP Client",
        redirect_uris:              redirectUris,
        grant_types:                ["authorization_code", "refresh_token"],
        response_types:             ["code"],
        token_endpoint_auth_method: "none",
      }, { status: 201 });
    }

    // ── OAuth: login real contra el backend (wrapper) ─────────────────────────

    if (subpath === "/oauth/authorize" && req.method === "GET") {
      const client_id      = url.searchParams.get("client_id")      ?? "";
      const redirect_uri   = url.searchParams.get("redirect_uri")   ?? "";
      const state          = url.searchParams.get("state")          ?? "";
      const code_challenge = url.searchParams.get("code_challenge") ?? "";

      if (!redirect_uri || !code_challenge) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }

      // El redirect_uri tiene que ser uno de los que el cliente declaró en el
      // registro — si no, cualquiera podría armar este link con su propio
      // redirect_uri y robarse el token cuando la víctima loguee acá.
      const client = await getRegisteredClient(client_id);
      if (!client || !client.redirect_uris.includes(redirect_uri)) {
        return Response.json({ error: "invalid_client", error_description: "client_id o redirect_uri no registrados" }, { status: 400 });
      }

      return new Response(loginHtml(brand_id, { client_id, redirect_uri, state, code_challenge }), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (subpath === "/oauth/login" && req.method === "POST") {
      const client_id      = url.searchParams.get("client_id")      ?? "";
      const redirect_uri   = url.searchParams.get("redirect_uri")   ?? "";
      const state          = url.searchParams.get("state")          ?? "";
      const code_challenge = url.searchParams.get("code_challenge") ?? "";

      // Misma validación que en /oauth/authorize — este endpoint también es
      // alcanzable directamente, no solo vía el form que ahí se sirve.
      const client = await getRegisteredClient(client_id);
      if (!client || !client.redirect_uris.includes(redirect_uri)) {
        return Response.json({ error: "client_id o redirect_uri no registrados" }, { status: 400 });
      }

      const { email, password } = await req.json() as { email: string; password: string };

      const loginRes = await fetch(`${BACKEND_URL}/users/login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email, password, brandId: brand_id }),
      });
      const loginData = await loginRes.json() as { success: boolean; token?: string; refreshToken?: string; message?: string };

      if (!loginRes.ok || !loginData.success || !loginData.token || !loginData.refreshToken) {
        return Response.json({ error: loginData.message ?? "Credenciales inválidas." }, { status: 401 });
      }

      const code = randomUUID();
      await setOAuthCode(code, {
        client_id,
        redirect_uri,
        code_challenge,
        access_token:  loginData.token,
        refresh_token: loginData.refreshToken,
        expires:       Date.now() + 5 * 60 * 1000,
      });

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set("code", code);
      if (state) redirectUrl.searchParams.set("state", state);
      return Response.json({ redirect: redirectUrl.toString() });
    }

    if (subpath === "/oauth/token" && req.method === "POST") {
      const contentType = req.headers.get("content-type") ?? "";
      let params: Record<string, string> = {};
      if (contentType.includes("application/x-www-form-urlencoded")) {
        params = Object.fromEntries(new URLSearchParams(await req.text()));
      } else {
        params = await req.json().catch(() => ({}));
      }

      if (params.grant_type === "refresh_token") {
        if (!params.refresh_token) return Response.json({ error: "invalid_request" }, { status: 400 });

        const refreshRes = await fetch(`${BACKEND_URL}/users/multi_refresh_token`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ refreshToken: params.refresh_token }),
        });
        const refreshData = await refreshRes.json() as { success: boolean; token?: string; refreshToken?: string };

        if (!refreshRes.ok || !refreshData.success || !refreshData.token || !refreshData.refreshToken) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }

        return Response.json({
          access_token:  refreshData.token,
          refresh_token: refreshData.refreshToken,
          token_type:    "Bearer",
          expires_in:    jwtExpiresIn(refreshData.token),
        });
      }

      const { code, code_verifier, redirect_uri, client_id } = params;
      const entry = await takeOAuthCode(code);

      if (!entry || entry.expires < Date.now()) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (entry.redirect_uri !== redirect_uri) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (client_id && entry.client_id !== client_id) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (!code_verifier || !verifyPKCE(code_verifier, entry.code_challenge)) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      return Response.json({
        access_token:  entry.access_token,
        refresh_token: entry.refresh_token,
        token_type:    "Bearer",
        expires_in:    jwtExpiresIn(entry.access_token),
      });
    }

    // ── MCP endpoint (/:brand_id/mcp) ────────────────────────────────────────

    if (subpath !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    const sessionId = req.headers.get("mcp-session-id");

    if (req.method === "DELETE") {
      if (sessionId) {
        const transport = sessions.get(sessionId);
        if (transport) {
          await transport.close();
          sessions.delete(sessionId);
        }
      }
      return new Response(null, { status: 200 });
    }

    if (sessionId && sessions.has(sessionId)) {
      return sessions.get(sessionId)!.handleRequest(req);
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const token = extractToken(req);
    if (!token) return unauthorized(brand_id);

    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { sessions.set(sid, transport); },
      onsessionclosed:      (sid) => { sessions.delete(sid); },
    });

    const server = new McpServer({ name: "mcp-diagnostica", version: "0.1.0" });
    registerAnalyticsTools(server, () => token, () => brand_id, () => BACKEND_URL);
    await server.connect(transport);

    return transport.handleRequest(req);
  },
});

process.stderr.write(`[mcp-diagnostica] HTTP server en ${PUBLIC_URL}\n`);
process.stderr.write(`[mcp-diagnostica] MCP endpoint: ${PUBLIC_URL}/:brand_id/mcp\n`);

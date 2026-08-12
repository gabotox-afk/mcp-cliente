import { resolve } from "path";

const BACKEND_URL = process.env.BACKEND_URL ?? "https://facu-back.diagnostica.com.ar";
const AUTH_PORT   = 4242;
const TOKEN_FILE  = resolve(import.meta.dir, "../.token");

// El backend real no expone un servidor OAuth (no tiene /oauth/authorize ni
// /oauth/token) — solo POST /users/login (email+password → JWT) y
// POST /users/multi_refresh_token. Como este flujo corre 100% local (el propio
// proceso sirve el form y consume el login, sin redirect externo de por medio),
// no hace falta el dance de authorization code + PKCE: se llama al login real
// directamente y se cachea el resultado.

type TokenCache = {
  access_token:  string;
  refresh_token: string;
  expires_at:    number;
};

async function readTokenCache(): Promise<TokenCache | null> {
  try {
    const file = Bun.file(TOKEN_FILE);
    if (await file.exists()) {
      const data = JSON.parse(await file.text()) as TokenCache;
      if (data.access_token && data.refresh_token) return data;
    }
  } catch {}
  return null;
}

async function writeTokenCache(cache: TokenCache): Promise<void> {
  await Bun.write(TOKEN_FILE, JSON.stringify(cache));
}

function jwtExpiresIn(token: string, fallbackSeconds = 3600): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8"));
    if (typeof payload.exp === "number") {
      return Math.max(payload.exp - Math.floor(Date.now() / 1000), 0);
    }
  } catch {}
  return fallbackSeconds;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenCache | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/users/multi_refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json() as { success: boolean; token?: string; refreshToken?: string };
    if (!res.ok || !data.success || !data.token || !data.refreshToken) return null;
    const cache: TokenCache = {
      access_token:  data.token,
      refresh_token: data.refreshToken,
      expires_at:    Date.now() + jwtExpiresIn(data.token) * 1000,
    };
    await writeTokenCache(cache);
    return cache;
  } catch {
    return null;
  }
}

async function openBrowser(url: string) {
  const cmds = ["xdg-open", "open", "start"];
  for (const cmd of cmds) {
    try {
      Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
      return;
    } catch {}
  }
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP Diagnostica — Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f1f5f9; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.08); width: 100%; max-width: 360px; }
    .logo { font-size: 1.1rem; font-weight: 700; color: #1e40af; margin-bottom: .25rem; }
    .subtitle { font-size: .8rem; color: #94a3b8; margin-bottom: 1.75rem; }
    label { display: block; font-size: .8rem; font-weight: 500; color: #475569; margin-bottom: .3rem; margin-top: 1rem; }
    input { width: 100%; padding: .6rem .75rem; border: 1.5px solid #e2e8f0; border-radius: 7px; font-size: .9rem; color: #1e293b; }
    input:focus { outline: none; border-color: #3b82f6; }
    button { margin-top: 1.5rem; width: 100%; padding: .7rem; background: #2563eb; color: white; border: none; border-radius: 7px; font-size: .9rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #93c5fd; cursor: not-allowed; }
    .msg { margin-top: 1rem; padding: .65rem .8rem; border-radius: 7px; font-size: .825rem; display: none; }
    .msg.err { background: #fee2e2; color: #991b1b; display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">MCP Diagnostica</div>
    <div class="subtitle">Autenticación del servidor MCP local</div>
    <form id="form">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="email" placeholder="usuario@diagnostica.com.ar">
      <label for="password">Contraseña</label>
      <input id="password" type="password" name="password" required autocomplete="current-password" placeholder="••••••••">
      <button type="submit" id="btn">Iniciar sesión</button>
    </form>
    <div id="msg" class="msg"></div>
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
        const res  = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: form.email.value, password: form.password.value }),
        });
        const data = await res.json();
        if (data.success) {
          document.body.innerHTML = '<div style="font-family:system-ui;text-align:center"><h2 style="color:#065f46">✓ Autenticación exitosa</h2><p style="color:#475569;margin-top:.5rem">Podés cerrar esta ventana.</p></div>';
        } else {
          msg.className = 'msg err';
          msg.textContent = data.message || 'Credenciales inválidas.';
          btn.disabled = false;
          btn.textContent = 'Iniciar sesión';
        }
      } catch {
        msg.className = 'msg err';
        msg.textContent = 'Error de red.';
        btn.disabled = false;
        btn.textContent = 'Iniciar sesión';
      }
    });
  </script>
</body>
</html>`;

async function runAuthFlow(): Promise<TokenCache> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      port: AUTH_PORT,

      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/") {
          return new Response(LOGIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }

        if (req.method === "POST" && url.pathname === "/login") {
          try {
            const { email, password } = await req.json() as { email: string; password: string };

            const loginRes = await fetch(`${BACKEND_URL}/users/login`, {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ email, password }),
            });
            const data = await loginRes.json() as { success: boolean; token?: string; refreshToken?: string; message?: string };

            if (!loginRes.ok || !data.success || !data.token || !data.refreshToken) {
              return Response.json({ success: false, message: data.message ?? "Credenciales inválidas." });
            }

            const cache: TokenCache = {
              access_token:  data.token,
              refresh_token: data.refreshToken,
              expires_at:    Date.now() + jwtExpiresIn(data.token) * 1000,
            };

            await writeTokenCache(cache);
            setTimeout(() => server.stop(), 500);
            resolve(cache);

            return Response.json({ success: true });
          } catch (err) {
            reject(err);
            return Response.json({ success: false, message: "Error interno." }, { status: 500 });
          }
        }

        return new Response("Not found", { status: 404 });
      },
    });

    const loginUrl = `http://localhost:${AUTH_PORT}`;
    process.stderr.write(`[mcp-diagnostica] Autenticación requerida → ${loginUrl}\n`);
    openBrowser(loginUrl);
  });
}

// Devuelve el token si existe, null si no hay ninguno (sin bloquear)
export async function getCachedToken(): Promise<string | null> {
  if (process.env.BACKEND_TOKEN) return process.env.BACKEND_TOKEN;

  const cached = await readTokenCache();
  if (cached) {
    if (cached.expires_at > Date.now() + 60_000) return cached.access_token;
    const refreshed = await refreshAccessToken(cached.refresh_token);
    if (refreshed) return refreshed.access_token;
  }

  return null;
}

// Inicia el flujo OAuth en background sin bloquear
export function startAuthFlowInBackground(): void {
  runAuthFlow()
    .then((cache) => {
      process.env.BACKEND_TOKEN = cache.access_token;
      process.stderr.write("[mcp-diagnostica] Token OAuth obtenido correctamente.\n");
    })
    .catch((err) => {
      process.stderr.write(`[mcp-diagnostica] Error en flujo OAuth: ${err}\n`);
    });
}

export async function getToken(): Promise<string> {
  if (process.env.BACKEND_TOKEN) return process.env.BACKEND_TOKEN;

  const cached = await readTokenCache();
  if (cached) {
    if (cached.expires_at > Date.now() + 60_000) return cached.access_token;
    const refreshed = await refreshAccessToken(cached.refresh_token);
    if (refreshed) return refreshed.access_token;
  }

  const cache = await runAuthFlow();
  return cache.access_token;
}

export async function clearToken(): Promise<void> {
  try {
    const { unlinkSync } = await import("fs");
    unlinkSync(TOKEN_FILE);
  } catch {}
}

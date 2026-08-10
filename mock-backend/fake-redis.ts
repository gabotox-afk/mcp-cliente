// Mini servidor Redis (subset RESP2) para desarrollo local en Windows, sin
// depender de WSL/Docker. Solo implementa lo que src/http.ts necesita:
// HELLO/PING (handshake), SET (con EX opcional), GET, GETDEL, DEL.
// Estado en memoria, con expiración simple. NO usar en producción.

const store = new Map<string, { value: string; expiresAt: number | null }>();

function get(key: string): string | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function encBulk(s: string | null): string {
  if (s === null) return "$-1\r\n";
  const bytes = Buffer.byteLength(s, "utf-8");
  return `$${bytes}\r\n${s}\r\n`;
}

function encSimple(s: string): string {
  return `+${s}\r\n`;
}

function encInt(n: number): string {
  return `:${n}\r\n`;
}

function encErr(s: string): string {
  return `-ERR ${s}\r\n`;
}

function encMap(pairs: [string, string][]): string {
  let out = `%${pairs.length}\r\n`;
  for (const [k, v] of pairs) out += encBulk(k) + encBulk(v);
  return out;
}

// Parser RESP2 muy simple: solo arrays de bulk strings (*N\r\n$len\r\nval\r\n...),
// que es el único formato que usan los clientes reales para mandar comandos.
function parseCommands(buf: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;

  while (offset < buf.length) {
    if (buf[offset] !== 0x2a /* '*' */) break; // no más arrays completos
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const argCount = parseInt(buf.toString("utf-8", offset + 1, lineEnd), 10);
    let cursor = lineEnd + 2;
    const args: string[] = [];
    let ok = true;

    for (let i = 0; i < argCount; i++) {
      if (buf[cursor] !== 0x24 /* '$' */) { ok = false; break; }
      const lenEnd = buf.indexOf("\r\n", cursor);
      if (lenEnd === -1) { ok = false; break; }
      const len = parseInt(buf.toString("utf-8", cursor + 1, lenEnd), 10);
      const valStart = lenEnd + 2;
      const valEnd = valStart + len;
      if (valEnd + 2 > buf.length) { ok = false; break; }
      args.push(buf.toString("utf-8", valStart, valEnd));
      cursor = valEnd + 2;
    }

    if (!ok) break;
    commands.push(args);
    offset = cursor;
  }

  return { commands, rest: buf.subarray(offset) };
}

function handleCommand(args: string[]): string {
  const cmd = (args[0] ?? "").toUpperCase();

  switch (cmd) {
    case "HELLO":
      return encMap([
        ["server", "redis"], ["version", "7.0.0"], ["proto", "2"],
        ["id", "1"], ["mode", "standalone"], ["role", "master"], ["modules", ""],
      ]);
    case "PING":
      return encSimple("PONG");
    case "AUTH":
      return encSimple("OK");
    case "SELECT":
      return encSimple("OK");
    case "CLIENT":
      return encSimple("OK");
    case "SET": {
      const [, key, value, ...rest] = args;
      let expiresAt: number | null = null;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i].toUpperCase() === "EX") {
          const seconds = parseInt(rest[i + 1], 10);
          expiresAt = Date.now() + seconds * 1000;
        }
      }
      store.set(key, { value, expiresAt });
      return encSimple("OK");
    }
    case "GET": {
      const [, key] = args;
      return encBulk(get(key));
    }
    case "GETDEL": {
      const [, key] = args;
      const v = get(key);
      store.delete(key);
      return encBulk(v);
    }
    case "DEL": {
      const [, ...keys] = args;
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return encInt(n);
    }
    default:
      return encErr(`unknown command '${cmd}'`);
  }
}

const PORT = parseInt(process.argv[2] ?? "6379");

Bun.listen({
  hostname: "127.0.0.1",
  port: PORT,
  socket: {
    open() {},
    data(socket, data) {
      const { commands } = parseCommands(Buffer.from(data));
      let out = "";
      for (const cmd of commands) out += handleCommand(cmd);
      if (out) socket.write(out);
    },
    close() {},
    error(_socket, err) {
      process.stderr.write(`[fake-redis] socket error: ${err}\n`);
    },
  },
});

process.stderr.write(`[fake-redis] listening on 127.0.0.1:${PORT} (dev-only, in-memory)\n`);

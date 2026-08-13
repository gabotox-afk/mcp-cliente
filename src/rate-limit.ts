import { createHash } from "crypto";
import { RATE_CHAT_PER_MIN, RATE_DATA_PER_MIN } from "./config.ts";

// Limitador por usuario, en memoria.
//
// Existe por una razón concreta: cada mensaje del chat es una llamada paga a la
// API de Claude. Sin tope, una pestaña con un bucle —o alguien con el token de
// un usuario— vacía la cuenta sin que nadie se entere hasta la factura.
//
// Se limita en dos carriles distintos porque el costo es distinto:
//   - "chat"  → gasta tokens de la API. Tope bajo.
//   - "datos" → resumen y gráficos. No pasan por el modelo, solo pegan al MCP,
//               así que el tope es más alto: acá lo que se protege es el backend.
//
// Limitación conocida: al ser en memoria, se resetea si el proceso reinicia y no
// sirve con varias réplicas del backend en paralelo — dos instancias dan el
// doble de cupo. Para eso haría falta un store compartido (Redis, como ya usa el
// MCP para el estado de OAuth). Alcanza para esta escala; conviene saberlo antes
// de escalar horizontalmente.

const WINDOW_MS = 60_000;

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

// La clave es un hash del token, no el token.
//
// Un Map indexado por JWTs crudos mantiene credenciales vivas en memoria mucho
// después de que la request terminó, y aparecen enteras en cualquier volcado de
// heap. Para contar requests alcanza con un identificador estable.
function keyOf(carril: string, token: string): string {
  return carril + ":" + createHash("sha256").update(token).digest("base64url").slice(0, 22);
}

// Sin esto el Map crece para siempre: un usuario que entra una vez deja su
// bucket ahí hasta que el proceso muere. Se limpia al vuelo, aprovechando que ya
// estamos recorriendo por una request.
function limpiarViejos(now: number): void {
  for (const [k, b] of buckets) {
    if (now - b.windowStart >= WINDOW_MS * 2) buckets.delete(k);
  }
}

let ultimaLimpieza = 0;

export type RateResult = { allowed: boolean; retryAfter?: number };

export function checkRateLimit(carril: "chat" | "datos", token: string): RateResult {
  const max = carril === "chat" ? RATE_CHAT_PER_MIN : RATE_DATA_PER_MIN;
  if (max <= 0) return { allowed: true };   // 0 o negativo = sin límite

  const now = Date.now();

  // Barrido cada tanto, no en cada request: recorrer el Map entero por mensaje
  // sería peor que la fuga que estamos evitando.
  if (now - ultimaLimpieza > WINDOW_MS * 5) {
    limpiarViejos(now);
    ultimaLimpieza = now;
  }

  const key = keyOf(carril, token);
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (bucket.count >= max) {
    return { allowed: false, retryAfter: Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000) };
  }

  bucket.count++;
  return { allowed: true };
}

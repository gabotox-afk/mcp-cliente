// Limitador simple en memoria, por token de usuario. Se resetea si el proceso reinicia
// y no es apto para correr varias instancias del backend en paralelo (para eso haría
// falta un store compartido tipo Redis) -- alcanza para esta escala.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 15;

const buckets = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (bucket.count >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  bucket.count++;
  return { allowed: true };
}

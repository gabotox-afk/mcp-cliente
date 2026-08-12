const BASE_URL = process.env.BACKEND_URL ?? "https://facu-back.diagnostica.com.ar";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function backendFetch<T = unknown>(
  path: string,
  options: {
    method?:     HttpMethod;
    body?:       unknown;
    query?:      Record<string, string | number | boolean | undefined>;
    token?:      string;
    brandId?:    string;
    backendUrl?: string;
  } = {},
): Promise<T> {
  const { method = "GET", body, query, token, brandId, backendUrl } = options;

  let url = `${backendUrl ?? BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const bearerToken = token ?? process.env.BACKEND_TOKEN;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      ...(brandId     ? { "X-Brand-ID": brandId }                  : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

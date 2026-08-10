// Configuración del chat backend. Todo por variables de entorno: el chat no
// sabe nada del MCP concreto al que se conecta, solo de su URL.

export const PORT = parseInt(process.env.CHAT_PORT ?? "3002");

// URL base del MCP server. El brandId se agrega por request, porque cada
// usuario puede pertenecer a una marca distinta.
export const MCP_BASE_URL = process.env.MCP_BASE_URL ?? "http://localhost:3001";

// Solo para la página demo: simula el login que en producción hace la página
// de la empresa. En un despliegue real el token ya viene del host.
export const DEMO_BACKEND_URL = process.env.DEMO_BACKEND_URL ?? "http://localhost:4000";
export const DEMO_BRAND_ID    = process.env.DEMO_BRAND_ID    ?? "61866334643609b69b8b6c48";

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

// Sonnet 5 como default: es lo que mejor relación precio/capacidad da para un
// chat sobre tools. Opus 5 rinde parecido acá y sale bastante más caro.
export const MODEL  = process.env.CHAT_MODEL  ?? "claude-sonnet-5";
export const EFFORT = process.env.CHAT_EFFORT ?? "medium";

// `output_config.effort` no existe en todos los modelos: Haiku 4.5 y Sonnet 4.5
// devuelven 400 si se les manda. Se omite ahí, y también si CHAT_EFFORT="".
export const SUPPORTS_EFFORT = EFFORT !== "" && !/haiku|sonnet-4-5/i.test(MODEL);

// "real" usa la API de Claude; "stub" usa un agente determinista que no
// necesita credenciales — sirve para verificar el circuito completo
// front → back → MCP sin gastar tokens.
export const AGENT_MODE: "real" | "stub" =
  (process.env.CHAT_AGENT_MODE as "real" | "stub" | undefined) ??
  (ANTHROPIC_API_KEY ? "real" : "stub");

// Tope de vueltas del loop de tools, para que un modelo que se enrosque no
// deje la request colgada indefinidamente.
export const MAX_TOOL_ITERATIONS = parseInt(process.env.CHAT_MAX_ITERATIONS ?? "8");

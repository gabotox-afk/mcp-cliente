# Cliente de chat sobre MCP

Chat que responde preguntas sobre datos de una empresa consultando un servidor
MCP. Pensado para embeberse en el producto de la empresa: el usuario ya está
logueado en la página, y el chat reutiliza ese token — no pide credenciales
propias.

El MCP es una abstracción: el chat descubre las herramientas disponibles con
`tools/list` y no sabe cuáles son de antemano. Sirve para el MCP de Diagnostica
o para cualquier otro.

## Arquitectura

```
navegador ──(JWT del login de la empresa)──▶ chat-backend ──(mismo JWT)──▶ MCP ──▶ backend
                                                  │
                                                  └──▶ API de Claude
```

Tres decisiones que definen el diseño:

- **Cliente MCP propio, no el conector de Anthropic.** El chat-backend es el
  único que habla con el MCP; Claude solo recibe definiciones de herramientas y
  resultados ya ejecutados. Esto permite que el MCP del cliente viva detrás de
  una VPN o una allowlist de IPs, y deja auditar cada llamada.
- **Sin OAuth.** El flujo OAuth del MCP existe para clientes de terceros
  (claude.ai, Claude Code). Un chat embebido en el propio producto reutiliza el
  JWT que la página ya tiene.
- **Conexión por request.** Las sesiones del MCP viven en memoria de su proceso,
  así que abrir y cerrar por mensaje lo hace inmune a reinicios del MCP.

## Qué hay acá

Solo `chat/`: el backend del chat (Bun) más una página de demostración. Es lo
único que se hospeda y lo único que este repo mantiene.

**El servidor MCP no está acá, a propósito.** El chat no depende de ninguno en
particular: descubre las tools con `tools/list` y habla el protocolo, nada más.
Apuntarlo a otro MCP es cambiar una variable de entorno:

```
MCP_BASE_URL=https://el-mcp-que-sea
```

Tenerlo adentro significaría mantener una copia de un repo ajeno, que se
desincroniza en silencio la primera vez que alguien toca el original.

## Cómo levantarlo

El chat necesita un MCP corriendo del otro lado. Para desarrollo local eso son
dos procesos más, que viven en sus propios repos:

- un **servidor MCP** en `MCP_BASE_URL` (para Diagnostica:
  [`Llaudet/mcp-diagnostica`](https://github.com/Llaudet/mcp-diagnostica),
  levantado con `bun src/http.ts`)
- el **backend** al que ese MCP consulta — el real, o uno de prueba apuntándole
  con `BACKEND_URL`

Con eso arriba:

```bash
cd chat && bun install && bun src/server.ts
```

Después, `http://localhost:3002`. La página demo simula el login de la empresa:
pide las credenciales contra el backend directamente y abre el chat con el token
que recibe. El chat-backend nunca ve la contraseña — solo recibe el token ya
emitido, igual que pasaría embebido en el producto real. Las credenciales son
las del backend que estés usando (`DEMO_BACKEND_URL`), no del chat.

## Configuración

Copiar `chat/.env.example` a `chat/.env` y completar:

```
ANTHROPIC_API_KEY=sk-ant-...
CHAT_MODEL=claude-sonnet-5
CHAT_EFFORT=medium
MCP_BASE_URL=http://localhost:3001
```

**El `.env` nunca se sube**: tiene la API key y está en `.gitignore`.

### Whitelist de tools

`CHAT_ALLOWED_TOOLS` limita qué tools puede usar el chat. Vacío o sin setear =
todas las que exponga el MCP.

Va por configuración y no hardcodeada: los nombres son del MCP, no del chat, y
clavarlos en el código lo ataría a un MCP puntual. La lista que viene en
`.env.example` es la del MCP de Diagnostica: deja afuera `list_brands`
(cross-brand, pide el rol `mcp_inspector`), `list_users` / `count_users` /
`get_user` (directorio de staff) y `list_roles` (catálogo interno).

Se aplica en dos lugares: al armar el catálogo que ve el modelo, y otra vez al
ejecutar. Lo segundo importa — el modelo puede pedir una tool que no le
ofrecimos, por alucinación o porque el historial menciona una que ya no existe.
Filtrar solo en el catálogo sería una restricción sugerida, no aplicada.

Si la lista nombra una tool que el MCP ya no expone, el chat lo avisa por
consola al arrancar. Sin eso, una tool que desaparece degrada las respuestas en
silencio.

En el MCP de Diagnostica recorta el catálogo de 28 a 23 tools: 12.056 → 10.477
tokens. La ganancia de costo es modesta porque el prompt caching ya absorbe casi
todo; el motivo principal es de alcance, no de plata.

Sin API key el chat arranca en modo *stub*: no interpreta lenguaje natural, pero
el circuito completo (front → back → MCP) funciona igual. Sirve para verificar
la infraestructura sin gastar tokens.

### Sobre el modelo

Probados los tres con las mismas preguntas, todos aciertan:

| Modelo | Costo por consulta | Latencia |
|---|---|---|
| Haiku 4.5 | ~US$0.025 | ~3-5s |
| Sonnet 5 | ~US$0.090 | ~6-10s |
| Opus 5 | ~US$0.150 | ~4-7s |

El costo lo domina el catálogo de herramientas que viaja en cada request
(~12k tokens solo de definiciones), no la conversación. Por eso hay **prompt
caching**: el catálogo y el system prompt se marcan como cacheables, y el
historial lleva un breakpoint al final. Medido sobre una conversación de tres
mensajes, el 98% del prompt se lee del cache — una lectura cuesta ~0.1× lo que
cuesta el token normal.

Que funcione depende de que el prefijo sea byte a byte idéntico entre requests,
así que los mensajes siempre se arman como arrays de bloques (nunca strings
sueltos) y el orden es fijo: `tools` → `system` → `messages`.

No conviene desactivar el thinking: sin él, el modelo a veces escribe la llamada
a la herramienta como texto plano en vez de emitir el bloque estructurado, y la
llamada nunca se ejecuta — sin error y sin aviso. Para bajar costo se usa
`CHAT_EFFORT`, no se apaga el thinking.

## Estado

Prototipo funcional. Falta: persistencia de conversaciones, gráficos e informes
predeterminados, y empaquetar la UI como componente React reutilizable (hoy es
una página HTML de demostración).

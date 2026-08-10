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

## Componentes

| Carpeta | Qué es |
|---|---|
| `chat/` | Backend del chat (Bun) + página demo. Es lo único que se hospeda. |
| `mock-backend/` | Backend falso con datos de prueba, para desarrollar sin tocar datos reales. |

## Cómo levantarlo

Hacen falta tres procesos. El MCP server no está en este repo — se levanta aparte.

```bash
# 1. Backend de prueba (puerto 4000)
cd mock-backend && npm install && node server.js

# 2. Servidor MCP (puerto 3001) — desde su propio repo,
#    apuntando BACKEND_URL a http://localhost:4000

# 3. Chat (puerto 3002)
cd chat && bun install && bun src/server.ts
```

Después, `http://localhost:3002`. La página demo simula el login de la empresa
(`admin@diagnostica.com` / `1234`) y abre el chat con ese token.

## Configuración

Copiar `chat/.env.example` a `chat/.env` y completar:

```
ANTHROPIC_API_KEY=sk-ant-...
CHAT_MODEL=claude-sonnet-5
CHAT_EFFORT=medium
MCP_BASE_URL=http://localhost:3001
```

**El `.env` nunca se sube**: tiene la API key y está en `.gitignore`.

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
(~25-30k tokens de entrada), no la conversación. Prompt caching es la
optimización obvia si esto escala.

No conviene desactivar el thinking: sin él, el modelo a veces escribe la llamada
a la herramienta como texto plano en vez de emitir el bloque estructurado, y la
llamada nunca se ejecuta — sin error y sin aviso. Para bajar costo se usa
`CHAT_EFFORT`, no se apaga el thinking.

## Estado

Prototipo funcional. Falta: persistencia de conversaciones, gráficos e informes
predeterminados, y empaquetar la UI como componente React reutilizable (hoy es
una página HTML de demostración).

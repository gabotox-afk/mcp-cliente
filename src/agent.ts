import Anthropic from "@anthropic-ai/sdk";
export class SessionExpiredError extends Error {}
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withMcpClient } from "./mcpClient.ts";
import { ALLOWED_TOOLS } from "./tools.ts";

const anthropic = new Anthropic();
const MODEL = "claude-opus-5";
const MAX_TOOL_ITERATIONS = 8;

const SYSTEM_PROMPT =
  "Sos el asistente de datos de Diagnostica, embebido en la plataforma. Respondes preguntas sobre " +
  "sesiones, atenciones, turnos, exámenes, pacientes, kioscos y el estado operativo de la plataforma " +
  "usando exclusivamente las tools disponibles -- nunca inventes números. Si no estás seguro del valor " +
  "exacto de un filtro (un estado, un tipo), usá list_valid_filters primero. Si te preguntan por algo que " +
  "no podés resolver con las tools que tenés, decilo claramente en vez de adivinar. Respuestas breves y " +
  "concretas, en español.";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RenderedChart {
  html: string;
  pdfLink: string;
}

export interface ChatResult {
  reply: string;
  charts: RenderedChart[];
}

async function toolResultToText(result: Awaited<ReturnType<Client["callTool"]>>): Promise<string> {
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
    .join("\n");
}

// generate_interactive_chart devuelve HTML autocontenido (Chart.js embebido) más el link
// de PDF, ambos como content blocks de texto. Ese HTML no le sirve a Claude como dato --
// solo infla tokens -- así que se lo saca de la conversación y se manda aparte al widget
// para que lo renderice él directamente.
function extractChart(result: Awaited<ReturnType<Client["callTool"]>>): RenderedChart | null {
  if (!Array.isArray(result.content)) return null;
  const htmlBlock = result.content.find(
    (b) => b.type === "text" && typeof b.text === "string" && b.text.startsWith("<!DOCTYPE html"),
  );
  if (!htmlBlock || htmlBlock.type !== "text") return null;
  const linkBlock = result.content.find(
    (b) => b.type === "text" && typeof b.text === "string" && b.text.startsWith("PDF descargable"),
  );
  return { html: htmlBlock.text, pdfLink: linkBlock?.type === "text" ? linkBlock.text : "" };
}

export async function runChat(token: string, brandId: string, history: ChatMessage[]): Promise<ChatResult> {
  return withMcpClient(token, brandId, async (client) => {
    const { tools } = await client.listTools();
    const allowedTools = tools.filter((t) => ALLOWED_TOOLS.has(t.name));
    const anthropicTools: Anthropic.Tool[] = allowedTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    }));

    const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
    const charts: RenderedChart[] = [];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: anthropicTools,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
        return { reply: textBlock?.text ?? "", charts };
      }

      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        if (!ALLOWED_TOOLS.has(block.name)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `La tool "${block.name}" no está habilitada en este chat.`,
            is_error: true,
          });
          continue;
        }
        try {
          const result = await client.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
          if (result.isError) {
            const errorText = await toolResultToText(result);
            if (errorText.includes("401") || errorText.includes("Token inválido")){
              throw new SessionExpiredError("La sesión del usuario expiro.");
            }
          }

          if (block.name === "generate_interactive_chart") {
            const chart = extractChart(result);
            if (chart) charts.push(chart);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: chart ? "Gráfico generado y mostrado al usuario en el chat." : await toolResultToText(result),
            });
            continue;
          }

          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: await toolResultToText(result) });
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("401") || message.includes("Token inválido")){
            throw new SessionExpiredError("La sesion del usuario expiro");
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: message,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

    return { reply: "No pude terminar de procesar la consulta (demasiados pasos). Probá con una pregunta más acotada.", charts };
  });
}

export interface DashboardChart {
  title: string;
  type: "bar" | "doughnut";
  labels: string[];
  values: number[];
}

export async function getDashboardCharts(token: string, brandId: string): Promise<DashboardChart[]> {
  return withMcpClient(token, brandId, async (client) => {
    // Default: últimos 30 días reales. DASHBOARD_FROM/DASHBOARD_TO permiten pisar el
    // rango (ej. para demos contra datos de seed fechados en el pasado).
    const to   = process.env.DASHBOARD_TO   ? new Date(process.env.DASHBOARD_TO)   : new Date();
    const from = process.env.DASHBOARD_FROM
      ? new Date(process.env.DASHBOARD_FROM)
      : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    const result = await client.callTool({
      name: "get_period_summary",
      arguments: { from: from.toISOString(), to: to.toISOString() },
    });
    const text = await toolResultToText(result);
    const data = JSON.parse(text) as {
      current: {
        sessions: { by_status: Record<string, number> };
        attentions: { by_status: Record<string, number> };
        exams: { by_type: Record<string, number> };
      };
    };

    const toChart = (title: string, type: DashboardChart["type"], byKey: Record<string, number>): DashboardChart => ({
      title,
      type,
      labels: Object.keys(byKey),
      values: Object.values(byKey),
    });

    return [
      toChart("Sesiones por estado (últimos 30 días)", "doughnut", data.current.sessions.by_status),
      toChart("Atenciones por estado (últimos 30 días)", "doughnut", data.current.attentions.by_status),
      toChart("Exámenes por tipo (últimos 30 días)", "bar", data.current.exams.by_type),
    ];
  });
}

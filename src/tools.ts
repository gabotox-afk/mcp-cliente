// Subconjunto curado de tools de mcp-diagnostica que el chat embebido puede usar.
// Quedan afuera a proposito: list_brands (rol mcp_inspector, cross-brand, no aplica
// a un widget de una sola marca), list_users/count_users (directorio de staff),
// list_roles (catalogo interno de bajo valor para el usuario final) y los prototipos
// de generacion de PDF/PNG (generate_chart_pdf_prototype, generate_chart_png_prototype).
export const ALLOWED_TOOLS = new Set([
  "list_valid_filters",
  "get_operational_status",
  "get_period_summary",
  "count_sessions",
  "list_sessions",
  "count_attentions",
  "list_attentions",
  "count_appointments",
  "list_appointments",
  "count_exams",
  "list_exams",
  "count_patients",
  "list_patients",
  "get_patient",
  "count_checks",
  "list_checks",
  "count_kiosks",
  "list_kiosks",
  "count_schedules",
  "list_schedules",
  "count_videovisits",
  "list_videovisits",
  "count_records",
  "list_records",
  "generate_interactive_chart",
]);

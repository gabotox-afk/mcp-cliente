import { z } from "zod";
import { backendFetch } from "../client.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const dateRangeAndPagination = {
  from: z.string().optional().describe("Fecha de inicio en formato ISO (ej: 2024-01-01)"),
  to: z.string().optional().describe("Fecha de fin en formato ISO (ej: 2024-12-31)"),
  limit: z.number().int().positive().optional().describe("Máximo de resultados a devolver"),
  offset: z.number().int().min(0).optional().describe("Cantidad de resultados a saltear"),
};

const dateRange = {
  from: z.string().optional().describe("Fecha de inicio en formato ISO (ej: 2024-01-01)"),
  to: z.string().optional().describe("Fecha de fin en formato ISO (ej: 2024-12-31)"),
};

const brandsParam = {
  brands: z
    .string()
    .optional()
    .describe(
      "Modo cross-brand: '*' para todas las marcas accesibles, o lista de brandIds separados por coma (ej: 'id1,id2'). " +
        "Usar list_brands para obtener los brandIds disponibles. Requiere el rol mcp_inspector (cross-brand); " +
        "si se omite, se consulta únicamente la marca asociada al token actual.",
    ),
};
const AUTH_URL = process.env.AUTH_URL ?? "http://localhost:4242";

// Campos personales que nunca se devuelven para un paciente. El personal (médicos, operadores)
// no es anónimo — Facu confirmó que sus nombres se pueden mostrar sin problema.
// El modelo User real usa name/surname/email/phone (no lastName/firstName).
const SENSITIVE_FIELDS = ["name", "surname", "lastName", "firstName", "email", "phone"];

function omitSensitiveFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !SENSITIVE_FIELDS.includes(k)));
}

// Un USER solo es anónimo cuando representa a un paciente logueado (USER.patient seteado).
// Las cuentas de personal (medico/operador/etc, sin patient) muestran su nombre normalmente.
function omitSensitiveFieldsIfPatientLinked(record: Record<string, unknown>): Record<string, unknown> {
  return record.patient ? omitSensitiveFields(record) : record;
}

export function registerAnalyticsTools(server: McpServer, getToken?: () => string, getBrandId?: () => string, getBackendUrl?: () => string) {
  // --- Brands ---

  server.tool(
    "list_brands",
    "Lista los brandId (y nombre) de las marcas accesibles por el usuario/token actual. " +
      "Requiere el rol mcp_inspector (cross-brand). Usar los brandId devueltos con el parámetro 'brands' de las demás herramientas de analytics.",
    {},
    async () => {
      const data = await backendFetch("/api/v1/analytics/brands", { token: token() });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );


  const token = () => {
    const t = getToken?.();
    if (!t) throw new Error(`No autenticado. Por favor iniciá sesión en ${AUTH_URL} y volvé a intentarlo.`);
    return t;
  };
  const brandId    = () => getBrandId?.();
  const backendUrl = () => getBackendUrl?.();
  // --- Sessions ---

  server.tool(
    "count_sessions",
    "Cuenta las sesiones registradas en Diagnostica. Soporta filtros por rango de fechas, id, estado, tipo, paciente, usuario, operador, turno, kiosco y acceso cross-brand.",
    {
      ...dateRange,
      _id: z.string().optional().describe("Filtrar por ID de la sesión"),
      status: z.string().optional().describe("Filtrar por estado de la sesión"),
      type: z.string().optional().describe("Filtrar por tipo de sesión"),
      patient_id: z.string().optional().describe("Filtrar por ID del paciente"),
      user_id: z.string().optional().describe("Filtrar por ID del usuario logueado en la sesión"),
      operator_id: z.string().optional().describe("Filtrar por ID del usuario que operó la sesión"),
      appointment_id: z.string().optional().describe("Filtrar por ID del turno del que proviene la sesión"),
      kiosk_id: z.string().optional().describe("Filtrar por ID del kiosco donde ocurrió la sesión"),
      ...brandsParam,
    },
    async ({ from, to, _id, status, type, patient_id, user_id, operator_id, appointment_id, kiosk_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/sessions/count", {
        token: token(),
        query: { from, to, _id, status, type, patient_id, user_id, operator_id, appointment_id, kiosk_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_sessions",
    "Lista las sesiones registradas en Diagnostica. Soporta filtros por rango de fechas, id, estado, tipo, paciente, usuario, operador, turno, kiosco, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      _id: z.string().optional().describe("Filtrar por ID de la sesión"),
      status: z.string().optional().describe("Filtrar por estado de la sesión"),
      type: z.string().optional().describe("Filtrar por tipo de sesión"),
      patient_id: z.string().optional().describe("Filtrar por ID del paciente"),
      user_id: z.string().optional().describe("Filtrar por ID del usuario logueado en la sesión"),
      operator_id: z.string().optional().describe("Filtrar por ID del usuario que operó la sesión"),
      appointment_id: z.string().optional().describe("Filtrar por ID del turno del que proviene la sesión"),
      kiosk_id: z.string().optional().describe("Filtrar por ID del kiosco donde ocurrió la sesión"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, _id, status, type, patient_id, user_id, operator_id, appointment_id, kiosk_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/sessions", {
        token: token(),
        query: { from, to, limit, offset, _id, status, type, patient_id, user_id, operator_id, appointment_id, kiosk_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Patients ---

  server.tool(
    "count_patients",
    "Cuenta los pacientes registrados en Diagnostica. Soporta filtros por rango de fechas, origen, id y acceso cross-brand.",
    {
      ...dateRange,
      _id: z.string().optional().describe("Filtrar por ID del paciente"),
      origin: z.string().optional().describe("Filtrar por origen del paciente"),
      ...brandsParam,
    },
    async ({ from, to, _id, origin, brands }) => {
      const data = await backendFetch("/api/v1/analytics/patients/count", {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { from, to, _id, origin, brands  },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_patients",
    "Lista los pacientes registrados en Diagnostica, excluyendo nombre y demás datos personales. Soporta filtros por rango de fechas, origen, id, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      _id: z.string().optional().describe("Filtrar por ID del paciente"),
      origin: z.string().optional().describe("Filtrar por origen del paciente"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, _id, origin, brands }) => {
      const data = await backendFetch("/api/v1/analytics/patients", {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { from, to, limit, offset, _id, origin, brands  },
      });
      const raw = data as any;
      if (Array.isArray(raw?.data)) raw.data = raw.data.map(omitSensitiveFields);
      return { content: [{ type: "text", text: JSON.stringify(raw, null, 2) }] };
    },
  );

  // --- Users ---

  server.tool(
    "count_users",
    "Cuenta los usuarios registrados en Diagnostica (cuentas de acceso: pacientes logueados, operadores, médicos, etc). Soporta filtros por rango de fechas, rol, paciente asociado, kiosco y acceso cross-brand.",
    {
      ...dateRange,
      _id: z.string().optional().describe("Filtrar por ID del usuario"),
      role: z.string().optional().describe("Filtrar por rol (ej: 'medico', 'operador')"),
      patient_id: z.string().optional().describe("Filtrar por ID del paciente asociado a la cuenta"),
      kiosk_id: z.string().optional().describe("Filtrar por ID del kiosco asociado a la cuenta"),
      ...brandsParam,
    },
    async ({ from, to, _id, role, patient_id, kiosk_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/users/count", {
        token: token(),
        query: { from, to, _id, role, patient_id, kiosk_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_users",
    "Lista los usuarios registrados en Diagnostica (cuentas de acceso: pacientes logueados, operadores, médicos, etc). Para cuentas de pacientes logueados, excluye nombre y demás datos personales; el personal (médicos, operadores) sí muestra su nombre. Soporta filtros por rango de fechas, rol, paciente asociado, kiosco, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      _id: z.string().optional().describe("Filtrar por ID del usuario"),
      role: z.string().optional().describe("Filtrar por rol (ej: 'medico', 'operador')"),
      patient_id: z.string().optional().describe("Filtrar por ID del paciente asociado a la cuenta"),
      kiosk_id: z.string().optional().describe("Filtrar por ID del kiosco asociado a la cuenta"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, _id, role, patient_id, kiosk_id, brands }) => {
      const data = await backendFetch<Record<string, unknown>>("/api/v1/analytics/users", {
        token: token(),
        query: { from, to, limit, offset, _id, role, patient_id, kiosk_id, brands },
      });
      const raw = data as any;
      if (Array.isArray(raw?.data)) raw.data = raw.data.map(omitSensitiveFieldsIfPatientLinked);
      return { content: [{ type: "text", text: JSON.stringify(raw, null, 2) }] };
    },
  );

  server.tool(
    "get_user",
    "Obtiene los datos de un usuario por ID. Si la cuenta es de un paciente logueado, excluye nombre y demás datos personales; si es de personal (médico, operador), muestra su nombre normalmente. " +
      "En modo cross-brand (parámetro 'brands') devuelve un resultado por cada marca donde exista el usuario.",
    {
      _id: z.string().describe("ID del usuario"),
      ...brandsParam,
    },
    async ({ _id, brands }) => {
      const data = await backendFetch<Record<string, unknown>>(`/api/v1/analytics/users/${_id}`, {
        token: token(),
        query: { brands },
      });
      const user = (data as any).data ?? data;
      const sanitized = Array.isArray(user) ? user.map(omitSensitiveFieldsIfPatientLinked) : omitSensitiveFieldsIfPatientLinked(user);
      return { content: [{ type: "text", text: JSON.stringify(sanitized, null, 2) }] };
    },
  );

  // --- Kiosks ---

  server.tool(
    "count_kiosks",
    "Cuenta los kioscos registrados en Diagnostica (el dispositivo físico de autoservicio donde ocurre una sesión). Soporta filtros por última desconexión (rango de fechas — el mejor proxy de 'última vez que se usó', ya que marca cuándo terminó el uso, no cuándo empezó), si está conectado ahora mismo, id, estado, tipo, sesión en curso, usuario logueado, usuario del último intento de takeover remoto y acceso cross-brand.",
    {
      ...dateRange,
      _id: z.string().optional().describe("Filtrar por ID del kiosco"),
      status: z.string().optional().describe("Filtrar por estado del kiosco"),
      type: z.string().optional().describe("Filtrar por tipo de kiosco"),
      connected: z.boolean().optional().describe("Filtrar por si el kiosco está conectado en este momento"),
      current_session_id: z.string().optional().describe("Filtrar por ID de la sesión actualmente en curso en el kiosco"),
      active_login_user_id: z.string().optional().describe("Filtrar por ID del usuario actualmente logueado en el kiosco"),
      last_takeover_attempt_user_id: z.string().optional().describe("Filtrar por ID del usuario del último intento de takeover remoto"),
      ...brandsParam,
    },
    async ({ from, to, _id, status, type, connected, current_session_id, active_login_user_id, last_takeover_attempt_user_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/kiosks/count", {
        token: token(),
        query: { from, to, _id, status, type, connected, current_session_id, active_login_user_id, last_takeover_attempt_user_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_kiosks",
    "Lista los kioscos registrados en Diagnostica (el dispositivo físico de autoservicio donde ocurre una sesión). Soporta filtros por última desconexión (rango de fechas — el mejor proxy de 'última vez que se usó', ya que marca cuándo terminó el uso, no cuándo empezó), si está conectado ahora mismo, id, estado, tipo, sesión en curso, usuario logueado, usuario del último intento de takeover remoto, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      _id: z.string().optional().describe("Filtrar por ID del kiosco"),
      status: z.string().optional().describe("Filtrar por estado del kiosco"),
      type: z.string().optional().describe("Filtrar por tipo de kiosco"),
      connected: z.boolean().optional().describe("Filtrar por si el kiosco está conectado en este momento"),
      current_session_id: z.string().optional().describe("Filtrar por ID de la sesión actualmente en curso en el kiosco"),
      active_login_user_id: z.string().optional().describe("Filtrar por ID del usuario actualmente logueado en el kiosco"),
      last_takeover_attempt_user_id: z.string().optional().describe("Filtrar por ID del usuario del último intento de takeover remoto"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, _id, status, type, connected, current_session_id, active_login_user_id, last_takeover_attempt_user_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/kiosks", {
        token: token(),
        query: { from, to, limit, offset, _id, status, type, connected, current_session_id, active_login_user_id, last_takeover_attempt_user_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Appointments ---

  server.tool(
    "count_appointments",
    "Cuenta los turnos registrados en Diagnostica. Soporta filtros por rango de fechas, estado, tipo, paciente, videoconsulta programada y acceso cross-brand.",
    {
      ...dateRange,
      status: z.string().optional().describe("Filtrar por estado del turno"),
      type: z.string().optional().describe("Filtrar por tipo de turno"),
      patient_id: z.string().optional().describe("Filtrar por ID del paciente"),
      videovisit_id: z.string().optional().describe("Filtrar por ID de una videoconsulta programada para el turno"),
      ...brandsParam,
    },
    async ({ from, to, status, type, patient_id, videovisit_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/appointments/count", {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { from, to, status, type, patient_id, videovisit_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_appointments",
    "Lista los turnos registrados en Diagnostica. Soporta filtros por rango de fechas, estado, tipo, paciente, videoconsulta programada, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      status: z.string().optional().describe("Filtrar por estado del turno"),
      type: z.string().optional().describe("Filtrar por tipo de turno"),
      patient_id: z.string().optional().describe("Filtrar por ID del paciente"),
      videovisit_id: z.string().optional().describe("Filtrar por ID de una videoconsulta programada para el turno"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, status, type, patient_id, videovisit_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/appointments", {
        token: token(),
        query: { from, to, limit, offset, status, type, patient_id, videovisit_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Videovisits ---

  server.tool(
    "count_videovisits",
    "Cuenta las videoconsultas registradas en Diagnostica (la videollamada específica que ocurre dentro de una sesión, cuando la hay — no toda sesión de kiosco incluye una). Soporta filtros por rango de fechas, id, estado, sesión, paciente, turno, especialidad y acceso cross-brand.",
    {
      ...dateRange,
      _id: z.string().optional().describe("Filtrar por ID de la videoconsulta"),
      status: z.string().optional().describe("Filtrar por estado de la videoconsulta"),
      session_id: z.string().optional().describe("Filtrar por ID de la sesión"),
      patient_id: z.string().optional().describe("Filtrar por ID del paciente"),
      appointment_id: z.string().optional().describe("Filtrar por ID del turno del que proviene la videoconsulta"),
      specialty: z.string().optional().describe("Filtrar por especialidad médica (ej: 'Pediatría')"),
      ...brandsParam,
    },
    async ({ from, to, _id, status, session_id, patient_id, appointment_id, specialty, brands }) => {
      const data = await backendFetch("/api/v1/analytics/videovisits/count", {
        token: token(),
        query: { from, to, _id, status, session_id, patient_id, appointment_id, specialty, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_videovisits",
    "Lista las videoconsultas registradas en Diagnostica (la videollamada específica que ocurre dentro de una sesión, cuando la hay — no toda sesión de kiosco incluye una). Soporta filtros por rango de fechas, id, estado, sesión, paciente, turno, especialidad, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      _id: z.string().optional().describe("Filtrar por ID de la videoconsulta"),
      status: z.string().optional().describe("Filtrar por estado de la videoconsulta"),
      session_id: z.string().optional().describe("Filtrar por ID de la sesión"),
      patient_id: z.string().optional().describe("Filtrar por ID del paciente"),
      appointment_id: z.string().optional().describe("Filtrar por ID del turno del que proviene la videoconsulta"),
      specialty: z.string().optional().describe("Filtrar por especialidad médica (ej: 'Pediatría')"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, _id, status, session_id, patient_id, appointment_id, specialty, brands }) => {
      const data = await backendFetch("/api/v1/analytics/videovisits", {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { from, to, limit, offset, _id, status, session_id, patient_id, appointment_id, specialty, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Exams ---

  server.tool(
    "count_exams",
    "Cuenta los exámenes registrados en Diagnostica. Soporta filtros por rango de fechas, id, tipo de examen, tipo de dispositivo y acceso cross-brand.",
    {
      ...dateRange,
      _id: z.string().optional().describe("Filtrar por ID del examen"),
      exam_type: z.string().optional().describe("Filtrar por tipo de examen"),
      device_type: z.string().optional().describe("Filtrar por tipo de dispositivo"),
      ...brandsParam,
    },
    async ({ from, to, _id, exam_type, device_type, brands }) => {
      const data = await backendFetch("/api/v1/analytics/exams/count", {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { from, to, _id, exam_type, device_type, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_exams",
    "Lista los exámenes registrados en Diagnostica. Soporta filtros por rango de fechas, id, tipo de examen, tipo de dispositivo, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      _id: z.string().optional().describe("Filtrar por ID del examen"),
      exam_type: z.string().optional().describe("Filtrar por tipo de examen"),
      device_type: z.string().optional().describe("Filtrar por tipo de dispositivo"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, _id, exam_type, device_type, brands }) => {
      const data = await backendFetch("/api/v1/analytics/exams", {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { from, to, limit, offset, _id, exam_type, device_type, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Patient detail ---

  server.tool(
    "get_patient",
    "Obtiene los datos de un paciente por ID, excluyendo nombre y demás datos personales para preservar el anonimato. " +
      "En modo cross-brand (parámetro 'brands') devuelve un resultado por cada marca donde exista el paciente.",
    {
      _id: z.string().describe("ID del paciente"),
      ...brandsParam,
    },
    async ({ _id, brands }) => {
      const data = await backendFetch<Record<string, unknown>>(`/api/v1/analytics/patients/${_id}`, {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { brands },
      });
      const patient = (data as any).data ?? data;
      const sanitized = Array.isArray(patient) ? patient.map(omitSensitiveFields) : omitSensitiveFields(patient);
      return { content: [{ type: "text", text: JSON.stringify(sanitized, null, 2) }] };
    },
  );

  // --- Checks ---

  server.tool(
    "count_checks",
    "Cuenta los checks registrados en Diagnostica. Soporta filtros por rango de fechas, paciente, sesión, atención médica y acceso cross-brand.",
    {
      ...dateRange,
      patient_id: z.string().optional().describe("Filtrar por ID del paciente"),
      session_id: z.string().optional().describe("Filtrar por ID de la sesión"),
      attention_id: z.string().optional().describe("Filtrar por ID de la atención médica"),
      ...brandsParam,
    },
    async ({ from, to, patient_id, session_id, attention_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/checks/count", {
        token: token(),
        query: { from, to, patient_id, session_id, attention_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_checks",
    "Lista los checks registrados en Diagnostica. Soporta filtros por rango de fechas, paciente, sesión, atención médica, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      patient_id: z.string().optional().describe("Filtrar por ID del paciente"),
      session_id: z.string().optional().describe("Filtrar por ID de la sesión"),
      attention_id: z.string().optional().describe("Filtrar por ID de la atención médica"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, patient_id, session_id, attention_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/checks", {
        token: token(),
        query: { from, to, limit, offset, patient_id, session_id, attention_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Attentions ---

  server.tool(
    "count_attentions",
    "Cuenta las atenciones médicas registradas en Diagnostica (el registro de que un profesional atendió a un paciente durante una videoconsulta). Soporta filtros por rango de fechas, id, estado, videoconsulta y acceso cross-brand.",
    {
      ...dateRange,
      _id: z.string().optional().describe("Filtrar por ID de la atención"),
      status: z.string().optional().describe("Filtrar por estado de la atención"),
      video_visit_id: z.string().optional().describe("Filtrar por ID de la videoconsulta durante la cual ocurrió la atención"),
      ...brandsParam,
    },
    async ({ from, to, _id, status, video_visit_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/attentions/count", {
        token: token(),
        query: { from, to, _id, status, video_visit_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_attentions",
    "Lista las atenciones médicas registradas en Diagnostica (el registro de que un profesional atendió a un paciente durante una videoconsulta). Soporta filtros por rango de fechas, id, estado, videoconsulta, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      _id: z.string().optional().describe("Filtrar por ID de la atención"),
      status: z.string().optional().describe("Filtrar por estado de la atención"),
      video_visit_id: z.string().optional().describe("Filtrar por ID de la videoconsulta durante la cual ocurrió la atención"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, _id, status, video_visit_id, brands }) => {
      const data = await backendFetch("/api/v1/analytics/attentions", {
        token: token(),
        query: { from, to, limit, offset, _id, status, video_visit_id, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Schedules  ---

  server.tool(
    "count_schedules",
    "Cuenta los horarios registrados en Diagnostica. Soporta filtros, especialidad y acceso a cross-brand",
    {
      specialty: z.string().optional().describe("Filtrar por especialidad del horario"),
      ...brandsParam,
    },
    async ({ specialty, brands }) => {
      const data = await backendFetch("/api/v1/analytics/schedules/count", {
        token: token(),
        query: { specialty, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_schedules",
    "Lista los horarios registrados en Diagnostica. Soporta filtros por rango de fecha, paginacion, especialidad y acceso a cross-brand",
    {
      ...dateRangeAndPagination,
      specialty: z.string().optional().describe("Filtrar por la especialidad del horario"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, specialty, brands }) => {
      const data = await backendFetch("/api/v1/analytics/schedules", {
        token: token(),
        query: { from, to, limit, offset, specialty, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Shared checks  ---

  server.tool(
    "count_shared_checks",
    "Cuenta los checks compartidos entre usuarios en Diagnostica. Soporta filtros por rango de fechas, user,  tipo de compartido y acceso cross-brand.",
    {
      ...dateRange,
      user: z.string().optional().describe("Filtrar por usuario al que se compartio"),
      shareType: z.string().optional().describe("Filtrar por tipo de compartido"),
      ...brandsParam,
    },
    async ({ from, to, user, shareType, brands }) => {
      const data = await backendFetch("/api/v1/analytics/shared_checks/count", {
        token: token(),
        query: { from, to, user, shareType, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_shared_checks",
    "Lista los checks compartidos entre usuarios en Diagnostica. Soporta filtros por rango de fechas, user, tipo de compartido, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      user: z.string().optional().describe("Filtrar por usuario al que se compartio"),
      shareType: z.string().optional().describe("Filtrar por tipo de compartido"),
      ...brandsParam,
    },
    async ({ from, to, limit, offset, user, shareType, brands }) => {
      const data = await backendFetch("/api/v1/analytics/shared_checks", {
        token: token(),
        query: { from, to, limit, offset, user, shareType, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Records  ---

  server.tool(
    "count_records",
    "Cuenta los registros de documentación clínica (records) en Diagnostica. Soporta filtros por rango de fechas y acceso cross-brand.",
    {
      ...dateRange,
      ...brandsParam,
    },
    async ({ from, to, brands }) => {
      const data = await backendFetch("/api/v1/analytics/records/count", {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { from, to, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "list_records",
    "Lista los registros de documentación clínica (records) en Diagnostica. Soporta filtros por rango de fechas, paginación y acceso cross-brand.",
    {
      ...dateRangeAndPagination,
      ...brandsParam,
    },
    async ({ from, to, limit, offset, brands }) => {
      const data = await backendFetch("/api/v1/analytics/records", {
        token: token(), brandId: brandId(), backendUrl: backendUrl(),
        query: { from, to, limit, offset, brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- Roles  ---

  server.tool(
    "list_roles",
    "Lista los roles del sistema y sus permisos. Es un catálogo de referencia chico y fijo — no soporta paginación ni filtros de fecha.",
    {
      ...brandsParam,
    },
    async ({ brands }) => {
      const data = await backendFetch("/api/v1/analytics/roles", {
        token: token(),
        query: { brands },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

}

// Datos de prueba que reflejan las relaciones reales de diagrama-relaciones-db.pdf.
// Las entidades tachadas en el diagrama (SECRETCODE, EXTERNALRESULTSACCESS, CHECKINQUEUE,
// INSTITUTION, FINANCIER) no se modelan acá — están fuera de alcance.
//
// El mock nunca filtra datos personales (name/lastName quedan en patients y en algunos users
// a propósito): ese filtrado lo hace el MCP (omitSensitiveFields en analytics.ts), no el backend.
// Si el mock ya los sacara, no podríamos comprobar que el filtrado del MCP funciona de verdad.

const BRAND_ID = '61866334643609b69b8b6c48';

const brands = [{ brandId: BRAND_ID, name: 'Diagnostica (mock)' }];

// --- Catálogos chicos: nada los consulta todavía por endpoint propio, solo dan
// consistencia a los IDs que aparecen referenciados en schedule/appointment.
const SCHEDULES = {
  cardio:    { _id: 'sch1', institution: 'inst_placeholder', specialty: 'Cardiología' },
  clinica:   { _id: 'sch2', institution: 'inst_placeholder', specialty: 'Clínica Médica' },
  neuro:     { _id: 'sch3', institution: 'inst_placeholder', specialty: 'Neurología' },
  pediatria: { _id: 'sch4', institution: 'inst_placeholder', specialty: 'Pediatría' },
  traumato:  { _id: 'sch5', institution: 'inst_placeholder', specialty: 'Traumatología' },
};
const schedules = Object.values(SCHEDULES);

const telemedicineProviders = [
  { _id: 'tp1', idName: 'video-provider-a', connectionData: { region: 'sa-east-1' } },
  { _id: 'tp2', idName: 'video-provider-b', connectionData: { region: 'sa-east-1' } },
];

// --- Pacientes (PATIENT) ---
const patients = [
  { _id: 'p1',  id_type: 'DNI', id_value: '30111222', external_id: 'ext-p1',  external_system: 'legacy', name: 'Carlos',    lastName: 'Sánchez',  origin: 'web',       createdAt: '2024-01-05' },
  { _id: 'p2',  id_type: 'DNI', id_value: '30222333', external_id: 'ext-p2',  external_system: 'legacy', name: 'Ana',       lastName: 'Martínez', origin: 'derivado',  createdAt: '2024-01-10' },
  { _id: 'p3',  id_type: 'DNI', id_value: '30333444', external_id: 'ext-p3',  external_system: 'legacy', name: 'Pablo',     lastName: 'González', origin: 'web',       createdAt: '2024-02-03' },
  { _id: 'p4',  id_type: 'DNI', id_value: '30444555', external_id: 'ext-p4',  external_system: 'legacy', name: 'Sofía',     lastName: 'López',    origin: 'mostrador', createdAt: '2024-02-14' },
  { _id: 'p5',  id_type: 'DNI', id_value: '30555666', external_id: 'ext-p5',  external_system: 'legacy', name: 'Juan',      lastName: 'Ramírez',  origin: 'web',       createdAt: '2024-03-01' },
  { _id: 'p6',  id_type: 'DNI', id_value: '30666777', external_id: 'ext-p6',  external_system: 'legacy', name: 'María',     lastName: 'Torres',   origin: 'derivado',  createdAt: '2024-03-15' },
  { _id: 'p7',  id_type: 'DNI', id_value: '30777888', external_id: 'ext-p7',  external_system: 'legacy', name: 'Lucas',     lastName: 'Díaz',     origin: 'web',       createdAt: '2024-04-02' },
  { _id: 'p8',  id_type: 'DNI', id_value: '30888999', external_id: 'ext-p8',  external_system: 'legacy', name: 'Camila',    lastName: 'Ruiz',     origin: 'mostrador', createdAt: '2024-04-20' },
  { _id: 'p9',  id_type: 'DNI', id_value: '30999000', external_id: 'ext-p9',  external_system: 'legacy', name: 'Tomás',     lastName: 'Herrera',  origin: 'web',       createdAt: '2024-05-05' },
  { _id: 'p10', id_type: 'DNI', id_value: '30100111', external_id: 'ext-p10', external_system: 'legacy', name: 'Florencia', lastName: 'Acosta',   origin: 'derivado',  createdAt: '2024-05-18' },
];

// --- Usuarios (USER): médicos, operadores, y cuentas de pacientes logueados.
// Facu confirmó que el personal (medico/operador) NO es anónimo — su name/lastName debe
// mostrarse. Solo las cuentas ligadas a un paciente (patient seteado) se anonimizan.
// u_pat1/u_pat2 tienen name/lastName a propósito, para poder probar que en esos casos SÍ
// se ocultan (a diferencia del personal).
const users = [
  { _id: 'u_med1', role: 'medico',    roles: ['medico'],    profession: 'medicina',       language: 'lang_es', name: 'Martín',    lastName: 'Rodríguez', createdAt: '2023-11-01' },
  { _id: 'u_med2', role: 'medico',    roles: ['medico'],    profession: 'medicina',       language: 'lang_es', name: 'Laura',     lastName: 'Fernández', createdAt: '2023-11-01' },
  { _id: 'u_med3', role: 'medico',    roles: ['medico'],    profession: 'medicina',       language: 'lang_es', name: 'Sebastián', lastName: 'Gómez',     createdAt: '2023-11-01' },
  { _id: 'u_med4', role: 'medico',    roles: ['medico'],    profession: 'medicina',       language: 'lang_es', name: 'Valentina', lastName: 'Pereyra',   createdAt: '2023-11-01' },
  { _id: 'u_med5', role: 'medico',    roles: ['medico'],    profession: 'medicina',       language: 'lang_es', name: 'Diego',     lastName: 'Morales',   createdAt: '2023-11-01' },
  { _id: 'u_op1',  role: 'operador',  roles: ['operador'],  profession: 'administracion', language: 'lang_es', name: 'Noelia',    lastName: 'Suárez',    createdAt: '2023-11-05' },
  { _id: 'u_op2',  role: 'operador',  roles: ['operador'],  profession: 'administracion', language: 'lang_es', name: 'Ezequiel',  lastName: 'Paz',       createdAt: '2023-11-05' },
  { _id: 'u_pat1', role: 'paciente',  roles: ['paciente'],  patient: 'p1', name: 'Carlos', lastName: 'Sánchez',  kioskId: 'kiosk1', lastVisitedSchedule: 'sch1', language: 'lang_es', createdAt: '2024-01-05' },
  { _id: 'u_pat2', role: 'paciente',  roles: ['paciente'],  patient: 'p2', name: 'Ana',    lastName: 'Martínez', kioskId: 'kiosk1', lastVisitedSchedule: 'sch2', language: 'lang_es', createdAt: '2024-01-10' },
  { _id: 'u_pat4', role: 'paciente',  roles: ['paciente'],  patient: 'p4', relatives: ['p10'], kioskId: 'kiosk2', lastVisitedSchedule: 'sch4', language: 'lang_es', createdAt: '2024-02-14' },
  { _id: 'u_pat5', role: 'paciente',  roles: ['paciente'],  patient: 'p5',                kioskId: 'kiosk2', lastVisitedSchedule: 'sch1', language: 'lang_es', createdAt: '2024-03-01' },
];

// --- Turnos (APPOINTMENT). El endpoint de appointments filtra por el campo 'date'
// (no lo tocamos hoy), así que el fixture usa 'date', no 'createdAt'.
// Sin financier: FINANCIER es una entidad tachada por Facu en el diagrama (fuera de
// alcance), así que tampoco se modela como snapshot embebido acá.
const appointments = [
  { _id: 'ap1',  patient: 'p1',  schedule: SCHEDULES.cardio._id,    scheduledVideovisits: ['vv1'],  type: 'consulta', status: 'realizado', date: '2024-01-08' },
  { _id: 'ap2',  patient: 'p2',  schedule: SCHEDULES.clinica._id,   scheduledVideovisits: ['vv2'],  type: 'control',   status: 'realizado', date: '2024-01-15' },
  { _id: 'ap3',  patient: 'p3',  schedule: SCHEDULES.neuro._id,     scheduledVideovisits: [],       type: 'consulta', status: 'realizado', date: '2024-02-05' },
  { _id: 'ap4',  patient: 'p4',  schedule: SCHEDULES.pediatria._id, scheduledVideovisits: ['vv4'],  type: 'consulta', status: 'realizado', date: '2024-02-20' },
  { _id: 'ap5',  patient: 'p5',  schedule: SCHEDULES.cardio._id,    scheduledVideovisits: ['vv5'],  type: 'control',   status: 'realizado', date: '2024-03-03' },
  { _id: 'ap6',  patient: 'p6',  schedule: SCHEDULES.clinica._id,   scheduledVideovisits: ['vv6'],  type: 'consulta', status: 'realizado', date: '2024-03-18' },
  { _id: 'ap7',  patient: 'p7',  schedule: SCHEDULES.neuro._id,     scheduledVideovisits: [],       type: 'consulta', status: 'cancelado', date: '2024-04-07' },
  { _id: 'ap8',  patient: 'p8',  schedule: SCHEDULES.traumato._id,  scheduledVideovisits: ['vv8'],  type: 'consulta', status: 'realizado', date: '2024-04-22' },
  { _id: 'ap9',  patient: 'p9',  schedule: SCHEDULES.cardio._id,    scheduledVideovisits: ['vv9'],  type: 'control',   status: 'realizado', date: '2024-05-10' },
  { _id: 'ap10', patient: 'p10', schedule: SCHEDULES.pediatria._id, scheduledVideovisits: ['vv10'], type: 'consulta', status: 'realizado', date: '2024-05-25' },
];

// --- Sesiones (SESSION). s3 es presencial y no genera rastro clínico digital (sin
// videovisit/attention/exam/check) — caso real de borde. p7 no tiene sesión: el turno
// se canceló antes de llegar a esta instancia.
const sessions = [
  { _id: 's1',  user: 'u_pat1', patient: 'p1',  operator: 'u_op1', appointment: 'ap1',  kiosk: 'kiosk1', assistant: 'asst1', type: 'virtual',    status: 'cerrada', date: '2024-01-08' },
  { _id: 's2',  user: 'u_pat2', patient: 'p2',  operator: 'u_op2', appointment: 'ap2',  kiosk: 'kiosk1', assistant: 'asst1', type: 'virtual',    status: 'cerrada', date: '2024-01-15' },
  { _id: 's3',  user: null,     patient: 'p3',  operator: 'u_op1', appointment: 'ap3',  kiosk: 'kiosk2', assistant: null,    type: 'presencial', status: 'cerrada', date: '2024-02-05' },
  { _id: 's4',  user: 'u_pat4', patient: 'p4',  operator: 'u_op2', appointment: 'ap4',  kiosk: 'kiosk2', assistant: 'asst1', type: 'virtual',    status: 'cerrada', date: '2024-02-20' },
  { _id: 's5',  user: 'u_pat5', patient: 'p5',  operator: 'u_op1', appointment: 'ap5',  kiosk: 'kiosk1', assistant: 'asst1', type: 'virtual',    status: 'activa',  date: '2024-06-20' },
  { _id: 's6',  user: null,     patient: 'p6',  operator: 'u_op2', appointment: 'ap6',  kiosk: 'kiosk1', assistant: 'asst1', type: 'virtual',    status: 'cerrada', date: '2024-03-18' },
  { _id: 's8',  user: null,     patient: 'p8',  operator: 'u_op1', appointment: 'ap8',  kiosk: 'kiosk2', assistant: 'asst1', type: 'virtual',    status: 'cerrada', date: '2024-04-22' },
  { _id: 's9',  user: null,     patient: 'p9',  operator: 'u_op2', appointment: 'ap9',  kiosk: 'kiosk1', assistant: 'asst1', type: 'virtual',    status: 'cerrada', date: '2024-05-10' },
  { _id: 's10', user: null,     patient: 'p10', operator: 'u_op1', appointment: 'ap10', kiosk: 'kiosk2', assistant: 'asst1', type: 'virtual',    status: 'cerrada', date: '2024-05-25' },
];

// --- Videoconsultas (VIDEOVISIT). appointment y specialty confirmados por Facu con un
// ejemplo real (VIDEOVISIT.appointment es una FK real de vuelta a APPOINTMENT, no solo
// APPOINTMENT.scheduledVideovisits[] hacia acá — es de doble sentido).
// Sin financier: FINANCIER es una entidad tachada por Facu en el diagrama (fuera de
// alcance), así que tampoco se modela como snapshot embebido acá.
const videovisits = [
  { _id: 'vv1',  session: 's1',  patient: 'p1',  appointment: 'ap1',  specialty: 'Cardiología',     provider: 'tp1', status: 'finalizada', date: '2024-01-08' },
  { _id: 'vv2',  session: 's2',  patient: 'p2',  appointment: 'ap2',  specialty: 'Clínica Médica',  provider: 'tp1', status: 'finalizada', date: '2024-01-15' },
  { _id: 'vv4',  session: 's4',  patient: 'p4',  appointment: 'ap4',  specialty: 'Pediatría',       provider: 'tp2', status: 'finalizada', date: '2024-02-20' },
  { _id: 'vv5',  session: 's5',  patient: 'p5',  appointment: 'ap5',  specialty: 'Cardiología',     provider: 'tp1', status: 'en_curso',   date: '2024-06-20' },
  { _id: 'vv6',  session: 's6',  patient: 'p6',  appointment: 'ap6',  specialty: 'Clínica Médica',  provider: 'tp1', status: 'finalizada', date: '2024-03-18' },
  { _id: 'vv8',  session: 's8',  patient: 'p8',  appointment: 'ap8',  specialty: 'Traumatología',   provider: 'tp2', status: 'finalizada', date: '2024-04-22' },
  { _id: 'vv9',  session: 's9',  patient: 'p9',  appointment: 'ap9',  specialty: 'Cardiología',     provider: 'tp1', status: 'finalizada', date: '2024-05-10' },
  { _id: 'vv10', session: 's10', patient: 'p10', appointment: 'ap10', specialty: 'Pediatría',       provider: 'tp2', status: 'finalizada', date: '2024-05-25' },
];

// --- Kioscos (KIOSK). kiosk1 tiene una sesión en curso (s5, activa desde 2024-06-20) —
// por eso connected:true y lastDisconnected queda en su sesión anterior (s9, 2024-05-10),
// todavía no se desconectó desde que arrancó la actual. kiosk2 está libre: su última
// sesión (s10) cerró el 2024-05-25, así que se conectó y desconectó ese mismo día.
// No existe un único campo "lastUsedAt" en el real: son connected/lastConnected/
// lastDisconnected por separado, confirmado por Facu con un ejemplo real.
const kiosks = [
  { _id: 'kiosk1', currentSession: 's5',  activeLoginUser: 'u_pat5', lastTakeoverAttemptUser: 'u_op1', status: 'ocupado', type: 'autoservicio', connected: true,  lastConnected: '2024-06-20', lastDisconnected: '2024-05-10' },
  { _id: 'kiosk2', currentSession: null, activeLoginUser: null,     lastTakeoverAttemptUser: null,     status: 'libre',   type: 'autoservicio', connected: false, lastConnected: '2024-05-25', lastDisconnected: '2024-05-25' },
];

function history(date, finalStatus) {
  return [
    { status: 'esperando', at: `${date}T10:00:00Z` },
    { status: 'en_curso',  at: `${date}T10:05:00Z` },
    ...(finalStatus === 'en_curso' ? [] : [{ status: finalStatus, at: `${date}T10:20:00Z` }]),
  ];
}

// --- Atenciones médicas (ATTENTION). Martín Rodríguez aparece en 3 (att1, att5, att9)
// a propósito, para poder probar preguntas de agregación tipo "qué médico atendió más".
const attentions = [
  { _id: 'att1',  videoVisit: 'vv1',  professional: { name: 'Martín Rodríguez',  specialty: 'Cardiología' },     stateHistory: history('2024-01-08', 'finalizada'), status: 'finalizada', date: '2024-01-08' },
  { _id: 'att2',  videoVisit: 'vv2',  professional: { name: 'Laura Fernández',   specialty: 'Clínica Médica' },  stateHistory: history('2024-01-15', 'finalizada'), status: 'finalizada', date: '2024-01-15' },
  { _id: 'att4',  videoVisit: 'vv4',  professional: { name: 'Valentina Pereyra', specialty: 'Pediatría' },       stateHistory: history('2024-02-20', 'finalizada'), status: 'finalizada', date: '2024-02-20' },
  { _id: 'att5',  videoVisit: 'vv5',  professional: { name: 'Martín Rodríguez',  specialty: 'Cardiología' },     stateHistory: history('2024-06-20', 'en_curso'),   status: 'en_curso',   date: '2024-06-20' },
  { _id: 'att6',  videoVisit: 'vv6',  professional: { name: 'Laura Fernández',   specialty: 'Clínica Médica' },  stateHistory: history('2024-03-18', 'finalizada'), status: 'finalizada', date: '2024-03-18' },
  { _id: 'att8',  videoVisit: 'vv8',  professional: { name: 'Diego Morales',     specialty: 'Traumatología' },   stateHistory: history('2024-04-22', 'finalizada'), status: 'finalizada', date: '2024-04-22' },
  { _id: 'att9',  videoVisit: 'vv9',  professional: { name: 'Martín Rodríguez',  specialty: 'Cardiología' },     stateHistory: history('2024-05-10', 'finalizada'), status: 'finalizada', date: '2024-05-10' },
  { _id: 'att10', videoVisit: 'vv10', professional: { name: 'Valentina Pereyra', specialty: 'Pediatría' },       stateHistory: history('2024-05-25', 'finalizada'), status: 'finalizada', date: '2024-05-25' },
];

// --- Exámenes (EXAM). Se mantiene device_type (lo que hoy filtra count_exams/list_exams)
// y se suma device_id (lo que realmente muestra el diagrama) sin sacar el primero —
// ese desalineamiento entre diagrama y tool ya lo habíamos marcado como pendiente de revisar.
const exams = [
  { _id: 'e1', records: ['rec1'], attentionId: 'att1',  device_id: 'dev-ecg-01', device_type: 'electrocardiógrafo', exam_type: 'ECG',           date: '2024-01-08' },
  { _id: 'e2', records: ['rec2'], attentionId: 'att1',  device_id: 'dev-lab-01', device_type: 'analizador',         exam_type: 'Laboratorio',    date: '2024-01-08' },
  { _id: 'e3', records: [], attentionId: 'att2',  device_id: 'dev-lab-01', device_type: 'analizador',         exam_type: 'Laboratorio',    date: '2024-01-15' },
  { _id: 'e4', records: [], attentionId: 'att4',  device_id: 'dev-eco-01', device_type: 'ecógrafo',           exam_type: 'Ecocardiograma', date: '2024-02-20' },
  { _id: 'e5', records: [], attentionId: 'att5',  device_id: 'dev-ecg-01', device_type: 'electrocardiógrafo', exam_type: 'ECG',           date: '2024-06-20' },
  { _id: 'e6', records: [], attentionId: 'att6',  device_id: 'dev-lab-01', device_type: 'analizador',         exam_type: 'Laboratorio',    date: '2024-03-18' },
  { _id: 'e7', records: [], attentionId: 'att8',  device_id: 'dev-rx-01',  device_type: 'rayos_x',            exam_type: 'RX Tórax',       date: '2024-04-22' },
  { _id: 'e8', records: [], attentionId: 'att9',  device_id: 'dev-ecg-01', device_type: 'electrocardiógrafo', exam_type: 'ECG',           date: '2024-05-10' },
  { _id: 'e9', records: [], attentionId: 'att10', device_id: 'dev-lab-01', device_type: 'analizador',         exam_type: 'Laboratorio',    date: '2024-05-25' },
];

// --- Checks. s5 (en curso) y s3 (presencial) quedan sin check a propósito —
// casos de borde reales para probar filtros que deben devolver vacío.
const checks = [
  { _id: 'c1',  session: 's1',  patient: 'p1',  exams: ['e1', 'e2'], attention: 'att1',  endDate: '2024-01-08' },
  { _id: 'c2',  session: 's2',  patient: 'p2',  exams: ['e3'],       attention: 'att2',  endDate: '2024-01-15' },
  { _id: 'c4',  session: 's4',  patient: 'p4',  exams: ['e4'],       attention: 'att4',  endDate: '2024-02-20' },
  { _id: 'c6',  session: 's6',  patient: 'p6',  exams: ['e6'],       attention: 'att6',  endDate: '2024-03-18' },
  { _id: 'c8',  session: 's8',  patient: 'p8',  exams: ['e7'],       attention: 'att8',  endDate: '2024-04-22' },
  { _id: 'c9',  session: 's9',  patient: 'p9',  exams: ['e8'],       attention: 'att9',  endDate: '2024-05-10' },
  { _id: 'c10', session: 's10', patient: 'p10', exams: ['e9'],       attention: 'att10', endDate: '2024-05-25' },
];

// --- Roles (catálogo de referencia, copiado de la rama gabri) ---
const roles = [
  { _id: 'role_medico',        name: 'medico',        permissions: ['ver_pacientes', 'crear_atencion', 'cerrar_check'] },
  { _id: 'role_operador',      name: 'operador',       permissions: ['operar_kiosko', 'takeover_remoto'] },
  { _id: 'role_paciente',      name: 'paciente',       permissions: ['ver_propio_historial'] },
  { _id: 'role_gerente',       name: 'gerente',        permissions: ['ver_reportes', 'cross_brand'] },
  { _id: 'role_administrativo', name: 'administrativo', permissions: ['gestionar_turnos'] },
];

// --- Records (documentación clínica dentro de un EXAM). rec1/rec2 están linkeados
// desde e1/e2 para que list_records tenga con qué probarse de forma consistente.
const records = [
  { _id: 'rec1', tracks: ['trk1'], comments: ['com1'], date: '2024-01-08' },
  { _id: 'rec2', tracks: ['trk2'], comments: [],        date: '2024-01-08' },
];

// --- Shared checks (un CHECK compartido con otro usuario) ---
const sharedChecks = [
  { _id: 'sc1', user: 'u_med2', check: 'c1', session: 's1', shareType: 'ver_resultado', date: '2024-01-09' },
  { _id: 'sc2', user: 'u_op1',  check: 'c9', session: 's9', shareType: 'ver_resultado', date: '2024-05-11' },
];

module.exports = {
  BRAND_ID,
  brands,
  schedules,
  telemedicineProviders,
  patients,
  users,
  kiosks,
  appointments,
  sessions,
  videovisits,
  attentions,
  exams,
  checks,
  roles,
  records,
  sharedChecks,
};

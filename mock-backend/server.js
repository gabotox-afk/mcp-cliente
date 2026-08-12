const express = require('express');
const app = express();
const PORT = 4000;

app.use(express.json());

// CORS: la página de la empresa corre en otro puerto y llama a este backend
// desde el navegador para hacer el login, igual que en producción. En un
// backend real esto sería una lista blanca de dominios, no '*'.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Datos de prueba (ver fixtures.js — reflejan diagrama-relaciones-db.pdf)
// ---------------------------------------------------------------------------

const {
  brands, patients, users, kiosks, appointments, sessions, videovisits, attentions, exams, checks,
  schedules, roles, records, sharedChecks,
} = require('./fixtures');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterByDate(items, from, to, dateField = 'date') {
  return items.filter(item => {
    const d = item[dateField];
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

function paginate(items, limit, offset) {
  const off = parseInt(offset) || 0;
  const lim = parseInt(limit)  || items.length;
  return items.slice(off, off + lim);
}

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || !auth.slice(7).trim()) {
    return res.status(401).json({ success: false, message: 'Token requerido' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Mapea refreshToken -> { email, role, brandId }, en memoria (alcanza para
// pruebas locales — se pierde al reiniciar el mock, igual que los codes/clients
// OAuth en Redis se pierden si se reinicia Redis).
const refreshTokens = new Map();

function issueTokenPair(email, role, brandId) {
  const token = Buffer.from(JSON.stringify({ email, role, brandId })).toString('base64');
  const refreshToken = Buffer.from(JSON.stringify({ email, role, brandId, r: Math.random() })).toString('base64');
  refreshTokens.set(refreshToken, { email, role, brandId });
  return { token, refreshToken };
}

app.post('/users/login', (req, res) => {
  const { email, password, brandId } = req.body;
  // Usuarios de prueba
  const users = [
    { email: 'admin@diagnostica.com', password: '1234', role: 'gerente'       },
    { email: 'medico@diagnostica.com', password: '1234', role: 'doctor'        },
    { email: 'admin2@diagnostica.com', password: '1234', role: 'administrativo'},
  ];
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) {
    return res.json({ success: false, message: 'Credenciales inválidas' });
  }
  // Token falso pero funcional para pruebas
  const { token, refreshToken } = issueTokenPair(email, user.role, brandId);
  res.json({ success: true, token, refreshToken });
});

app.post('/users/multi_refresh_token', (req, res) => {
  const { refreshToken } = req.body;
  const entry = refreshTokens.get(refreshToken);
  if (!entry) {
    return res.json({ success: false, message: 'Refresh token inválido' });
  }
  refreshTokens.delete(refreshToken);
  const { token, refreshToken: newRefreshToken } = issueTokenPair(entry.email, entry.role, entry.brandId);
  res.json({ success: true, token, refreshToken: newRefreshToken });
});

// ---------------------------------------------------------------------------
// Analytics — Brands (stub simple, el mock solo tiene una marca de datos)
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/brands', requireAuth, (req, res) => {
  res.json({ data: brands });
});

// ---------------------------------------------------------------------------
// Analytics — Sessions
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/sessions/count', requireAuth, (req, res) => {
  const { from, to, _id, status, type, patient_id, user_id, operator_id, appointment_id, kiosk_id } = req.query;
  let items = filterByDate(sessions, from, to);
  if (_id)            items = items.filter(s => s._id === _id);
  if (status)         items = items.filter(s => s.status === status);
  if (type)           items = items.filter(s => s.type === type);
  if (patient_id)     items = items.filter(s => s.patient === patient_id);
  if (user_id)        items = items.filter(s => s.user === user_id);
  if (operator_id)    items = items.filter(s => s.operator === operator_id);
  if (appointment_id) items = items.filter(s => s.appointment === appointment_id);
  if (kiosk_id)       items = items.filter(s => s.kiosk === kiosk_id);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/sessions', requireAuth, (req, res) => {
  const { from, to, _id, status, type, patient_id, user_id, operator_id, appointment_id, kiosk_id, limit, offset } = req.query;
  let items = filterByDate(sessions, from, to);
  if (_id)            items = items.filter(s => s._id === _id);
  if (status)         items = items.filter(s => s.status === status);
  if (type)           items = items.filter(s => s.type === type);
  if (patient_id)     items = items.filter(s => s.patient === patient_id);
  if (user_id)        items = items.filter(s => s.user === user_id);
  if (operator_id)    items = items.filter(s => s.operator === operator_id);
  if (appointment_id) items = items.filter(s => s.appointment === appointment_id);
  if (kiosk_id)       items = items.filter(s => s.kiosk === kiosk_id);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Patients
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/patients/count', requireAuth, (req, res) => {
  const { from, to, _id, origin } = req.query;
  let items = filterByDate(patients, from, to, 'createdAt');
  if (_id)    items = items.filter(p => p._id    === _id);
  if (origin) items = items.filter(p => p.origin === origin);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/patients/:id', requireAuth, (req, res) => {
  const patient = patients.find(p => p._id === req.params.id);
  if (!patient) return res.status(404).json({ success: false, message: 'Paciente no encontrado' });
  // El mock devuelve el registro completo (con name/lastName incluidos) a propósito:
  // el filtrado de datos personales lo hace el MCP (omitSensitiveFields), no el backend.
  res.json({ success: true, data: patient });
});

app.get('/api/v1/analytics/patients', requireAuth, (req, res) => {
  const { from, to, _id, origin, limit, offset } = req.query;
  let items = filterByDate(patients, from, to, 'createdAt');
  if (_id)    items = items.filter(p => p._id    === _id);
  if (origin) items = items.filter(p => p.origin === origin);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Users
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/users/count', requireAuth, (req, res) => {
  const { from, to, _id, role, patient_id, kiosk_id } = req.query;
  let items = filterByDate(users, from, to, 'createdAt');
  if (_id)        items = items.filter(u => u._id === _id);
  if (role)       items = items.filter(u => u.role === role);
  if (patient_id) items = items.filter(u => u.patient === patient_id);
  if (kiosk_id)   items = items.filter(u => u.kioskId === kiosk_id);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/users/:id', requireAuth, (req, res) => {
  const user = users.find(u => u._id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
  // Igual que patients: el registro va completo, el MCP filtra los datos personales.
  res.json({ success: true, data: user });
});

app.get('/api/v1/analytics/users', requireAuth, (req, res) => {
  const { from, to, _id, role, patient_id, kiosk_id, limit, offset } = req.query;
  let items = filterByDate(users, from, to, 'createdAt');
  if (_id)        items = items.filter(u => u._id === _id);
  if (role)       items = items.filter(u => u.role === role);
  if (patient_id) items = items.filter(u => u.patient === patient_id);
  if (kiosk_id)   items = items.filter(u => u.kioskId === kiosk_id);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Kiosks
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/kiosks/count', requireAuth, (req, res) => {
  const { from, to, _id, status, type, connected, current_session_id, active_login_user_id, last_takeover_attempt_user_id } = req.query;
  let items = filterByDate(kiosks, from, to, 'lastDisconnected');
  if (_id)                          items = items.filter(k => k._id === _id);
  if (status)                       items = items.filter(k => k.status === status);
  if (type)                         items = items.filter(k => k.type === type);
  if (connected !== undefined)      items = items.filter(k => k.connected === (connected === 'true'));
  if (current_session_id)           items = items.filter(k => k.currentSession === current_session_id);
  if (active_login_user_id)         items = items.filter(k => k.activeLoginUser === active_login_user_id);
  if (last_takeover_attempt_user_id) items = items.filter(k => k.lastTakeoverAttemptUser === last_takeover_attempt_user_id);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/kiosks', requireAuth, (req, res) => {
  const { from, to, _id, status, type, connected, current_session_id, active_login_user_id, last_takeover_attempt_user_id, limit, offset } = req.query;
  let items = filterByDate(kiosks, from, to, 'lastDisconnected');
  if (_id)                          items = items.filter(k => k._id === _id);
  if (status)                       items = items.filter(k => k.status === status);
  if (type)                         items = items.filter(k => k.type === type);
  if (connected !== undefined)      items = items.filter(k => k.connected === (connected === 'true'));
  if (current_session_id)           items = items.filter(k => k.currentSession === current_session_id);
  if (active_login_user_id)         items = items.filter(k => k.activeLoginUser === active_login_user_id);
  if (last_takeover_attempt_user_id) items = items.filter(k => k.lastTakeoverAttemptUser === last_takeover_attempt_user_id);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Appointments
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/appointments/count', requireAuth, (req, res) => {
  const { from, to, status, type, patient_id, videovisit_id } = req.query;
  let items = filterByDate(appointments, from, to);
  if (status)        items = items.filter(a => a.status === status);
  if (type)          items = items.filter(a => a.type   === type);
  if (patient_id)    items = items.filter(a => a.patient === patient_id);
  if (videovisit_id) items = items.filter(a => Array.isArray(a.scheduledVideovisits) && a.scheduledVideovisits.includes(videovisit_id));
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/appointments', requireAuth, (req, res) => {
  const { from, to, status, type, patient_id, videovisit_id, limit, offset } = req.query;
  let items = filterByDate(appointments, from, to);
  if (status)        items = items.filter(a => a.status === status);
  if (type)          items = items.filter(a => a.type   === type);
  if (patient_id)    items = items.filter(a => a.patient === patient_id);
  if (videovisit_id) items = items.filter(a => Array.isArray(a.scheduledVideovisits) && a.scheduledVideovisits.includes(videovisit_id));
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Videovisits
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/videovisits/count', requireAuth, (req, res) => {
  const { from, to, _id, status, session_id, patient_id, appointment_id, specialty } = req.query;
  let items = filterByDate(videovisits, from, to);
  if (_id)            items = items.filter(v => v._id === _id);
  if (status)         items = items.filter(v => v.status === status);
  if (session_id)     items = items.filter(v => v.session === session_id);
  if (patient_id)     items = items.filter(v => v.patient === patient_id);
  if (appointment_id) items = items.filter(v => v.appointment === appointment_id);
  if (specialty)       items = items.filter(v => v.specialty === specialty);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/videovisits', requireAuth, (req, res) => {
  const { from, to, _id, status, session_id, patient_id, appointment_id, specialty, limit, offset } = req.query;
  let items = filterByDate(videovisits, from, to);
  if (_id)            items = items.filter(v => v._id === _id);
  if (status)         items = items.filter(v => v.status === status);
  if (session_id)     items = items.filter(v => v.session === session_id);
  if (patient_id)     items = items.filter(v => v.patient === patient_id);
  if (appointment_id) items = items.filter(v => v.appointment === appointment_id);
  if (specialty)       items = items.filter(v => v.specialty === specialty);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Exams
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/exams/count', requireAuth, (req, res) => {
  const { from, to, _id, exam_type, device_type } = req.query;
  let items = filterByDate(exams, from, to);
  if (_id)         items = items.filter(e => e._id === _id);
  if (exam_type)   items = items.filter(e => e.exam_type   === exam_type);
  if (device_type) items = items.filter(e => e.device_type === device_type);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/exams', requireAuth, (req, res) => {
  const { from, to, _id, exam_type, device_type, limit, offset } = req.query;
  let items = filterByDate(exams, from, to);
  if (_id)         items = items.filter(e => e._id === _id);
  if (exam_type)   items = items.filter(e => e.exam_type   === exam_type);
  if (device_type) items = items.filter(e => e.device_type === device_type);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Checks
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/checks/count', requireAuth, (req, res) => {
  const { from, to, patient_id, session_id, attention_id } = req.query;
  let items = filterByDate(checks, from, to, 'endDate');
  if (patient_id)   items = items.filter(c => c.patient === patient_id);
  if (session_id)   items = items.filter(c => c.session === session_id);
  if (attention_id) items = items.filter(c => c.attention === attention_id);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/checks', requireAuth, (req, res) => {
  const { from, to, patient_id, session_id, attention_id, limit, offset } = req.query;
  let items = filterByDate(checks, from, to, 'endDate');
  if (patient_id)   items = items.filter(c => c.patient === patient_id);
  if (session_id)   items = items.filter(c => c.session === session_id);
  if (attention_id) items = items.filter(c => c.attention === attention_id);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Attentions
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/attentions/count', requireAuth, (req, res) => {
  const { from, to, _id, status, video_visit_id } = req.query;
  let items = filterByDate(attentions, from, to);
  if (_id)            items = items.filter(a => a._id === _id);
  if (status)         items = items.filter(a => a.status === status);
  if (video_visit_id) items = items.filter(a => a.videoVisit === video_visit_id);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/attentions', requireAuth, (req, res) => {
  const { from, to, _id, status, video_visit_id, limit, offset } = req.query;
  let items = filterByDate(attentions, from, to);
  if (_id)            items = items.filter(a => a._id === _id);
  if (status)         items = items.filter(a => a.status === status);
  if (video_visit_id) items = items.filter(a => a.videoVisit === video_visit_id);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Schedules (copiado de la rama gabri)
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/schedules/count', requireAuth, (req, res) => {
  const { specialty } = req.query;
  let items = schedules;
  if (specialty) items = items.filter(s => s.specialty === specialty);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/schedules', requireAuth, (req, res) => {
  const { specialty, limit, offset } = req.query;
  let items = schedules;
  if (specialty) items = items.filter(s => s.specialty === specialty);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Shared checks (copiado de la rama gabri)
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/shared_checks/count', requireAuth, (req, res) => {
  const { from, to, user, shareType } = req.query;
  let items = filterByDate(sharedChecks, from, to);
  if (user)      items = items.filter(s => s.user === user);
  if (shareType) items = items.filter(s => s.shareType === shareType);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/shared_checks', requireAuth, (req, res) => {
  const { from, to, user, shareType, limit, offset } = req.query;
  let items = filterByDate(sharedChecks, from, to);
  if (user)      items = items.filter(s => s.user === user);
  if (shareType) items = items.filter(s => s.shareType === shareType);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Records (copiado de la rama gabri)
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/records/count', requireAuth, (req, res) => {
  const { from, to } = req.query;
  const items = filterByDate(records, from, to);
  res.json({ count: items.length });
});

app.get('/api/v1/analytics/records', requireAuth, (req, res) => {
  const { from, to, limit, offset } = req.query;
  let items = filterByDate(records, from, to);
  const total = items.length;
  items = paginate(items, limit, offset);
  res.json({ total, data: items });
});

// ---------------------------------------------------------------------------
// Analytics — Roles (catálogo de referencia, copiado de la rama gabri)
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/roles', requireAuth, (req, res) => {
  res.json({ total: roles.length, data: roles });
});

// ---------------------------------------------------------------------------
// Analytics — Charts (el backend recibe datos y genera el HTML del gráfico)
// ---------------------------------------------------------------------------

const CHART_TYPES = ['line', 'bar', 'bar-horizontal', 'doughnut'];
const CHART_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#0284c7'];

function buildChartConfig(type, labels, series) {
  const gridColor = 'rgba(0,0,0,0.05)';
  const tickStyle = { font: { size: 11 }, color: '#94a3b8' };

  if (type === 'doughnut') {
    return {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data: (series[0] && series[0].data) || [], backgroundColor: CHART_COLORS, borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12, padding: 10, color: '#64748b' } } },
      },
    };
  }

  if (type === 'line') {
    return {
      type: 'line',
      data: {
        labels,
        datasets: series.map((s, i) => ({
          label: s.label,
          data: s.data,
          borderColor: CHART_COLORS[i % CHART_COLORS.length],
          backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '18',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.3,
          fill: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: series.length > 1, position: 'bottom', labels: { font: { size: 12 }, color: '#64748b' } } },
        scales: {
          x: { ticks: tickStyle, grid: { color: gridColor }, border: { display: false } },
          y: { ticks: tickStyle, grid: { color: gridColor }, border: { display: false }, beginAtZero: true },
        },
      },
    };
  }

  // bar / bar-horizontal
  return {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        backgroundColor: series.length > 1 ? CHART_COLORS[i % CHART_COLORS.length] : labels.map((_, j) => CHART_COLORS[j % CHART_COLORS.length]),
        borderRadius: 6,
        borderSkipped: false,
      })),
    },
    options: {
      indexAxis: type === 'bar-horizontal' ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: series.length > 1, position: 'bottom', labels: { font: { size: 12 }, color: '#64748b' } } },
      scales: {
        x: { ticks: tickStyle, grid: { color: gridColor }, border: { display: false } },
        y: { ticks: tickStyle, grid: { color: gridColor }, border: { display: false }, beginAtZero: true },
      },
    },
  };
}

function buildChartHTML(title, type, labels, series) {
  const config = buildChartConfig(type, labels, series);
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; }
    .page { max-width: 780px; margin: 0 auto; padding: 2rem; }
    header { background: #2563eb; color: white; padding: 1.75rem 2rem; border-radius: 12px; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: center; }
    header h1 { font-size: 1.3rem; font-weight: 700; }
    .btn { background: white; color: #2563eb; border: none; padding: .55rem 1.2rem; border-radius: 7px; font-size: .85rem; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #eff6ff; }
    .chart-box { background: white; border-radius: 10px; padding: 1.5rem; border: 1px solid #e2e8f0; }
    .chart-box > div { position: relative; height: 420px; }
    footer { text-align: center; font-size: .75rem; color: #94a3b8; padding: 1.25rem 0 .25rem; }
    @media print {
      body { background: white; }
      .page { padding: .5rem; max-width: 100%; }
      .btn { display: none; }
    }
  </style>
</head>
<body>
<div class="page">
  <header>
    <h1>${title}</h1>
    <button class="btn" onclick="window.print()">Descargar PDF</button>
  </header>
  <div class="chart-box">
    <div><canvas id="chart"></canvas></div>
  </div>
  <footer>Generado por Diagnostica Backend · ${new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })}</footer>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
  new Chart(document.getElementById('chart'), ${JSON.stringify(config)});
</script>
</body>
</html>`;
}

// Render vía QuickChart (un solo servicio cubre png, pdf y svg).
// En producción QUICKCHART_URL apuntaría a una instancia self-hosted (docker: ianw/quickchart)
// para que los datos no salgan de la infraestructura propia.
const QUICKCHART_URL = process.env.QUICKCHART_URL || 'https://quickchart.io';

async function renderQuickChart(type, labels, series, format) {
  const config = buildChartConfig(type, labels, series);
  const res = await fetch(`${QUICKCHART_URL}/chart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chart: config,
      format,
      width: 780,
      height: 420,
      backgroundColor: 'white',
      version: '4', // nuestro config usa sintaxis de Chart.js v4 (borderRadius, scales x/y, etc.)
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QuickChart respondió ${res.status}: ${text.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

app.post('/api/v1/analytics/charts', requireAuth, async (req, res) => {
  const { title, type, labels, series, format } = req.body || {};
  const fmt = format || 'html';

  if (!title || !type || !Array.isArray(labels) || labels.length === 0 || !Array.isArray(series) || series.length === 0) {
    return res.status(400).json({ success: false, message: 'Faltan campos requeridos: title, type, labels[], series[].' });
  }
  if (!CHART_TYPES.includes(type)) {
    return res.status(400).json({ success: false, message: `Tipo de gráfico inválido: "${type}". Debe ser uno de: ${CHART_TYPES.join(', ')}.` });
  }
  for (const s of series) {
    if (!s || typeof s.label !== 'string' || !Array.isArray(s.data) || s.data.length !== labels.length) {
      return res.status(400).json({ success: false, message: `La serie "${s && s.label}" no tiene la misma cantidad de valores que labels.` });
    }
  }
  if (type === 'doughnut' && series.length > 1) {
    return res.status(400).json({ success: false, message: 'Un gráfico doughnut solo admite una serie de datos.' });
  }
  if (!['html', 'png', 'pdf'].includes(fmt)) {
    return res.status(400).json({ success: false, message: `Formato inválido: "${fmt}". Debe ser uno de: html, png, pdf.` });
  }

  try {
    if (fmt === 'png' || fmt === 'pdf') {
      const buffer = await renderQuickChart(type, labels, series, fmt);
      res.set('Content-Type', fmt === 'png' ? 'image/png' : 'application/pdf');
      return res.send(buffer);
    }
    // html no es un render: es la página misma, se arma acá
    const html = buildChartHTML(title, type, labels, series);
    return res.json({ success: true, html });
  } catch (err) {
    return res.status(500).json({ success: false, message: `Error generando el gráfico en formato ${fmt}: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Mock backend corriendo en http://localhost:${PORT}`);
  console.log(`  POST /users/login`);
  console.log(`  GET  /api/v1/analytics/sessions`);
  console.log(`  GET  /api/v1/analytics/patients`);
  console.log(`  GET  /api/v1/analytics/users`);
  console.log(`  GET  /api/v1/analytics/kiosks`);
  console.log(`  GET  /api/v1/analytics/appointments`);
  console.log(`  GET  /api/v1/analytics/videovisits`);
  console.log(`  GET  /api/v1/analytics/exams`);
  console.log(`  GET  /api/v1/analytics/checks`);
  console.log(`  GET  /api/v1/analytics/attentions`);
  console.log(`  GET  /api/v1/analytics/schedules`);
  console.log(`  GET  /api/v1/analytics/shared_checks`);
  console.log(`  GET  /api/v1/analytics/records`);
  console.log(`  GET  /api/v1/analytics/roles`);
  console.log(`\nUsuarios de prueba:`);
  console.log(`  admin@diagnostica.com  / 1234`);
  console.log(`  medico@diagnostica.com / 1234`);
});

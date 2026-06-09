'use strict';

const express = require('express');
const cors    = require('cors');
const XLSX    = require('xlsx');
const crypto  = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ─────────────────────────────────────────────────────────────────
// Client-specific constants (visibility customer on tlchile domain)
const CLIENT_USER_ID  = parseInt(process.env.TL_CLIENT_USER_ID  || '5136');
const CLIENT_USER_ADM = parseInt(process.env.TL_CLIENT_USER_ADM || '7037');
const CLIENT_CUSTOMER = parseInt(process.env.TL_CLIENT_CUSTOMER || '101');
const CLIENT_DOMAIN   = process.env.TL_CLIENT_DOMAIN            || 'tlchile';
const URLGTS          = process.env.TL_URLGTS                   || 'https://www.trackgts.com:82/';

// ─── Session cache + mutex ───────────────────────────────────────────────────
let session        = { hash: null, urlGTS: null, expiry: 0 };
let sessionPromise = null;

// ─── Jobs store (in-memory) ──────────────────────────────────────────────────
const jobs = new Map();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000);

// ─── getSession ──────────────────────────────────────────────────────────────
async function getSession() {
  if (session.hash && Date.now() < session.expiry) return session;
  if (sessionPromise) { console.log('[AUTH] Waiting for existing login...'); return sessionPromise; }
  sessionPromise = _doLogin().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

// ─── Direct API login — no Browserless needed ────────────────────────────────
async function _doLogin() {
  console.log('[AUTH] Starting direct API login...');

  // Step 1 – Generate random temp credentials
  const loginNum = Math.round(Math.random() * 1e8);       // 8-digit random
  const pinNum   = Math.round(Math.random() * 9000) + 1000; // 4-digit: 1000-9999

  // Step 2 – Register temp user via impersonalization endpoint
  console.log('[AUTH] Registering temp user...');
  const impResp = await fetch(`${URLGTS}api/userTempWebImper/${CLIENT_CUSTOMER}/_2022`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      login:        String(loginNum),
      password:     String(pinNum),
      userId:       CLIENT_USER_ID,
      userIdAdm:    CLIENT_USER_ADM,
      customerName: CLIENT_DOMAIN
    })
  });

  if (!impResp.ok) throw new Error(`userTempWebImper HTTP ${impResp.status}`);
  const impData = JSON.parse(await impResp.text());
  console.log('[AUTH] userTempWebImper:', JSON.stringify(impData));

  if (impData.idResult === -3)  throw new Error('userTempWebImper: expired session (-3)');
  if (impData.idResult === -11) throw new Error('userTempWebImper: rejected (-11)');

  // Step 3 – Login as client using temp credentials
  console.log('[AUTH] Logging in as client...');
  const loginResp = await fetch(`${URLGTS}api/login3/${CLIENT_USER_ID}/1`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      user:    String(loginNum),
      objPwrd: [String(pinNum)],
      domain:  CLIENT_DOMAIN
    })
  });

  if (!loginResp.ok) throw new Error(`login3 HTTP ${loginResp.status}`);
  const loginData = await loginResp.json();
  const hash = Array.isArray(loginData) ? loginData[0]?.hash : loginData?.hash;
  if (!hash) throw new Error('No hash in login3: ' + JSON.stringify(loginData).substring(0, 300));

  session = { hash, urlGTS: URLGTS, expiry: Date.now() + 8 * 60 * 60 * 1000 };
  console.log('[AUTH] Session OK:', hash.substring(0, 22) + '...');
  return session;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Truncate to N decimals (same as portal's toFixedNoRound)
function truncDec(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.trunc(n * factor) / factor;
}

// Convert UTC ISO string to Chile local time (UTC-4) formatted as YYYY/MM/DD HH:mm:ss
function toChileTime(utcStr) {
  if (!utcStr) return '';
  // Ensure string is parsed as UTC (append Z if no timezone info)
  let s = utcStr.replace(' ', 'T');
  if (!s.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  if (isNaN(d)) return utcStr;
  const local = new Date(d.getTime() - 4 * 3600 * 1000);
  const pad   = n => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}/${pad(local.getUTCMonth()+1)}/${pad(local.getUTCDate())} ` +
         `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

// ─── Field mapping ───────────────────────────────────────────────────────────
function mapRow(r, alias) {
  const eps = r.epsC21 != null && r.epsC21 >= 0
    ? truncDec(r.epsC21 / 1000, 1).toFixed(1) + ' V'
    : '-';
  const motor = r.dOut1C48 ? '1' : '';

  return [
    alias,
    toChileTime(r.gpsUtcTimeC13 || ''),
    `${r.latC12 ?? ''} , ${r.lonC11 ?? ''}`,
    'OK',
    r.speedC8 > 0 ? 'En movimiento' : 'Detenido',
    r.ignStateC41  ? 'Encendido'    : 'Apagado',
    motor,
    r.speedC8     ?? 0,
    r.odometerC14 ?? 0,
    eps,
    r.intBattC20 != null ? r.intBattC20 + ' %' : '-',
    r.msgTypeC0   ?? ''
  ];
}

// ─── Background job runner ───────────────────────────────────────────────────
async function runHistorialJob(jobId, { unitId, startDate, endDate, alias }) {
  try {
    const { hash, urlGTS } = await getSession();

    const r = await fetch(`${urlGTS}api/historyReport/${hash}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify([{ reportType: '0', unitId: String(unitId), startDate, endDate }])
    });
    if (!r.ok) { session.expiry = 0; throw new Error(`TrackGTS error ${r.status}`); }

    const rows = await r.json();
    if (!Array.isArray(rows)) {
      const msg = rows?.message || JSON.stringify(rows);
      if (String(msg).includes('error') || String(msg).includes('idResult')) {
        session.expiry = 0;
        throw new Error(`TrackGTS: ${msg}`);
      }
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Seguimiento de la Unidad'],
      ['Alias','Fecha GPS','Coordenadas','GPS','Estado','Ignición','Motor',
       'Velocidad','Odómetro','EPS','Carga Batería','Tipo'],
      ...(Array.isArray(rows) ? rows : []).map(row => mapRow(row, alias || ''))
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Información del Recorrido');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const pad  = n => String(n).padStart(2, '0');
    const now  = new Date();
    const safe = (alias || 'vehiculo').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filename = `Historial_${safe}_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}.xlsx`;

    jobs.set(jobId, { status: 'complete', buffer, filename, createdAt: Date.now() });
    console.log(`[JOB ${jobId}] Completado: ${filename} (${Array.isArray(rows) ? rows.length : 0} registros)`);

  } catch (err) {
    console.error(`[JOB ${jobId}] Error:`, err.message);
    jobs.set(jobId, { status: 'error', error: err.message, createdAt: Date.now() });
  }
}

// ─── GET /api/units ──────────────────────────────────────────────────────────
app.get('/api/units', async (req, res) => {
  try {
    const { hash, urlGTS } = await getSession();
    const r    = await fetch(`${urlGTS}api/units2/${hash}?callback=cb&_=${Date.now()}`);
    const text = await r.text();
    const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));
    const units = json
      .filter(u => u.unitId > 0 && u.alias && !/^\s*(No Asignado|Flota)/i.test(u.alias))
      .map(u => ({ id: u.unitId, alias: u.alias.trim() }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
    res.json(units);
  } catch (err) {
    console.error('[/api/units]', err.message);
    session.expiry = 0;
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/historial ─────────────────────────────────────────────────────
app.post('/api/historial', (req, res) => {
  const { unitId, startDate, endDate, alias } = req.body;
  if (!unitId || !startDate || !endDate)
    return res.status(400).json({ error: 'unitId, startDate, endDate requeridos' });

  const jobId = crypto.randomBytes(8).toString('hex');
  jobs.set(jobId, { status: 'pending', createdAt: Date.now() });

  console.log(`[JOB ${jobId}] Iniciado: ${alias} ${startDate} → ${endDate}`);
  runHistorialJob(jobId, { unitId, startDate, endDate, alias });

  res.status(202).json({ jobId });
});

// ─── GET /api/job/:id ─────────────────────────────────────────────────────────
app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado o expirado' });
  if (job.status === 'pending') return res.json({ status: 'pending' });
  if (job.status === 'error') {
    jobs.delete(req.params.id);
    return res.status(500).json({ status: 'error', error: job.error });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(job.buffer);
  jobs.delete(req.params.id);
});

// ─── GET /api/test-auth ───────────────────────────────────────────────────────
app.get('/api/test-auth', async (req, res) => {
  try {
    session.expiry = 0;
    const { hash } = await getSession();
    res.json({ ok: true, hash: hash.substring(0, 22) + '...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  ok: true,
  sessionActive: !!(session.hash && Date.now() < session.expiry),
  pendingJobs: [...jobs.values()].filter(j => j.status === 'pending').length
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] Proxy en puerto ${PORT}`));

'use strict';

const express  = require('express');
const cors     = require('cors');
const XLSX     = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const BROWSERLESS_URL   = process.env.BROWSERLESS_URL   || 'https://wurfel-browserless.onrender.com';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || 'd7ce9e246736fb306597659ab9794434';
const TL_USER   = process.env.TL_ADMIN_USER   || 'amelendez';
const TL_DOMAIN = process.env.TL_ADMIN_DOMAIN || 'tlchile';
const TL_PASS   = process.env.TL_ADMIN_PASS;          // required — set in Render env vars
const TL_CLIENT = process.env.TL_CLIENT_NAME  || 'visibility';

// ─── Session cache + mutex ──────────────────────────────────────────────────
let session        = { hash: null, urlGTS: null, expiry: 0 };
let sessionPromise = null; // prevents concurrent login attempts

// ─── Browserless login script ───────────────────────────────────────────────
// Mirrors exactly the n8n Configuración node logic
const LOGIN_SCRIPT = `
export default async function({ page, context }) {
  const w = ms => new Promise(r => setTimeout(r, ms));

  // 1. Admin login
  await page.goto('https://tlchile.trackgts.com/admin/login.html',
    { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.evaluate(() => localStorage.setItem('sltLanguage', '0'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#username', { timeout: 30000 });

  await page.evaluate((user, domain, pass) => {
    const K = 'd5fg4df5sg4ds5fg';
    const S = { a:'1',b:'2',c:'3',d:'4',e:'5',f:'6',g:'7',h:'8',i:'9' };
    const k = CryptoJS.enc.Utf8.parse(K), iv = CryptoJS.enc.Utf8.parse(K), a = [];
    for (const c of pass)
      a.push(CryptoJS.AES.encrypt(
        CryptoJS.enc.Utf8.parse(S[c] || c), k,
        { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
      ).toString());
    ARRAYPSWD = a;
    document.getElementById('username').value = user;
    document.getElementById('domain').value   = domain;
    document.getElementById('password').value = 'XXXXXXXX';
    LOGININPROCESS = false;
    onLoginOn();
  }, context.user, context.domain, context.pass);

  await w(15000); // wait for admin session

  // 2. Navigate to Clientes menu
  await page.evaluate(() => {
    const link = document.querySelector('a.langMainClientes');
    if (link) link.click();
  });
  await w(2000);

  // 3. Set search type to "Cliente/Empresa" and search
  await page.evaluate((clientName) => {
    // Select "Cliente/Empresa" in search type dropdown
    const sel = document.querySelector('select');
    if (sel) {
      const opt = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes('empresa') || o.text.toLowerCase().includes('cliente'));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); }
    }
    // Fill search input (placeholder "Mínimo 3 caracteres")
    const input = document.querySelector('input.k-textbox[placeholder]');
    if (input) {
      input.value = clientName;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
    }
    // Click search button
    const btn = document.querySelector('td[onclick*="buscarClientes"]');
    if (btn) btn.click();
  }, context.clientName);
  await w(3000);

  // 4. Click Ver Subusuarios
  await page.evaluate(() => {
    const td = document.querySelector('td[onclick*="verUsuarios"]');
    if (td) td.click();
  });
  await w(2000);

  // 5. Impersonalizar — watch for new window
  const newWindowPromise = new Promise(resolve => {
    page.browser().once('targetcreated', async target => {
      const p = await target.page();
      if (p) resolve(p);
    });
  });

  await page.evaluate(() => {
    const btn = document.querySelector('img#imggestion, img[title*="Impersonalizar ingreso"]');
    if (btn) btn.click();
  });

  // 6. Wait for client session in new window
  const mapPage = await newWindowPromise;
  await mapPage.waitForFunction(() => {
    const j = JSON.parse(sessionStorage.getItem('JSONUSER') || 'null');
    return j && j.hash;
  }, { timeout: 30000 });

  const result = await mapPage.evaluate(() => ({
    hash:   JSON.parse(sessionStorage.getItem('JSONUSER')).hash,
    urlGTS: sessionStorage.getItem('URLGTS') || 'https://www.trackgts.com:82/'
  }));

  return { data: result, type: 'application/json' };
}
`;

// ─── getSession ─────────────────────────────────────────────────────────────
async function getSession() {
  if (session.hash && Date.now() < session.expiry) return session;

  // Mutex: si ya hay un login en curso, esperar al mismo
  if (sessionPromise) {
    console.log('[AUTH] Login ya en progreso — esperando...');
    return sessionPromise;
  }

  sessionPromise = _doLogin().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

async function _doLogin() {
  console.log('[AUTH] Starting Browserless login...');

  // Warm-up Render: despierta Browserless si está dormido (free tier)
  console.log('[AUTH] Warming up Browserless...');
  await fetch(`${BROWSERLESS_URL}/json/version?token=${BROWSERLESS_TOKEN}`)
    .catch(e => console.log('[AUTH] Warm-up error (ignorado):', e.message));

  const resp = await fetch(`${BROWSERLESS_URL}/function?token=${BROWSERLESS_TOKEN}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code:    LOGIN_SCRIPT,
      context: { user: TL_USER, domain: TL_DOMAIN, pass: TL_PASS, clientName: TL_CLIENT }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Browserless ${resp.status}: ${txt.substring(0, 300)}`);
  }

  const data = await resp.json();
  console.log('[AUTH] Browserless response:', JSON.stringify(data).substring(0, 200));

  if (!data.hash) throw new Error('No hash en respuesta: ' + JSON.stringify(data).substring(0, 300));

  session = { hash: data.hash, urlGTS: data.urlGTS, expiry: Date.now() + 8 * 60 * 60 * 1000 };
  console.log('[AUTH] Session OK ·', session.hash.substring(0, 22) + '...');
  return session;
}

// ─── Field mapping ───────────────────────────────────────────────────────────
function mapRow(r, alias) {
  const state = r.speedC8 > 0 ? 'En Movimiento' : 'Detenido';
  const ign   = r.ignStateC41 ? 'Encendido' : 'Apagado';
  const coord = `${r.latC12 ?? ''} , ${r.lonC11 ?? ''}`;
  const eps   = r.epsC21 != null ? (r.epsC21 / 1000).toFixed(1) + ' V' : '-';
  const batt  = r.intBattC20 != null ? r.intBattC20 + ' %' : '-';
  return [
    alias,
    (r.gpsUtcTimeC13 || '').replace('T', ' '),
    coord,
    'OK',
    state,
    ign,
    String(r.dOut1C48 ?? 0),
    r.speedC8    ?? 0,
    r.odometerC14 ?? 0,
    eps,
    batt,
    r.msgTypeC0  ?? ''
  ];
}

// ─── GET /api/units ──────────────────────────────────────────────────────────
app.get('/api/units', async (req, res) => {
  try {
    const { hash, urlGTS } = await getSession();
    const r    = await fetch(`${urlGTS}api/units2/${hash}?callback=cb&_=${Date.now()}`);
    const text = await r.text();
    const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));

    const units = json
      .filter(u => u.unitId > 0 && u.alias && !/^\s*(No Asignado|Flota|Cortadoras)/i.test(u.alias))
      .map(u  => ({ id: u.unitId, alias: u.alias.trim() }))
      .sort((a, b) => a.alias.localeCompare(b.alias));

    res.json(units);
  } catch (err) {
    console.error('[/api/units]', err.message);
    session.expiry = 0;
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/historial ─────────────────────────────────────────────────────
app.post('/api/historial', async (req, res) => {
  try {
    const { unitId, startDate, endDate, alias } = req.body;
    if (!unitId || !startDate || !endDate) {
      return res.status(400).json({ error: 'unitId, startDate, endDate requeridos' });
    }

    const { hash, urlGTS } = await getSession();

    const r = await fetch(`${urlGTS}api/historyReport/${hash}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify([{ reportType: '0', unitId: String(unitId), startDate, endDate }])
    });

    if (!r.ok) { session.expiry = 0; throw new Error(`TrackGTS error ${r.status}`); }

    const rows = await r.json();

    // Check for API error response
    if (!Array.isArray(rows)) {
      const msg = rows?.message || JSON.stringify(rows);
      if (msg.includes('error')) { session.expiry = 0; throw new Error(`TrackGTS: ${msg}`); }
    }

    // ── Build Excel ──────────────────────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Seguimiento de la Unidad'],
      ['Alias','Fecha GPS','Coordenadas','GPS','Estado','Ignición','Motor',
       'Velocidad','Odómetro','EPS','Carga Batería','Tipo'],
      ...(Array.isArray(rows) ? rows : []).map(row => mapRow(row, alias || ''))
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Información del Recorrido');

    const buf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const pad  = n => String(n).padStart(2, '0');
    const now  = new Date();
    const safe = (alias || 'vehiculo').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const name = `Historial_${safe}_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('[/api/historial]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  ok: true,
  sessionActive: !!(session.hash && Date.now() < session.expiry),
  sessionExpiry: session.expiry ? new Date(session.expiry).toISOString() : null
}));

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Proxy listening on port ${PORT}`);
  if (!TL_PASS) {
    console.error('[ERROR] TL_ADMIN_PASS no está configurado — define la variable de entorno');
  } else {
    console.log('[SERVER] Listo. La sesión TrackGTS se obtendrá en la primera petición.');
  }
});

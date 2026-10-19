'use strict';

// Cliente TrackGTS compartido por las funciones de Vercel (api/units, api/historial).
// Login directo por API (impersonalización), sin navegador.

// ─── Config ─────────────────────────────────────────────────────────────────
// Client-specific constants (visibility customer on tlchile domain)
const CLIENT_USER_ID  = parseInt(process.env.TL_CLIENT_USER_ID  || '5136');
const CLIENT_USER_ADM = parseInt(process.env.TL_CLIENT_USER_ADM || '7037');
const CLIENT_CUSTOMER = parseInt(process.env.TL_CLIENT_CUSTOMER || '101');
const CLIENT_DOMAIN   = process.env.TL_CLIENT_DOMAIN            || 'tlchile';
const URLGTS          = process.env.TL_URLGTS                   || 'https://www.trackgts.com:82/';

// ─── Session cache + mutex ───────────────────────────────────────────────────
// Vive mientras la instancia de la función siga caliente; si no, se re-loguea.
let session        = { hash: null, urlGTS: null, expiry: 0 };
let sessionPromise = null;

async function getSession() {
  if (session.hash && Date.now() < session.expiry) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = _doLogin().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

function resetSession() {
  session.expiry = 0;
}

async function _doLogin() {
  console.log('[AUTH] Starting direct API login...');

  // Step 1 – Generate random temp credentials
  const loginNum = Math.round(Math.random() * 1e8);       // 8-digit random
  const pinNum   = Math.round(Math.random() * 9000) + 1000; // 4-digit: 1000-9999

  // Step 2 – Register temp user via impersonalization endpoint
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

  if (impData.idResult === -3)  throw new Error('userTempWebImper: expired session (-3)');
  if (impData.idResult === -11) throw new Error('userTempWebImper: rejected (-11)');

  // Step 3 – Login as client using temp credentials
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

// ─── CORS (el dashboard vive en GitHub Pages) ────────────────────────────────
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

module.exports = { getSession, resetSession, mapRow, cors };

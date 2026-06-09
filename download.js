#!/usr/bin/env node
/**
 * TrackGTS Recorrido Downloader — Visibility
 * Login directo via API (sin Puppeteer/Browserless).
 */
'use strict';

const AdmZip = require('adm-zip');
const fs     = require('fs');

// Client constants (mismos que proxy/server.js)
const CLIENT_USER_ID  = parseInt(process.env.TL_CLIENT_USER_ID  || '5136');
const CLIENT_USER_ADM = parseInt(process.env.TL_CLIENT_USER_ADM || '7037');
const CLIENT_CUSTOMER = parseInt(process.env.TL_CLIENT_CUSTOMER || '101');
const CLIENT_DOMAIN   = process.env.TL_CLIENT_DOMAIN            || 'tlchile';
const URLGTS          = process.env.TL_URLGTS                   || 'https://www.trackgts.com:82/';

const REPORT_TYPE = process.env.TL_REPORT_TYPE || '2';
const UNIT_IDS    = process.env.TL_UNIT_IDS    || '';
const REPORT_NAME = 'Visibility Viajes y Paradas';

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}`;

async function doLogin() {
  const loginNum = Math.round(Math.random() * 1e8);
  const pinNum   = Math.round(Math.random() * 9000) + 1000;

  console.log('[AUTH] Registrando usuario temporal...');
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
  if (impData.idResult === -3)  throw new Error('userTempWebImper: expired (-3)');
  if (impData.idResult === -11) throw new Error('userTempWebImper: rejected (-11)');

  console.log('[AUTH] Login como cliente...');
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
  if (!hash) throw new Error('Sin hash en login3: ' + JSON.stringify(loginData).substring(0, 300));
  console.log('[AUTH] Hash OK:', hash.substring(0, 22) + '...');
  return hash;
}

async function getUnitIds(hash) {
  if (UNIT_IDS) { console.log('[UNITS] Usando TL_UNIT_IDS:', UNIT_IDS); return UNIT_IDS; }
  console.log('[UNITS] TL_UNIT_IDS vacío, obteniendo unidades del sistema...');
  const r    = await fetch(`${URLGTS}api/units2/${hash}?callback=cb&_=${Date.now()}`);
  const text = await r.text();
  const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));
  const ids  = json
    .filter(u => u.unitId > 0 && u.alias && !/^\s*(No Asignado|Flota|Cortadoras)/i.test(u.alias))
    .map(u => String(u.unitId))
    .join(',');
  console.log(`[UNITS] ${ids.split(',').length} unidades: ${ids}`);
  return ids;
}

async function main() {
  const now   = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 7);
  const startDate = `${fmt(start)} 04:00:00`;
  const endDate   = `${fmt(now)} 03:59:59`;

  console.log('=== Visibility Downloader ===');
  console.log(`Rango: ${startDate} → ${endDate} | Tipo: ${REPORT_TYPE}`);

  const hash    = await doLogin();
  const unitIds = await getUnitIds(hash);

  const body = JSON.stringify({
    startDate, endDate,
    unitIds,
    reportName: REPORT_NAME,
    parameters: 'undefined',
    userTimeZone: -4, userfuelMeasure: 0, userMeasureDistance: 0, language: 0,
  });

  console.log('[3] Descargando reporte...');
  const res = await fetch(
    `${URLGTS}api/reportTravel/GetTravelReportByUnitsPagesZip/${REPORT_TYPE}/${hash}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const json = await res.json();
  if (!json.FileContents)
    throw new Error(`Sin FileContents: ${JSON.stringify(json).slice(0, 300)}`);

  console.log(`[4] Extrayendo: ${json.FileDownloadName}`);
  const zip  = new AdmZip(Buffer.from(json.FileContents, 'base64'));
  const xlsx = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.xlsx'));
  if (!xlsx) throw new Error(`Sin .xlsx en ZIP. Entradas: ${zip.getEntries().map(e => e.entryName).join(', ')}`);

  const dest = 'REPORTE DE RECORRIDO.xlsx';
  fs.writeFileSync(dest, xlsx.getData());
  console.log(`[5] Guardado: ${dest}`);
  console.log('=== COMPLETADO ===');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });

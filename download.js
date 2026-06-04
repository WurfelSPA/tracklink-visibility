#!/usr/bin/env node
/**
 * TrackGTS Recorrido Downloader — Visibility
 *
 * ⚠️  PENDIENTE: confirmar TL_REPORT_TYPE
 *     En TrackGTS → Reportes → Recorridos y Paradas → Generar
 *     F12 → Network → busca llamada a trackgts.com:82
 *     El número está en la URL: GetTravelReportByUnitsPagesZip/{NÚMERO}/...
 */
'use strict';

const puppeteer = require('puppeteer');
const AdmZip    = require('adm-zip');
const fs        = require('fs');
const path      = require('path');

const REPORT_TYPE = process.env.TL_REPORT_TYPE || '2';
const REPORT_NAME = 'Visibility Viajes y Paradas';
const UNIT_IDS    = process.env.TL_UNIT_IDS    || '';

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}`;

async function main() {
  const { TL_USER, TL_PASSWORD, TL_DOMAIN } = process.env;
  if (!TL_USER || !TL_PASSWORD || !TL_DOMAIN)
    throw new Error('Faltan variables: TL_USER, TL_PASSWORD, TL_DOMAIN');

  console.log('=== Visibility Downloader ===');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);

    const loginUrl = `https://${TL_DOMAIN}.trackgts.com/admin/login.html`;
    console.log(`[1] Login: ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForSelector('#username', { timeout: 30_000 });
    await page.evaluate(() => localStorage.setItem('sltLanguage', '0'));
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#username', { timeout: 30_000 });

    await page.evaluate((user, password, domain) => {
      const K = 'd5fg4df5sg4ds5fg';
      const S = { a:'1',b:'2',c:'3',d:'4',e:'5',f:'6',g:'7',h:'8',i:'9' };
      const k = CryptoJS.enc.Utf8.parse(K), iv = CryptoJS.enc.Utf8.parse(K), a = [];
      for (const c of password)
        a.push(CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(S[c]||c), k,
          { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString());
      ARRAYPSWD = a;
      document.getElementById('username').value = user;
      document.getElementById('domain').value   = domain;
      document.getElementById('password').value = '********';
      LOGININPROCESS = false;
      onLoginOn();
    }, TL_USER, TL_PASSWORD, TL_DOMAIN);

    console.log('[2] Esperando sesión (15s)...');
    await new Promise(r => setTimeout(r, 15_000));

    const now   = new Date();
    const start = new Date(now); start.setDate(start.getDate() - 7);
    const startDate = `${fmt(start)} 04:00:00`;
    const endDate   = `${fmt(now)} 03:59:59`;
    console.log(`[3] Rango: ${startDate} → ${endDate} | Tipo: ${REPORT_TYPE}`);

    const result = await page.evaluate(async (startDate, endDate, unitIds, reportType, reportName) => {
      const h    = JSONUSER.hash;
      const body = JSON.stringify({
        startDate, endDate,
        unitIds, reportName,
        parameters: 'undefined',
        userTimeZone: -4, userfuelMeasure: 0, userMeasureDistance: 0, language: 0,
      });
      const res = await fetch(
        `https://www.trackgts.com:82/api/reportTravel/GetTravelReportByUnitsPagesZip/${reportType}/${h}`,
        { method:'POST', headers:{'Content-Type':'application/json;charset=UTF-8'}, body }
      );
      const json = await res.json();
      if (!json.FileContents)
        return { error: `Sin FileContents: ${JSON.stringify(json).slice(0,300)}` };
      return { fileContents: json.FileContents, fileName: json.FileDownloadName };
    }, startDate, endDate, UNIT_IDS, REPORT_TYPE, REPORT_NAME);

    if (result.error) throw new Error(result.error);
    console.log(`[3] OK: ${result.fileName}`);

    const zip  = new AdmZip(Buffer.from(result.fileContents, 'base64'));
    const xlsx = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.xlsx'));
    if (!xlsx) throw new Error(`Sin .xlsx. Entradas: ${zip.getEntries().map(e=>e.entryName).join(', ')}`);

    const dest = path.join(process.cwd(), 'REPORTE DE RECORRIDO.xlsx');
    fs.writeFileSync(dest, xlsx.getData());
    console.log(`[4] Guardado: ${dest}`);
    console.log('=== COMPLETADO ===');

  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });

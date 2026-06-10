#!/usr/bin/env node
/**
 * TrackGTS Recorrido Downloader — Visibility
 * Usa historyReport para obtener posiciones crudas y detecta viajes/paradas.
 * Genera REPORTE DE RECORRIDO.xlsx con hojas 'Detalle 1' y 'Resumen 1'.
 */
'use strict';

const fs   = require('fs');
const XLSX = require('xlsx');

// ─── Config ──────────────────────────────────────────────────────────────────
const CLIENT_USER_ID  = parseInt(process.env.TL_CLIENT_USER_ID  || '5136');
const CLIENT_USER_ADM = parseInt(process.env.TL_CLIENT_USER_ADM || '7037');
const CLIENT_CUSTOMER = parseInt(process.env.TL_CLIENT_CUSTOMER || '101');
const CLIENT_DOMAIN   = process.env.TL_CLIENT_DOMAIN            || 'tlchile';
const URLGTS          = process.env.TL_URLGTS                   || 'https://www.trackgts.com:82/';
const UNIT_IDS        = process.env.TL_UNIT_IDS                 || '';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
const fmtDT = d => `${fmt(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** Convierte timestamp UTC a Date con hora Chile (UTC-4, fijo) */
function toChileTime(utcStr) {
  if (!utcStr) return null;
  let s = utcStr.replace(' ', 'T');
  if (!s.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  if (isNaN(d)) return null;
  // En sistema UTC (GitHub Actions): restar 4h da hora Chile
  return new Date(d.getTime() - 4 * 3600 * 1000);
}

/** Distancia en km entre dos coords (Haversine) */
function haversine(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function fmtDuration(ms) {
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function doLogin() {
  const loginNum = Math.round(Math.random() * 1e8);
  const pinNum   = Math.round(Math.random() * 9000) + 1000;

  console.log('[AUTH] Registrando usuario temporal...');
  const impResp = await fetch(`${URLGTS}api/userTempWebImper/${CLIENT_CUSTOMER}/_2022`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ login: String(loginNum), password: String(pinNum),
      userId: CLIENT_USER_ID, userIdAdm: CLIENT_USER_ADM, customerName: CLIENT_DOMAIN }),
  });
  if (!impResp.ok) throw new Error(`userTempWebImper HTTP ${impResp.status}`);
  const impData = JSON.parse(await impResp.text());
  console.log('[AUTH] userTempWebImper:', JSON.stringify(impData));
  if (impData.idResult === -3)  throw new Error('userTempWebImper: expired (-3)');
  if (impData.idResult === -11) throw new Error('userTempWebImper: rejected (-11)');

  console.log('[AUTH] Login como cliente...');
  const loginResp = await fetch(`${URLGTS}api/login3/${CLIENT_USER_ID}/1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ user: String(loginNum), objPwrd: [String(pinNum)], domain: CLIENT_DOMAIN }),
  });
  if (!loginResp.ok) throw new Error(`login3 HTTP ${loginResp.status}`);
  const loginData = await loginResp.json();
  const hash = Array.isArray(loginData) ? loginData[0]?.hash : loginData?.hash;
  if (!hash) throw new Error('Sin hash: ' + JSON.stringify(loginData).slice(0, 200));
  console.log('[AUTH] Hash OK:', hash.substring(0, 22) + '...');
  return hash;
}

// ─── Obtener unidades con alias ───────────────────────────────────────────────
async function getUnits(hash) {
  const r    = await fetch(`${URLGTS}api/units2/${hash}?callback=cb&_=${Date.now()}`);
  const text = await r.text();
  const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));
  const all  = json
    .filter(u => u.unitId > 0 && u.alias && !/^\s*(No Asignado|Flota|Cortadoras)/i.test(u.alias))
    .map(u => ({ id: u.unitId, alias: u.alias.trim() }));

  if (UNIT_IDS) {
    const wanted = new Set(UNIT_IDS.split(',').map(s => s.trim()));
    return all.filter(u => wanted.has(String(u.unitId)));
  }
  console.log(`[UNITS] ${all.length} unidades: ${all.map(u => u.id).join(',')}`);
  return all;
}

// ─── Descargar historial de posiciones ───────────────────────────────────────
async function getHistory(hash, unitId, startDate, endDate) {
  const r = await fetch(`${URLGTS}api/historyReport/${hash}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ reportType: '0', unitId: String(unitId), startDate, endDate }]),
  });
  if (!r.ok) throw new Error(`historyReport HTTP ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error('Respuesta inesperada: ' + JSON.stringify(data).slice(0, 200));
  return data;
}

// ─── Detección de viajes y paradas ───────────────────────────────────────────
/**
 * Agrupa posiciones GPS en segmentos (Recorridos / Paradas).
 * Algoritmo: se considera nueva parada cuando velocidad=0 durante >= STOP_GAP_MS.
 */
function detectTrips(positions, alias) {
  const STOP_GAP_MS = 5 * 60 * 1000; // 5 min parado = nueva parada
  const MIN_TRIP_KM = 0.1;            // ignorar micro-movimientos

  const pts = positions
    .map(p => ({
      time:  toChileTime(p.gpsUtcTimeC13),
      lat:   p.latC12  ?? 0,
      lon:   p.lonC11  ?? 0,
      speed: p.speedC8 || 0,
    }))
    .filter(p => p.time)
    .sort((a, b) => a.time - b.time);

  if (pts.length < 2) return [];

  // ── Segmentar en bloques separados por paradas >= STOP_GAP_MS ──
  const segments = [];
  let segStart    = 0;
  let stoppedAt   = pts[0].speed === 0 ? 0 : -1;

  for (let i = 1; i < pts.length; i++) {
    if (pts[i].speed > 0) {
      stoppedAt = -1; // retomó movimiento
    } else {
      if (stoppedAt < 0) stoppedAt = i; // empezó a detenerse
      else if (pts[i].time - pts[stoppedAt].time >= STOP_GAP_MS) {
        // Parada larga: cortar segmento en el inicio de la parada
        segments.push(pts.slice(segStart, stoppedAt));
        segStart  = stoppedAt;
        stoppedAt = stoppedAt; // la parada continúa en el nuevo segmento
      }
    }
  }
  segments.push(pts.slice(segStart));

  // ── Convertir segmentos a filas del reporte ──
  const rows       = [];
  const seqByDay   = {};

  for (const seg of segments) {
    if (seg.length < 1) continue;
    const first = seg[0];
    const last  = seg[seg.length - 1];

    // Calcular distancia total
    let dist = 0;
    for (let i = 1; i < seg.length; i++)
      dist += haversine(seg[i-1].lat, seg[i-1].lon, seg[i].lat, seg[i].lon);

    const isTrip = dist >= MIN_TRIP_KM || seg.some(p => p.speed > 5);
    const estado = isTrip ? 'Recorridos' : 'Paradas';

    const dateKey      = fmt(first.time);
    seqByDay[dateKey]  = (seqByDay[dateKey] || 0) + 1;
    const seq          = seqByDay[dateKey];

    const movPts = seg.filter(p => p.speed > 0);
    const velMax = Math.max(0, ...seg.map(p => p.speed));
    const velProm = movPts.length
      ? movPts.reduce((s, p) => s + p.speed, 0) / movPts.length
      : 0;

    rows.push({
      'Alias':                    alias,
      'Conductor':                '',
      'Secuencial':               seq,
      'Estado':                   estado,
      'Fecha de Inicio':          fmtDT(first.time),
      'Posición de Inicio':       `${first.lat}, ${first.lon}`,
      'Dirección de Inicio':      `${first.lat.toFixed(5)}, ${first.lon.toFixed(5)}`,
      'Fecha de Fin':             fmtDT(last.time),
      'Posición Final':           `${last.lat}, ${last.lon}`,
      'Dirección Final':          `${last.lat.toFixed(5)}, ${last.lon.toFixed(5)}`,
      'Tiempo':                   fmtDuration(last.time - first.time),
      'Distancia (Km)':           Math.round(dist * 100) / 100,
      'Velocidad Máxima (Km/h)':  Math.round(velMax),
      'Velocidad Promedio (Km/h)':Math.round(velProm),
      _dist:   dist,
      _isTrip: isTrip,
    });
  }

  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now   = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  const startDate = `${fmt(start)} 04:00:00`;
  const endDate   = `${fmt(now)} 03:59:59`;

  console.log('=== Visibility Downloader ===');
  console.log(`Rango: ${startDate} → ${endDate}`);

  const hash  = await doLogin();
  const units = await getUnits(hash);
  console.log(`[INFO] ${units.length} unidades a procesar`);

  const allRows = [];

  for (const unit of units) {
    console.log(`[${unit.id}] ${unit.alias} — descargando historial...`);
    try {
      const positions = await getHistory(hash, unit.id, startDate, endDate);
      console.log(`  ${positions.length} posiciones`);
      const rows = detectTrips(positions, unit.alias);
      const nTrips = rows.filter(r => r._isTrip).length;
      const nStops = rows.filter(r => !r._isTrip).length;
      console.log(`  ${nTrips} viajes, ${nStops} paradas`);
      allRows.push(...rows);
    } catch (e) {
      console.warn(`  ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300)); // rate limiting
  }

  allRows.sort((a, b) => a['Fecha de Inicio'].localeCompare(b['Fecha de Inicio']));

  // ── Hoja Detalle 1 ────────────────────────────────────────────────────────
  const DET_HDR = [
    'Alias','Conductor','Secuencial','Estado',
    'Fecha de Inicio','Posición de Inicio','Dirección de Inicio',
    'Fecha de Fin','Posición Final','Dirección Final',
    'Tiempo','Distancia (Km)','Velocidad Máxima (Km/h)','Velocidad Promedio (Km/h)',
  ];
  const detData = [
    [`Desde : ${startDate}   Hasta : ${endDate}`],
    [],
    DET_HDR,
    ...allRows.map(r => DET_HDR.map(h => r[h] ?? '')),
  ];

  // ── Hoja Resumen 1 ────────────────────────────────────────────────────────
  const resumen = {};
  for (const r of allRows) {
    if (!resumen[r.Alias]) resumen[r.Alias] = { dist: 0, trips: 0, stops: 0, velMax: 0 };
    const a = resumen[r.Alias];
    if (r._isTrip) { a.dist += r._dist; a.trips++; a.velMax = Math.max(a.velMax, r['Velocidad Máxima (Km/h)']); }
    else a.stops++;
  }
  const RES_HDR = ['Alias','Distancia (Km)','Recorridos','Paradas','Velocidad Máxima (Km/h)'];
  const resData = [
    RES_HDR,
    ...Object.entries(resumen).sort(([a],[b]) => a.localeCompare(b)).map(([alias, d]) => [
      alias,
      Math.round(d.dist * 100) / 100,
      d.trips,
      d.stops,
      Math.round(d.velMax),
    ]),
  ];

  // ── Generar XLSX ──────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detData), 'Detalle 1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resData), 'Resumen 1');

  const dest = 'REPORTE DE RECORRIDO.xlsx';
  XLSX.writeFile(wb, dest);

  const nTrips = allRows.filter(r => r._isTrip).length;
  console.log(`[5] Guardado: ${dest} — ${nTrips} viajes en ${units.length} vehículos`);
  console.log('=== COMPLETADO ===');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });

'use strict';

const XLSX = require('xlsx');
const { getSession, resetSession, mapRow, cors } = require('../lib/tgs');

// ─── POST /api/historial ─────────────────────────────────────────────────────
// Responde el Excel directamente (sin jobs en memoria, que no sirven en serverless).
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usar POST' });

  const { unitId, startDate, endDate, alias } = req.body || {};
  if (!unitId || !startDate || !endDate)
    return res.status(400).json({ error: 'unitId, startDate, endDate requeridos' });

  try {
    const { hash, urlGTS } = await getSession();

    const r = await fetch(`${urlGTS}api/historyReport/${hash}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify([{ reportType: '0', unitId: String(unitId), startDate, endDate }])
    });
    if (!r.ok) { resetSession(); throw new Error(`TrackGTS error ${r.status}`); }

    const rows = await r.json();
    if (!Array.isArray(rows)) {
      const msg = rows?.message || JSON.stringify(rows);
      if (String(msg).includes('error') || String(msg).includes('idResult')) {
        resetSession();
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

    console.log(`[historial] ${filename} (${Array.isArray(rows) ? rows.length : 0} registros)`);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.status(200).send(buffer);
  } catch (err) {
    console.error('[/api/historial]', err.message);
    res.status(500).json({ error: err.message });
  }
};

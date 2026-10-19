'use strict';

const { getSession, resetSession, cors } = require('../lib/tgs');

// ─── GET /api/units ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const { hash, urlGTS } = await getSession();
    const r    = await fetch(`${urlGTS}api/units2/${hash}?callback=cb&_=${Date.now()}`);
    const text = await r.text();
    const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));
    const units = json
      .filter(u => u.unitId > 0 && u.alias && !/^\s*(No Asignado|Flota|Cortadoras)/i.test(u.alias))
      .map(u => ({ id: u.unitId, alias: u.alias.trim() }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
    res.status(200).json(units);
  } catch (err) {
    console.error('[/api/units]', err.message);
    resetSession();
    res.status(500).json({ error: err.message });
  }
};

'use strict';

const { cors } = require('../lib/tgs');

module.exports = (req, res) => {
  if (cors(req, res)) return;
  res.status(200).json({ ok: true });
};

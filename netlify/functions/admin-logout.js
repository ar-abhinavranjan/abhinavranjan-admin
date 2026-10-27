'use strict';
const L = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return L.json(405, { ok: false, error: 'Method not allowed' });
  const guard = L.checkWriteRequest(event);
  if (guard) return L.json(403, { ok: false, error: guard });
  return L.json(200, { ok: true }, { 'Set-Cookie': L.clearCookie() });
};

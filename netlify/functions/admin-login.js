'use strict';
const L = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return L.json(405, { ok: false, error: 'Method not allowed' });

  const guard = L.checkWriteRequest(event);
  if (guard) return L.json(403, { ok: false, error: guard });

  const secret = L.sessionSecret();
  const user = process.env.ADMIN_USER;
  const stored = process.env.ADMIN_PASS_HASH;
  if (!secret || !user || !stored) {
    console.error('Admin auth is not configured');
    return L.json(500, { ok: false, error: 'Server is not configured' });
  }

  const ip = L.clientIp(event);
  if (L.isLockedOut(ip)) {
    return L.json(429, { ok: false, error: 'Too many attempts. Try again later.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return L.json(400, { ok: false, error: 'Invalid request' }); }
  const u = typeof body.username === 'string' ? body.username : '';
  const p = typeof body.password === 'string' ? body.password : '';
  if (!u || !p || u.length > 100 || p.length > 200) {
    return L.json(400, { ok: false, error: 'Invalid request' });
  }

  // Always run both checks so timing does not reveal which one was wrong.
  const userOk = L.safeEqualStr(u, user);
  const passOk = await L.verifyPassword(p, stored);

  if (!(userOk && passOk)) {
    L.recordFail(ip);
    await L.sleep(700);
    return L.json(401, { ok: false, error: 'Invalid username or password' });
  }

  L.clearFails(ip);
  const now = Math.floor(Date.now() / 1000);
  const token = L.signSession({ u: user, iat: now, exp: now + L.SESSION_TTL_S }, secret);
  return L.json(200, { ok: true }, { 'Set-Cookie': L.sessionCookie(token) });
};

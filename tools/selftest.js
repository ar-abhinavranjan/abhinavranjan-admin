'use strict';
// Offline self-test with a mocked GitHub. Run: node tools/selftest.js
const assert = require('assert');
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_SESSION_SECRET = 'x'.repeat(10) + 'abcdefghijklmnopqrstuvwxyz0123456789';
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO_OWNER = 'o';
process.env.GITHUB_SUBMISSIONS_REPO = 'r';

const L = require('../netlify/functions/_lib');
const login = require('../netlify/functions/admin-login').handler;
const logout = require('../netlify/functions/admin-logout').handler;
const data = require('../netlify/functions/admin-data').handler;

// ---- mock GitHub contents API
const files = {};
let shaN = 0;
const apptMsg = 'APPOINTMENT REQUEST DETAILS\n------------------------------------\nFull Name: Riya\nPhone Number: +91 98765 43210\nEmail Address: riya@example.com\nPreferred Date & Time: 2099-12-01T15:30\nReason for Appointment: Ethical hacking mentorship\nAdditional Notes / Context:\nI&#39;m a beginner & keen.\n------------------------------------\nSubmitted via AR. Abhinav Ranjan Portfolio';
files['contact_submissions.json'] = { content: JSON.stringify([
  { id: 'sub_1730000000001', timestamp: '2026-10-25T10:00:00Z', name: 'Asha', email: 'asha@example.com', contactNo: '9999999999', message: 'Hello &lt;b&gt;there&lt;/b&gt;, nice site', department: 'General Inquiry', source_ip: '1.2.3.4' },
  { id: 'sub_1730000000002', timestamp: '2026-10-26T10:00:00Z', name: 'Riya', email: 'riya@example.com', contactNo: '', message: apptMsg, department: 'General Inquiry', source_ip: '5.6.7.8' }
]), sha: 's0' };

global.fetch = async (url, opts = {}) => {
  const m = /\/contents\/([^?]+)/.exec(url);
  const path = decodeURIComponent(m[1]);
  const method = opts.method || 'GET';
  const res = (status, body, text) => ({ status, ok: status < 300, json: async () => body, text: async () => text });
  assert.strictEqual(opts.headers.Authorization, 'Bearer test-token');
  if (method === 'GET') {
    const f = files[path];
    if (!f) return res(404, { message: 'Not Found' }, '');
    if (/raw/.test(opts.headers.Accept)) return res(200, null, f.content);
    return res(200, { content: Buffer.from(f.content).toString('base64'), sha: f.sha });
  }
  const body = JSON.parse(opts.body);
  const f = files[path];
  if (f && body.sha !== f.sha) return res(409, { message: 'sha mismatch' });
  if (!f && body.sha) return res(422, { message: 'unexpected sha' });
  files[path] = { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: 's' + (++shaN) };
  return res(200, { content: { path } });
};

const H = { 'x-admin-request': '1', host: 'admin.test', origin: 'https://admin.test' };
const ev = (method, body, headers) => ({ httpMethod: method, headers: Object.assign({}, H, headers), body: body ? JSON.stringify(body) : undefined });

(async () => {
  const pass = 'correct horse battery';
  process.env.ADMIN_PASS_HASH = await L.hashPassword(pass);
  assert(/^scrypt:16384:[0-9a-f]{32}:[0-9a-f]{128}$/.test(process.env.ADMIN_PASS_HASH));
  assert(await L.verifyPassword(pass, process.env.ADMIN_PASS_HASH.replace(/:/g, '$'))); // legacy format still works
  assert(await L.verifyPassword(pass, process.env.ADMIN_PASS_HASH));
  assert(!(await L.verifyPassword('wrong', process.env.ADMIN_PASS_HASH)));
  console.log('ok  password hashing');

  // data without session
  assert.strictEqual((await data(ev('GET'))).statusCode, 401);
  assert.strictEqual((await data(ev('GET', null, { cookie: L.COOKIE_NAME + '=abc.def' }))).statusCode, 401);
  console.log('ok  data endpoint rejects missing/forged cookie');

  // login guards
  assert.strictEqual((await login(ev('POST', { username: 'admin', password: pass }, { 'x-admin-request': undefined }))).statusCode, 403);
  assert.strictEqual((await login(ev('POST', { username: 'admin', password: pass }, { origin: 'https://evil.test' }))).statusCode, 403);
  assert.strictEqual((await login(ev('GET'))).statusCode, 405);
  console.log('ok  login needs header + same origin + POST');

  // wrong creds + lockout
  const bad = { 'x-nf-client-connection-ip': '9.9.9.9' };
  for (let i = 0; i < 5; i++) assert.strictEqual((await login(ev('POST', { username: 'admin', password: 'nope' }, bad))).statusCode, 401);
  assert.strictEqual((await login(ev('POST', { username: 'admin', password: pass }, bad))).statusCode, 429);
  console.log('ok  lockout after 5 failures');

  // good login (other IP)
  const good = await login(ev('POST', { username: 'admin', password: pass }, { 'x-nf-client-connection-ip': '8.8.8.8' }));
  assert.strictEqual(good.statusCode, 200);
  const sc = good.headers['Set-Cookie'];
  assert(/^__Host-admin_session=/.test(sc) && /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\//.test(sc) && !/Domain=/.test(sc));
  const cookie = sc.split(';')[0];
  console.log('ok  login sets __Host- HttpOnly Secure SameSite=Strict cookie');

  // expired + tampered
  const expired = L.signSession({ u: 'admin', exp: Math.floor(Date.now() / 1000) - 5 }, process.env.ADMIN_SESSION_SECRET);
  assert.strictEqual((await data(ev('GET', null, { cookie: L.COOKIE_NAME + '=' + expired }))).statusCode, 401);
  // flip a character in the middle of the signature (the last base64 char only carries padding bits)
const eq = cookie.indexOf('=') + 1, dot = cookie.indexOf('.');
const mid = dot + 5;
const tampered = cookie.slice(0, mid) + (cookie[mid] === 'A' ? 'B' : 'A') + cookie.slice(mid + 1);
assert(eq > 0);
  assert.strictEqual((await data(ev('GET', null, { cookie: tampered }))).statusCode, 401);
  console.log('ok  expired and tampered sessions rejected');

  // list
  const C = { cookie };
  let r = await data(ev('GET', null, C));
  assert.strictEqual(r.statusCode, 200);
  let j = JSON.parse(r.body);
  assert.strictEqual(j.messages.length, 1);
  assert.strictEqual(j.appointments.length, 1);
  assert.strictEqual(j.messages[0].message, 'Hello <b>there</b>, nice site'); // decoded, rendered via textContent in UI
  const a = j.appointments[0];
  assert.strictEqual(a.phone, '+91 98765 43210');
  assert.strictEqual(a.preferredDate, '2099-12-01T15:30');
  assert.strictEqual(a.reason, 'Ethical hacking mentorship');
  assert.strictEqual(a.notes, "I'm a beginner & keen.");
  assert(!r.body.includes('scrypt') && !r.body.includes(process.env.ADMIN_SESSION_SECRET));
  console.log('ok  messages vs appointments split, fields parsed, no secrets in response');

  // writes
  assert.strictEqual((await data(ev('POST', { action: 'set-status', id: 'sub_1730000000001', status: 'done' }, { cookie, 'x-admin-request': undefined }))).statusCode, 403);
  assert.strictEqual((await data(ev('POST', { action: 'set-status', id: 'sub_1730000000001', status: 'done' }, { cookie, origin: 'https://evil.test' }))).statusCode, 403);
  assert.strictEqual((await data(ev('POST', { action: 'set-status', id: '../x', status: 'done' }, C))).statusCode, 400);
  assert.strictEqual((await data(ev('POST', { action: 'set-status', id: 'sub_1730000000001', status: 'weird' }, C))).statusCode, 400);
  assert.strictEqual((await data(ev('POST', { action: 'nuke', id: 'sub_1730000000001' }, C))).statusCode, 400);
  assert.strictEqual((await data(ev('POST', { action: 'set-status', id: 'sub_1730000000001', status: 'done' }, C))).statusCode, 200);
  assert.strictEqual((await data(ev('POST', { action: 'set-note', id: 'sub_1730000000001', note: 'call back' }, C))).statusCode, 200);
  j = JSON.parse((await data(ev('GET', null, C))).body);
  assert.strictEqual(j.messages[0].status, 'done');
  assert.strictEqual(j.messages[0].note, 'call back');
  console.log('ok  status + note saved; bad ids/status/actions/origin rejected');

  // submissions file never modified by admin
  assert.strictEqual(files['contact_submissions.json'].sha, 's0');
  console.log('ok  admin never writes to the submissions file (state is separate)');

  // delete / restore
  assert.strictEqual((await data(ev('POST', { action: 'delete', id: 'sub_1730000000002' }, C))).statusCode, 200);
  j = JSON.parse((await data(ev('GET', null, C))).body);
  assert.strictEqual(j.appointments.length, 0);
  assert.strictEqual((await data(ev('POST', { action: 'restore', id: 'sub_1730000000002' }, C))).statusCode, 200);
  j = JSON.parse((await data(ev('GET', null, C))).body);
  assert.strictEqual(j.appointments.length, 1);
  console.log('ok  soft delete and restore');

  // logout clears cookie
  const lo = await logout(ev('POST', {}, C));
  assert(/Max-Age=0/.test(lo.headers['Set-Cookie']));
  console.log('ok  logout clears cookie');

  console.log('\nALL TESTS PASSED');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });

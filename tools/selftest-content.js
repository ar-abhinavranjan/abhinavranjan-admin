'use strict';
// Offline test for admin-content.js with a mocked GitHub. Run: node tools/selftest-content.js
const assert = require('assert');
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_SESSION_SECRET = 'y'.repeat(10) + 'abcdefghijklmnopqrstuvwxyz0123456789';
process.env.SITE_GITHUB_TOKEN = 'site-token';
process.env.SITE_GITHUB_OWNER = 'o';
process.env.SITE_GITHUB_REPO = 'site';

const L = require('../netlify/functions/_lib');
const content = require('../netlify/functions/admin-content').handler;

const P = 'frontend/data/socials_page.json';
const sha = (n) => 'blob' + n;
let n = 0;
const repo = {};                // path -> { text, sha }
const commits = [];             // { sha, path, text, message }
const original = JSON.stringify([{ id: 's1', platform: 'GitHub', url: 'https://github.com/x' }], null, 4).replace(/\n/g, '\r\n') + '\r\n';
repo[P] = { text: original, sha: sha(0) };
repo['frontend/data/winnings_page.json'] = { text: '{"a":1}', sha: sha('w') };
commits.push({ sha: 'aaaaaaa1111111', path: P, text: original, message: 'first' });

global.fetch = async (url, opts = {}) => {
  const r = (status, body) => ({ status, ok: status < 300, json: async () => body });
  assert.strictEqual(opts.headers.Authorization, 'Bearer site-token');
  const u = new URL(url);
  const m = /\/contents\/(.+)$/.exec(u.pathname);
  if (m) {
    const path = decodeURIComponent(m[1]);
    if ((opts.method || 'GET') === 'GET') {
      const ref = u.searchParams.get('ref');
      const c = commits.find((x) => x.sha === ref && x.path === path);
      const f = c ? { text: c.text, sha: 'old' } : repo[path];
      if (!f) return r(404, {});
      return r(200, { content: Buffer.from(f.text).toString('base64'), sha: f.sha });
    }
    const b = JSON.parse(opts.body);
    if (!repo[path] || repo[path].sha !== b.sha) return r(409, {});
    const text = Buffer.from(b.content, 'base64').toString('utf8');
    repo[path] = { text, sha: sha(++n) };
    const cs = 'c' + n + '0000000000';
    commits.unshift({ sha: cs, path, text, message: b.message });
    return r(200, { content: { sha: repo[path].sha }, commit: { sha: cs } });
  }
  if (/\/commits$/.test(u.pathname)) {
    const path = u.searchParams.get('path');
    return r(200, commits.filter((c) => c.path === path).map((c) => ({ sha: c.sha, commit: { message: c.message, author: { date: '2026-10-26T10:00:00Z' } } })));
  }
  return r(404, {});
};

const H = { 'x-admin-request': '1', host: 'admin.test', origin: 'https://admin.test' };
const now = Math.floor(Date.now() / 1000);
const cookie = L.COOKIE_NAME + '=' + L.signSession({ u: 'admin', exp: now + 600 }, process.env.ADMIN_SESSION_SECRET);
const get = (q, c) => content({ httpMethod: 'GET', headers: Object.assign({}, H, c === false ? {} : { cookie }), queryStringParameters: q });
const post = (b, extra) => content({ httpMethod: 'POST', headers: Object.assign({}, H, { cookie }, extra), body: JSON.stringify(b) });

(async () => {
  assert.strictEqual((await get({ action: 'list' }, false)).statusCode, 401);
  let r = JSON.parse((await get({ action: 'list' })).body);
  assert(r.ok && r.configured && r.files.length >= 8);
  assert(!r.files.some((f) => /lts_podcasts|blogs\.json/.test(f.path)), 'podcast passwords / blogs not editable');
  console.log('ok  auth required; allowlist excludes podcasts (passwords) and blogs');

  assert.strictEqual((await get({ action: 'get', path: '../../etc/passwd' })).statusCode, 403);
  assert.strictEqual((await get({ action: 'get', path: 'frontend/data/lts_podcasts.json' })).statusCode, 403);
  assert.strictEqual((await get({ action: 'get', path: 'netlify.toml' })).statusCode, 403);
  assert.strictEqual((await post({ action: 'save', path: 'index.html', sha: 'x', data: [] })).statusCode, 403);
  console.log('ok  paths outside the allowlist are refused (reads and writes)');

  r = JSON.parse((await get({ action: 'get', path: P })).body);
  assert(r.ok && Array.isArray(r.data) && r.sha === sha(0));
  const base = { path: P, sha: r.sha };

  const bad = async (data, re) => {
    const x = await post(Object.assign({ action: 'save', data }, base));
    assert.strictEqual(x.statusCode, 422, JSON.stringify(data));
    assert(re.test(JSON.parse(x.body).error), JSON.parse(x.body).error);
  };
  await bad({ a: 1 }, /structure/);
  await bad([{ id: 'x', note: '<script>alert(1)</script>' }], /HTML/);
  await bad([{ id: 'x', note: '<img src=x onerror=alert(1)>' }], /HTML/);
  await bad([{ id: 'x', url: 'javascript:alert(1)' }], /Unsafe link/);
  await bad([{ id: 'x', url: ' DATA:text/html,hi' }], /Unsafe link/);
  await bad([{ id: 'x', t: 'a'.repeat(5001) }], /too long/);
  assert.strictEqual(repo[P].sha, sha(0), 'nothing was written by rejected saves');
  console.log('ok  rejects wrong structure, HTML tags, javascript:/data: links, huge text');

  // guards
  assert.strictEqual((await post(Object.assign({ action: 'save', data: [] }, base), { 'x-admin-request': undefined })).statusCode, 403);
  assert.strictEqual((await post(Object.assign({ action: 'save', data: [] }, base), { origin: 'https://evil.test' })).statusCode, 403);
  console.log('ok  writes need custom header and same origin');

  // good save keeps CRLF + 4-space indent
  const next = [{ id: 's1', platform: 'GitHub', url: 'https://github.com/x' }, { id: 's2', platform: 'Insta', url: 'https://instagram.com/y' }];
  let s = await post(Object.assign({ action: 'save', data: next }, base));
  assert.strictEqual(s.statusCode, 200, s.body);
  const saved = JSON.parse(s.body);
  assert.strictEqual(saved.sha, sha(1));
  assert(repo[P].text.includes('\r\n    {'), 'keeps CRLF and 4-space indent');
  assert.deepStrictEqual(JSON.parse(repo[P].text), next);
  assert.strictEqual(commits[0].message, 'admin: update Social media');
  console.log('ok  save commits with a clear message and keeps the file style');

  // stale sha
  s = await post(Object.assign({ action: 'save', data: next }, base));
  assert.strictEqual(s.statusCode, 409);
  console.log('ok  stale save is refused (no overwrite of newer edits)');

  // unchanged
  s = await post({ action: 'save', path: P, sha: saved.sha, data: next });
  assert(JSON.parse(s.body).unchanged);
  console.log('ok  identical content makes no commit');

  // history + restore
  r = JSON.parse((await get({ action: 'history', path: P })).body);
  assert(r.ok && r.commits.length === 2 && r.commits[1].short === 'aaaaaaa');
  const rs = await post({ action: 'restore', path: P, sha: saved.sha, ref: 'aaaaaaa1111111' });
  assert.strictEqual(rs.statusCode, 200, rs.body);
  assert.strictEqual(JSON.parse(repo[P].text).length, 1);
  assert.strictEqual((await post({ action: 'restore', path: P, sha: repo[P].sha, ref: '../bad' })).statusCode, 400);
  console.log('ok  history lists versions; restore writes the old version as a new commit');

  // not configured
  delete process.env.SITE_GITHUB_TOKEN;
  r = JSON.parse((await get({ action: 'list' })).body);
  assert.strictEqual(r.configured, false);
  assert.strictEqual((await get({ action: 'get', path: P })).statusCode, 503);
  console.log('ok  clear "not configured" state without the token');

  console.log('\nCONTENT TESTS PASSED');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });

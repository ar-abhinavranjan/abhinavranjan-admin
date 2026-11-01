'use strict';
/**
 * admin-content.js — edit the main site's JSON content files from the admin panel.
 *
 * Safety rules enforced HERE (the browser UI is not a gate):
 *  - valid signed admin session required for everything
 *  - only files listed in content-files.json can be read or written (exact path match)
 *  - top-level structure (array vs object) must not change
 *  - no HTML tags, no javascript:/data: links, size and depth limits
 *  - writes are compare-and-swap on the file's blob sha, so nobody overwrites newer edits
 *  - every save is a normal Git commit, so History / Restore can always undo it
 *
 * Env (Netlify): SITE_GITHUB_TOKEN (fine-grained, ONLY the main site repo, Contents: Read and write),
 *                SITE_GITHUB_REPO, SITE_GITHUB_OWNER (optional), SITE_GITHUB_BRANCH (optional, default main)
 */

const L = require('./_lib');
const FILES = require('./content-files.json');

const MAX_BYTES = 300 * 1024;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/* ---------- GitHub (main site repo) ---------- */

function site() {
  const token = process.env.SITE_GITHUB_TOKEN;
  const owner = process.env.SITE_GITHUB_OWNER || process.env.GITHUB_REPO_OWNER;
  const repo = process.env.SITE_GITHUB_REPO;
  if (!token || !owner || !repo) {
    const e = new Error('not configured');
    e.code = 'CONFIG';
    throw e;
  }
  return { token, owner, repo, branch: process.env.SITE_GITHUB_BRANCH || 'main' };
}

function headers(s) {
  return {
    Authorization: `Bearer ${s.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'admin-abhinavranjan',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function enc(path) { return path.split('/').map(encodeURIComponent).join('/'); }

async function getFile(path, ref) {
  const s = site();
  const res = await fetch(`https://api.github.com/repos/${s.owner}/${s.repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref || s.branch)}`, { headers: headers(s) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
  const f = await res.json();
  if (typeof f.content !== 'string') throw new Error('Unexpected GitHub response');
  return { text: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha };
}

async function putFile(path, text, sha, message) {
  const s = site();
  const res = await fetch(`https://api.github.com/repos/${s.owner}/${s.repo}/contents/${enc(path)}`, {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers(s)),
    body: JSON.stringify({ message, content: Buffer.from(text, 'utf8').toString('base64'), sha, branch: s.branch })
  });
  if (res.status === 409 || res.status === 422) { const e = new Error('conflict'); e.status = 409; throw e; }
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status}`);
  const out = await res.json();
  return { sha: out.content && out.content.sha, commit: out.commit && out.commit.sha };
}

async function history(path) {
  const s = site();
  const res = await fetch(`https://api.github.com/repos/${s.owner}/${s.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(s.branch)}&per_page=10`, { headers: headers(s) });
  if (!res.ok) throw new Error(`GitHub history failed: ${res.status}`);
  const list = await res.json();
  return list.map((c) => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    date: c.commit && c.commit.author && c.commit.author.date,
    message: String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 120)
  }));
}

/* ---------- validation ---------- */

class Bad extends Error { constructor(msg) { super(msg); this.bad = true; } }

function validateContent(data, expectArray) {
  if (data === null || typeof data !== 'object') throw new Bad('Content must be a JSON object or array');
  if (Array.isArray(data) !== expectArray) throw new Bad('The top-level structure of this file cannot change');
  let nodes = 0;
  (function walk(v, depth, where) {
    if (depth > 12) throw new Bad('Content is nested too deeply');
    if (++nodes > 20000) throw new Bad('Content is too large');
    if (typeof v === 'string') {
      if (v.length > 5000) throw new Bad(`Text is too long (${where})`);
      if (/<\s*\/?\s*[a-z!?]/i.test(v)) throw new Bad(`HTML tags are not allowed (${where})`);
      if (/^\s*(javascript|vbscript|data)\s*:/i.test(v)) throw new Bad(`Unsafe link type is not allowed (${where})`);
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Bad(`Invalid number (${where})`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, depth + 1, `${where}[${i}]`));
    } else if (v && typeof v === 'object') {
      Object.keys(v).forEach((k) => {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new Bad('Invalid key name');
        walk(v[k], depth + 1, where ? `${where}.${k}` : k);
      });
    } else if (v !== null && typeof v !== 'boolean') {
      throw new Bad('Unsupported value');
    }
  })(data, 0, '');
}

// Keep the file's existing look (indent width, CRLF) so Git diffs stay small.
function serialize(data, previousText) {
  // indent = the smallest leading-space run on any line (works for arrays of objects too)
  let indent = 0;
  const re = /\n( +)\S/g;
  let m;
  while ((m = re.exec(previousText))) { if (!indent || m[1].length < indent) indent = m[1].length; }
  if (!indent || indent > 8) indent = 2;
  let out = JSON.stringify(data, null, indent) + '\n';
  if (!/\n$/.test(previousText)) out = out.replace(/\r?\n$/, ''); // keep "no final newline" files as they were
  if (previousText.indexOf('\r\n') !== -1) out = out.replace(/\r?\n/g, '\r\n');
  return out;
}

function entryFor(path) { return FILES.find((f) => f.path === path) || null; }
function cleanLabel(s) { return String(s).replace(/[^\w &:,()\-]/g, '').slice(0, 80); }

/* ---------- handler ---------- */

exports.handler = async (event) => {
  const session = L.getSession(event);
  if (!session) return L.json(401, { ok: false, error: 'Not signed in' });

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      if (q.action === 'list') {
        let configured = true;
        try { site(); } catch (e) { configured = false; }
        return L.json(200, { ok: true, configured, files: FILES });
      }
      const entry = entryFor(q.path);
      if (!entry) return L.json(403, { ok: false, error: 'That file cannot be edited here' });

      if (q.action === 'get') {
        const f = await getFile(entry.path);
        if (!f) return L.json(404, { ok: false, error: 'File not found in the repository' });
        let data;
        try { data = JSON.parse(f.text); } catch (e) { return L.json(422, { ok: false, error: 'This file is not valid JSON' }); }
        return L.json(200, { ok: true, path: entry.path, label: entry.label, warn: entry.warn || '', sha: f.sha, data });
      }
      if (q.action === 'history') {
        return L.json(200, { ok: true, commits: await history(entry.path) });
      }
      return L.json(400, { ok: false, error: 'Unknown action' });
    }

    if (event.httpMethod === 'POST') {
      const guard = L.checkWriteRequest(event);
      if (guard) return L.json(403, { ok: false, error: guard });
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return L.json(400, { ok: false, error: 'Invalid request' }); }
      const entry = entryFor(body.path);
      if (!entry) return L.json(403, { ok: false, error: 'That file cannot be edited here' });

      const current = await getFile(entry.path);
      if (!current) return L.json(404, { ok: false, error: 'File not found in the repository' });
      if (typeof body.sha !== 'string' || body.sha !== current.sha) {
        return L.json(409, { ok: false, error: 'This file changed since you opened it. Reload it and re-apply your edit.' });
      }
      let existing;
      try { existing = JSON.parse(current.text); } catch (e) { return L.json(422, { ok: false, error: 'Existing file is not valid JSON' }); }

      let next;
      let message;
      if (body.action === 'save') {
        next = body.data;
        message = `admin: update ${cleanLabel(entry.label)}`;
      } else if (body.action === 'restore') {
        if (!SHA_RE.test(String(body.ref || ''))) return L.json(400, { ok: false, error: 'Invalid version' });
        const old = await getFile(entry.path, body.ref);
        if (!old) return L.json(404, { ok: false, error: 'That version was not found' });
        try { next = JSON.parse(old.text); } catch (e) { return L.json(422, { ok: false, error: 'That version is not valid JSON' }); }
        message = `admin: restore ${cleanLabel(entry.label)} to ${body.ref.slice(0, 7)}`;
      } else {
        return L.json(400, { ok: false, error: 'Unknown action' });
      }

      validateContent(next, Array.isArray(existing));
      const text = serialize(next, current.text);
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return L.json(413, { ok: false, error: 'File would be too large' });
      if (text === current.text) return L.json(200, { ok: true, unchanged: true, sha: current.sha });

      const out = await putFile(entry.path, text, current.sha, message);
      return L.json(200, { ok: true, sha: out.sha, commit: out.commit });
    }

    return L.json(405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    if (err && err.bad) return L.json(422, { ok: false, error: err.message });
    if (err && err.code === 'CONFIG') return L.json(503, { ok: false, code: 'not_configured', error: 'Content editing is not configured yet' });
    if (err && err.status === 409) return L.json(409, { ok: false, error: 'This file changed while saving. Reload it and try again.' });
    console.error('admin-content error:', err && err.message);
    return L.json(500, { ok: false, error: 'Request failed. Please try again.' });
  }
};

// exported for tests
exports.validateContent = validateContent;
exports.serialize = serialize;

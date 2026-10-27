'use strict';
/**
 * _lib.js — shared helpers for the admin functions.
 * Files starting with "_" are not exposed as endpoints.
 *
 * Security model:
 *  - Login verifies a scrypt password hash kept in an env var (never in the repo).
 *  - Session = HMAC-SHA256 signed token in a __Host- cookie (HttpOnly, Secure, SameSite=Strict).
 *  - Every data endpoint re-verifies the cookie on the server. The browser UI is not a gate.
 *  - State-changing requests also need a custom header and a same-origin Origin header.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const COOKIE_NAME = '__Host-admin_session';
const SESSION_TTL_S = 8 * 60 * 60; // 8 hours

/* ---------- responses ---------- */

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      extraHeaders || {}
    ),
    body: JSON.stringify(body)
  };
}

/* ---------- cookies & sessions ---------- */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function sessionSecret() {
  const s = process.env.ADMIN_SESSION_SECRET || '';
  return s.length >= 32 ? s : null;
}

function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

function verifySession(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  let given;
  try { given = Buffer.from(parts[1], 'base64url'); } catch (e) { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
  return payload;
}

function getSession(event) {
  const secret = sessionSecret();
  if (!secret) return null;
  const cookies = parseCookies((event.headers || {}).cookie);
  return verifySession(cookies[COOKIE_NAME], secret);
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/* ---------- passwords ---------- */

// Stored format: scrypt$N$saltHex$hashHex  (r=8, p=1, keylen=64)
async function hashPassword(password, saltHex, N) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const cost = N || 16384;
  const dk = await scrypt(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${cost}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1], 10);
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20) return false;
  let expected;
  try { expected = Buffer.from(parts[3], 'hex'); } catch (e) { return false; }
  const dk = await scrypt(password, Buffer.from(parts[2], 'hex'), expected.length, {
    N, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

function safeEqualStr(a, b) {
  // Compare digests so length differences leak nothing.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------- login throttling (best effort: per warm instance) ---------- */

const attempts = new Map(); // ip -> { count, resetAt }
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

function isLockedOut(ip) {
  const e = attempts.get(ip);
  if (!e) return false;
  if (Date.now() > e.resetAt) { attempts.delete(ip); return false; }
  return e.count >= MAX_FAILS;
}

function recordFail(ip) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now > e.resetAt) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else e.count += 1;
}

function clearFails(ip) { attempts.delete(ip); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- request guards ---------- */

// For POST requests: same-origin + custom header (blocks cross-site form posts).
function checkWriteRequest(event) {
  const h = event.headers || {};
  if (h['x-admin-request'] !== '1') return 'Missing request header';
  const origin = h.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch (e) { return 'Bad origin'; }
    const own = h['x-forwarded-host'] || h.host;
    if (own && host !== own) return 'Cross-origin request blocked';
  }
  return null;
}

/* ---------- GitHub storage (private submissions repo) ---------- */

function gh() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_SUBMISSIONS_REPO;
  if (!token || !owner || !repo) {
    const err = new Error('Storage is not configured');
    err.code = 'CONFIG';
    throw err;
  }
  return {
    token, owner, repo,
    branch: process.env.GITHUB_BRANCH || 'main',
    submissionsPath: process.env.SUBMISSIONS_PATH || 'contact_submissions.json',
    statePath: process.env.STATE_PATH || 'admin_state.json'
  };
}

function ghHeaders(token, accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept || 'application/vnd.github+json',
    'User-Agent': 'admin-abhinavranjan',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function contentsUrl(c, path) {
  return `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}`;
}

// Reads a JSON array file as raw text (works for files larger than 1 MB too).
async function readSubmissions() {
  const c = gh();
  const res = await fetch(`${contentsUrl(c, c.submissionsPath)}?ref=${encodeURIComponent(c.branch)}`, {
    headers: ghHeaders(c.token, 'application/vnd.github.raw+json')
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
  try {
    const data = JSON.parse(await res.text());
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function readState() {
  const c = gh();
  const res = await fetch(`${contentsUrl(c, c.statePath)}?ref=${encodeURIComponent(c.branch)}`, {
    headers: ghHeaders(c.token)
  });
  if (res.status === 404) return { state: {}, sha: null };
  if (!res.ok) throw new Error(`GitHub state read failed: ${res.status}`);
  const file = await res.json();
  let state = {};
  try { state = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8')) || {}; } catch (e) { state = {}; }
  if (typeof state !== 'object' || Array.isArray(state)) state = {};
  return { state, sha: file.sha };
}

// Admin changes (status, notes, soft delete) live in a SEPARATE file, so they can
// never collide with new submissions being appended by the main site.
async function updateState(mutator) {
  const c = gh();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { state, sha } = await readState();
    mutator(state);
    const body = {
      message: 'admin: update state',
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
      branch: c.branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(contentsUrl(c, c.statePath), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(c.token)),
      body: JSON.stringify(body)
    });
    if (res.ok) return state;
    if (res.status === 409 || res.status === 422) continue; // someone else wrote first: retry
    throw new Error(`GitHub state write failed: ${res.status}`);
  }
  throw new Error('GitHub state write conflict');
}

/* ---------- submission parsing ---------- */

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseAppointment(message) {
  const field = (label) => {
    const m = message.match(new RegExp('^' + label + ':[ \\t]*(.*)$', 'mi'));
    return m ? m[1].trim() : '';
  };
  const notesMatch = message.match(/Additional Notes \/ Context:\s*\n([\s\S]*?)\n-{5,}/i);
  return {
    phone: field('Phone Number'),
    preferredDate: field('Preferred Date & Time'),
    reason: field('Reason for Appointment'),
    notes: notesMatch ? notesMatch[1].trim() : ''
  };
}

function shapeItem(sub, st) {
  const message = decodeEntities(sub.message);
  const isAppointment = /^APPOINTMENT REQUEST DETAILS/i.test(message.trim());
  const item = {
    id: String(sub.id || ''),
    timestamp: sub.timestamp || '',
    name: decodeEntities(sub.name),
    email: decodeEntities(sub.email),
    phone: decodeEntities(sub.contactNo || ''),
    message,
    ip: sub.source_ip || '',
    kind: isAppointment ? 'appointment' : 'message',
    status: ['new', 'read', 'done'].includes(st && st.status) ? st.status : 'new',
    note: (st && st.note) || ''
  };
  if (isAppointment) {
    const a = parseAppointment(message);
    item.phone = a.phone || item.phone;
    item.preferredDate = a.preferredDate;
    item.reason = a.reason;
    item.notes = a.notes;
  }
  return item;
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_S,
  json, getSession, signSession, verifySession, sessionCookie, clearCookie, sessionSecret,
  hashPassword, verifyPassword, safeEqualStr,
  clientIp, isLockedOut, recordFail, clearFails, sleep,
  checkWriteRequest,
  readSubmissions, readState, updateState,
  shapeItem, parseAppointment, decodeEntities
};

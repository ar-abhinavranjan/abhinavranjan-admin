'use strict';
const L = require('./_lib');

const ID_RE = /^sub_\d{6,20}$/;
const STATUSES = ['new', 'read', 'done'];

exports.handler = async (event) => {
  // Server-side gate: no valid signed session cookie, no data. Ever.
  const session = L.getSession(event);
  if (!session) return L.json(401, { ok: false, error: 'Not signed in' });

  try {
    if (event.httpMethod === 'GET') {
      const [subs, { state }] = await Promise.all([L.readSubmissions(), L.readState()]);
      const items = subs
        .map((s) => L.shapeItem(s, state[s.id]))
        .filter((it) => it.id && !(state[it.id] && state[it.id].deleted));
      const messages = items.filter((i) => i.kind === 'message');
      const appointments = items.filter((i) => i.kind === 'appointment');
      const byNewest = (a, b) => String(b.timestamp).localeCompare(String(a.timestamp));
      messages.sort(byNewest);
      appointments.sort(byNewest);
      return L.json(200, { ok: true, user: session.u, messages, appointments });
    }

    if (event.httpMethod === 'POST') {
      const guard = L.checkWriteRequest(event);
      if (guard) return L.json(403, { ok: false, error: guard });

      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return L.json(400, { ok: false, error: 'Invalid request' }); }
      const { action, id } = body;
      if (!ID_RE.test(String(id || ''))) return L.json(400, { ok: false, error: 'Invalid id' });

      let mutate;
      if (action === 'set-status') {
        if (!STATUSES.includes(body.status)) return L.json(400, { ok: false, error: 'Invalid status' });
        mutate = (st) => { st[id] = Object.assign({}, st[id], { status: body.status }); };
      } else if (action === 'set-note') {
        const note = String(body.note == null ? '' : body.note).slice(0, 1000);
        mutate = (st) => { st[id] = Object.assign({}, st[id], { note }); };
      } else if (action === 'delete') {
        mutate = (st) => { st[id] = Object.assign({}, st[id], { deleted: true }); };
      } else if (action === 'restore') {
        mutate = (st) => { st[id] = Object.assign({}, st[id], { deleted: false }); };
      } else {
        return L.json(400, { ok: false, error: 'Unknown action' });
      }

      await L.updateState(mutate);
      return L.json(200, { ok: true });
    }

    return L.json(405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('admin-data error:', err && err.code === 'CONFIG' ? 'storage not configured' : (err && err.message));
    return L.json(500, { ok: false, error: 'Request failed. Please try again.' });
  }
};

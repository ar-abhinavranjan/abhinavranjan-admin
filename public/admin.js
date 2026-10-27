/* admin.js — vanilla JS, no build step. All visitor text is inserted with textContent only. */
(function () {
  'use strict';

  var cfg = {
    appName: 'AR. Admin', subtitle: '', accent: '#d4af37', timezone: 'Asia/Kolkata',
    locale: 'en-IN', defaultCountryCode: '91', refreshSeconds: 60
  };
  var S = {
    data: { messages: [], appointments: [] },
    tab: 'overview', filter: 'all', query: '', sort: 'newest',
    selectedId: null, loaded: false, timer: null
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- tiny DOM helper ---------- */
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    props = props || {};
    if (props.className) n.className = props.className;
    if (props.text != null) n.textContent = props.text;
    if (props.attrs) Object.keys(props.attrs).forEach(function (k) { n.setAttribute(k, props.attrs[k]); });
    if (props.on) Object.keys(props.on).forEach(function (k) { n.addEventListener(k, props.on[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg, opts) {
    opts = opts || {};
    var t = $('toast');
    clear(t);
    t.className = 'toast' + (opts.bad ? ' bad' : '');
    t.appendChild(el('span', { text: msg }));
    if (opts.action) {
      t.appendChild(el('button', {
        className: 'btn small', text: opts.action.label,
        on: { click: function () { hideToast(); opts.action.run(); } }
      }));
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.action ? 8000 : 3500);
  }
  function hideToast() { $('toast').hidden = true; }

  /* ---------- dates ---------- */
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso || '';
    try {
      return new Intl.DateTimeFormat(cfg.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: cfg.timezone }).format(d);
    } catch (e) { return d.toLocaleString(); }
  }
  function naiveMs(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(str || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
  }
  function fmtNaive(str) {
    var ms = naiveMs(str);
    if (isNaN(ms)) return str || '—';
    return new Intl.DateTimeFormat(cfg.locale, { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(ms));
  }
  function nowNaive() {
    try {
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
      var g = {};
      parts.forEach(function (p) { g[p.type] = p.value; });
      return Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute);
    } catch (e) { return Date.now(); }
  }

  /* ---------- api ---------- */
  function api(path, method, body) {
    var opts = {
      method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, body: j }; });
    });
  }

  /* ---------- screens ---------- */
  function showLogin(msg) {
    stopTimer();
    $('app').hidden = true;
    $('login').hidden = false;
    S.loaded = false;
    S.data = { messages: [], appointments: [] };
    if (msg) { $('loginError').textContent = msg; $('loginError').hidden = false; }
    $('password').value = '';
    $('password').type = 'password';
    $('togglePw').textContent = 'Show';
    $('username').focus();
  }
  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    startTimer();
  }

  /* ---------- load ---------- */
  var loading = false;
  function load(quiet) {
    if (loading) return Promise.resolve();
    loading = true;
    return api('/api/admin-data').then(function (r) {
      loading = false;
      if (r.status === 401) { showLogin(S.loaded ? 'Session expired. Please sign in again.' : ''); return; }
      if (!r.body.ok) { if (!quiet) toast(r.body.error || 'Could not load data', { bad: true }); return; }
      S.data.messages = r.body.messages || [];
      S.data.appointments = r.body.appointments || [];
      S.loaded = true;
      showApp();
      $('lastSync').textContent = 'Last updated ' + new Intl.DateTimeFormat(cfg.locale, { timeStyle: 'medium', timeZone: cfg.timezone }).format(new Date());
      render(quiet);
    }).catch(function () {
      loading = false;
      if (!quiet) toast('Network error. Check your connection.', { bad: true });
    });
  }
  function startTimer() {
    stopTimer();
    var sec = Math.max(15, Number(cfg.refreshSeconds) || 60);
    S.timer = setInterval(function () { if (!document.hidden) load(true); }, sec * 1000);
  }
  function stopTimer() { if (S.timer) clearInterval(S.timer); S.timer = null; }

  /* ---------- helpers ---------- */
  function itemsFor(tab) { return tab === 'appointments' ? S.data.appointments : S.data.messages; }
  function findItem(id) {
    var all = S.data.messages.concat(S.data.appointments);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function isUpcoming(a) {
    var ms = naiveMs(a.preferredDate);
    return !isNaN(ms) && ms >= nowNaive() && a.status !== 'done';
  }
  function countNew(list) { return list.filter(function (i) { return i.status === 'new'; }).length; }

  /* ---------- render ---------- */
  function render(quiet) {
    var nm = countNew(S.data.messages), na = countNew(S.data.appointments);
    setBadge('badgeMessages', nm);
    setBadge('badgeAppointments', na);
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === S.tab);
    });
    if (S.tab === 'overview') {
      $('viewOverview').hidden = false; $('viewList').hidden = true;
      renderOverview();
    } else {
      $('viewOverview').hidden = true; $('viewList').hidden = false;
      renderList();
      var focusedNote = document.activeElement && document.activeElement.id === 'noteField';
      if (!(quiet && focusedNote)) renderDetail();
    }
  }
  function setBadge(id, n) { var b = $(id); b.textContent = String(n); b.hidden = n === 0; }

  function statCard(num, label, tab, filter) {
    return el('button', {
      className: 'card', attrs: { type: 'button' },
      on: { click: function () { gotoFilter(tab, filter); } }
    }, [
      el('div', { className: 'num', text: String(num) }),
      el('div', { className: 'lbl', text: label })
    ]);
  }
  function gotoFilter(tab, filter) {
    S.tab = tab; S.filter = filter || 'all'; S.query = ''; $('search').value = '';
    S.selectedId = null; $('detail').classList.remove('open');
    setupSort();
    if (tab === 'appointments' && filter === 'upcoming') { S.filter = 'all'; S.sort = 'soonest'; setupSort(); }
    render();
  }
  function miniRow(item, tab, whenText, snippet) {
    return el('li', {
      className: 'item', attrs: { tabindex: '0', role: 'button' },
      on: {
        click: function () { gotoItem(tab, item.id); },
        keydown: function (e) { if (e.key === 'Enter') gotoItem(tab, item.id); }
      }
    }, [
      el('div', { className: 'row' }, [
        el('span', { className: 'who' }, [el('span', { className: 'dot ' + item.status }), document.createTextNode(item.name || '(no name)')]),
        el('span', { className: 'when', text: whenText })
      ]),
      el('div', { className: 'snippet', text: snippet })
    ]);
  }
  function renderOverview() {
    var v = $('viewOverview');
    clear(v);
    var m = S.data.messages, a = S.data.appointments;
    var upcoming = a.filter(isUpcoming).sort(function (x, y) { return naiveMs(x.preferredDate) - naiveMs(y.preferredDate); });
    v.appendChild(el('div', { className: 'cards' }, [
      statCard(countNew(m), 'New messages', 'messages', 'new'),
      statCard(countNew(a), 'New appointment requests', 'appointments', 'new'),
      statCard(upcoming.length, 'Upcoming appointments', 'appointments', 'upcoming'),
      statCard(m.length, 'Messages total', 'messages', 'all'),
      statCard(a.length, 'Appointments total', 'appointments', 'all')
    ]));

    v.appendChild(el('h2', { className: 'section-title', text: 'Next appointments' }));
    var ul1 = el('ul', { className: 'items' });
    if (!upcoming.length) ul1.appendChild(el('li', { className: 'muted', text: 'No upcoming appointments.' }));
    upcoming.slice(0, 5).forEach(function (x) { ul1.appendChild(miniRow(x, 'appointments', fmtNaive(x.preferredDate), x.reason || 'Appointment')); });
    v.appendChild(ul1);

    v.appendChild(el('h2', { className: 'section-title', text: 'Latest messages' }));
    var ul2 = el('ul', { className: 'items' });
    if (!m.length) ul2.appendChild(el('li', { className: 'muted', text: 'No messages yet.' }));
    m.slice(0, 5).forEach(function (x) { ul2.appendChild(miniRow(x, 'messages', fmtDate(x.timestamp), x.message)); });
    v.appendChild(ul2);
  }

  function gotoItem(tab, id) {
    S.tab = tab; S.filter = 'all'; S.query = ''; $('search').value = '';
    S.selectedId = id;
    setupSort();
    render();
    $('detail').classList.add('open');
  }

  function setupSort() {
    var sel = $('sort');
    var opts = S.tab === 'appointments'
      ? [['newest', 'Newest request'], ['soonest', 'Appointment date'], ['oldest', 'Oldest request']]
      : [['newest', 'Newest first'], ['oldest', 'Oldest first']];
    if (!opts.some(function (o) { return o[0] === S.sort; })) S.sort = 'newest';
    clear(sel);
    opts.forEach(function (o) {
      var op = el('option', { text: o[1], attrs: { value: o[0] } });
      if (o[0] === S.sort) op.selected = true;
      sel.appendChild(op);
    });
  }

  function visibleItems() {
    var q = S.query.trim().toLowerCase();
    var list = itemsFor(S.tab).filter(function (i) {
      if (S.filter !== 'all' && i.status !== S.filter) return false;
      if (!q) return true;
      return [i.name, i.email, i.phone, i.message, i.reason].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    list = list.slice();
    if (S.sort === 'oldest') list.sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); });
    else if (S.sort === 'soonest') list.sort(function (a, b) {
      var x = naiveMs(a.preferredDate), y = naiveMs(b.preferredDate);
      if (isNaN(x)) return 1; if (isNaN(y)) return -1; return x - y;
    });
    else list.sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
    return list;
  }

  function renderList() {
    var all = itemsFor(S.tab);
    var chips = $('chips');
    clear(chips);
    [['all', 'All'], ['new', 'New'], ['read', 'Read'], ['done', 'Done']].forEach(function (c) {
      var n = c[0] === 'all' ? all.length : all.filter(function (i) { return i.status === c[0]; }).length;
      chips.appendChild(el('button', {
        className: 'chip' + (S.filter === c[0] ? ' active' : ''), text: c[1] + ' ' + n, attrs: { type: 'button' },
        on: { click: function () { S.filter = c[0]; render(); } }
      }));
    });

    var ul = $('items');
    clear(ul);
    var list = visibleItems();
    $('empty').hidden = list.length > 0;
    list.forEach(function (i) {
      var when = S.tab === 'appointments' && i.preferredDate ? fmtNaive(i.preferredDate) : fmtDate(i.timestamp);
      var snippet = S.tab === 'appointments' ? (i.reason || 'Appointment request') : i.message;
      var li = el('li', {
        className: 'item' + (i.id === S.selectedId ? ' selected' : ''), attrs: { tabindex: '0', role: 'button' },
        on: {
          click: function () { select(i.id); },
          keydown: function (e) { if (e.key === 'Enter') select(i.id); }
        }
      }, [
        el('div', { className: 'row' }, [
          el('span', { className: 'who' }, [el('span', { className: 'dot ' + i.status }), document.createTextNode(i.name || '(no name)')]),
          el('span', { className: 'when', text: when })
        ]),
        el('div', { className: 'snippet', text: snippet })
      ]);
      ul.appendChild(li);
    });
  }

  function select(id) {
    S.selectedId = id;
    renderList();
    renderDetail();
    $('detail').classList.add('open');
  }

  function kv(dl, k, v) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: v || '—' }));
  }
  function whatsappHref(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (d.charAt(0) === '0') d = d.replace(/^0+/, '');
    if (d.length === 10) d = cfg.defaultCountryCode + d;
    return d.length >= 11 ? 'https://wa.me/' + d : '';
  }

  function renderDetail() {
    var body = $('detailBody');
    clear(body);
    var item = S.selectedId ? findItem(S.selectedId) : null;
    if (!item || itemsFor(S.tab).indexOf(item) === -1) {
      body.appendChild(el('p', { className: 'muted', text: 'Select an item to see its details.' }));
      return;
    }
    var isAppt = item.kind === 'appointment';

    body.appendChild(el('div', { className: 'detail-head' }, [
      el('h2', { text: item.name || '(no name)' }),
      el('span', { className: 'pill ' + item.status, text: item.status })
    ]));

    var dl = el('dl', { className: 'kv' });
    kv(dl, 'Email', item.email);
    kv(dl, 'Phone', item.phone);
    if (isAppt) {
      kv(dl, 'Preferred time', fmtNaive(item.preferredDate));
      kv(dl, 'Reason', item.reason);
    }
    kv(dl, 'Received', fmtDate(item.timestamp));
    kv(dl, 'IP address', item.ip);
    body.appendChild(dl);

    body.appendChild(el('h3', { className: 'section-title', text: isAppt ? 'Notes from the visitor' : 'Message' }));
    body.appendChild(el('div', { className: 'body-text', text: isAppt ? (item.notes || 'None provided.') : item.message }));

    var row = el('div', { className: 'btn-row' });
    ['new', 'read', 'done'].forEach(function (s) {
      if (s === item.status) return;
      row.appendChild(el('button', {
        className: 'btn small', text: 'Mark ' + s, attrs: { type: 'button' },
        on: { click: function () { setStatus(item, s); } }
      }));
    });
    if (item.email && item.email.indexOf('@') > 0) {
      var subject = isAppt ? 'Your appointment request' : 'Re: your message';
      row.appendChild(el('a', {
        className: 'btn small', text: 'Reply by email',
        attrs: { href: 'mailto:' + encodeURIComponent(item.email) + '?subject=' + encodeURIComponent(subject) }
      }));
    }
    var wa = whatsappHref(item.phone);
    if (wa) {
      row.appendChild(el('a', {
        className: 'btn small', text: 'WhatsApp',
        attrs: { href: wa, target: '_blank', rel: 'noopener noreferrer' }
      }));
    }
    row.appendChild(el('button', {
      className: 'btn small danger', text: 'Delete', attrs: { type: 'button' },
      on: { click: function () { removeItem(item); } }
    }));
    body.appendChild(row);

    body.appendChild(el('label', { className: 'note-label', text: 'Private note (only you see this)', attrs: { for: 'noteField' } }));
    var ta = el('textarea', { attrs: { id: 'noteField', maxlength: '1000' } });
    ta.value = item.note || '';
    body.appendChild(ta);
    body.appendChild(el('div', { className: 'btn-row' }, [
      el('button', {
        className: 'btn small', text: 'Save note', attrs: { type: 'button' },
        on: { click: function () { saveNote(item, ta.value); } }
      })
    ]));
  }

  /* ---------- actions ---------- */
  function post(payload) { return api('/api/admin-data', 'POST', payload); }

  function setStatus(item, status) {
    var prev = item.status;
    item.status = status;
    render();
    post({ action: 'set-status', id: item.id, status: status }).then(function (r) {
      if (r.status === 401) { showLogin('Session expired. Please sign in again.'); return; }
      if (!r.body.ok) { item.status = prev; render(); toast(r.body.error || 'Could not update', { bad: true }); }
    }).catch(function () { item.status = prev; render(); toast('Network error', { bad: true }); });
  }

  function saveNote(item, text) {
    post({ action: 'set-note', id: item.id, note: text }).then(function (r) {
      if (r.status === 401) { showLogin('Session expired. Please sign in again.'); return; }
      if (r.body.ok) { item.note = text.slice(0, 1000); toast('Note saved'); }
      else toast(r.body.error || 'Could not save note', { bad: true });
    }).catch(function () { toast('Network error', { bad: true }); });
  }

  function removeItem(item) {
    if (!window.confirm('Delete this ' + item.kind + ' from the admin view?')) return;
    post({ action: 'delete', id: item.id }).then(function (r) {
      if (r.status === 401) { showLogin('Session expired. Please sign in again.'); return; }
      if (!r.body.ok) { toast(r.body.error || 'Could not delete', { bad: true }); return; }
      S.selectedId = null;
      $('detail').classList.remove('open');
      toast('Deleted', {
        action: {
          label: 'Undo',
          run: function () { post({ action: 'restore', id: item.id }).then(function () { load(); }); }
        }
      });
      load(true);
    }).catch(function () { toast('Network error', { bad: true }); });
  }

  /* ---------- events ---------- */
  function wire() {
    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('loginBtn');
      btn.disabled = true;
      $('loginError').hidden = true;
      api('/api/admin-login', 'POST', { username: $('username').value, password: $('password').value })
        .then(function (r) {
          btn.disabled = false;
          if (r.body.ok) { $('password').value = ''; load(); }
          else { $('loginError').textContent = r.body.error || 'Sign in failed'; $('loginError').hidden = false; $('password').value = ''; }
        })
        .catch(function () {
          btn.disabled = false;
          $('loginError').textContent = 'Network error. Try again.';
          $('loginError').hidden = false;
        });
    });

    $('togglePw').addEventListener('click', function () {
      var show = $('password').type === 'password';
      $('password').type = show ? 'text' : 'password';
      this.textContent = show ? 'Hide' : 'Show';
      this.setAttribute('aria-pressed', show ? 'true' : 'false');
      this.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    $('password').addEventListener('keydown', function (e) {
      if (e.getModifierState) $('capsHint').hidden = !e.getModifierState('CapsLock');
    });
    $('password').addEventListener('keyup', function (e) {
      if (e.getModifierState) $('capsHint').hidden = !e.getModifierState('CapsLock');
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () {
        S.tab = b.getAttribute('data-tab');
        S.filter = 'all'; S.query = ''; $('search').value = '';
        S.selectedId = null;
        $('detail').classList.remove('open');
        setupSort();
        render();
      });
    });

    $('search').addEventListener('input', function (e) { S.query = e.target.value; renderList(); });
    $('sort').addEventListener('change', function (e) { S.sort = e.target.value; renderList(); });
    $('refreshBtn').addEventListener('click', function () { load(); });
    $('backBtn').addEventListener('click', function () { $('detail').classList.remove('open'); });
    $('logoutBtn').addEventListener('click', function () {
      api('/api/admin-logout', 'POST', {}).then(function () { showLogin(''); }).catch(function () { showLogin(''); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') $('detail').classList.remove('open');
    });
  }

  /* ---------- boot ---------- */
  function boot() {
    fetch('/config.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (c) {
        Object.keys(c || {}).forEach(function (k) { cfg[k] = c[k]; });
        document.documentElement.style.setProperty('--accent', cfg.accent);
        document.title = cfg.appName;
        $('loginTitle').textContent = cfg.appName;
        $('brandName').textContent = cfg.appName;
        $('brandSub').textContent = cfg.subtitle || '';
        wire();
        setupSort();
        return load();
      })
      .then(function () { if (!S.loaded) showLogin(''); });
  }
  boot();
})();

/* content.js — Content tab: edit the main site's JSON files with a generic form editor.
   All text is inserted with textContent / .value only. Loaded after admin.js. */
(function () {
  'use strict';

  var C = {
    inited: false, configured: true, files: [], path: null, label: '', warn: '',
    sha: null, original: '', draft: null, mode: 'form', open: {}, rawError: '', busy: false
  };

  var $ = function (id) { return document.getElementById(id); };
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
  function say(msg, bad) { if (window.ARToast) window.ARToast(msg, bad); }

  function api(path, method, body) {
    var opts = {
      method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.status === 401 && window.ARSessionExpired) window.ARSessionExpired();
        return { status: res.status, body: j };
      });
    });
  }

  /* ---------- dirty tracking ---------- */
  function snapshot() { return JSON.stringify(C.draft); }
  function isDirty() { return C.draft !== null && snapshot() !== C.original; }
  function refreshBar() {
    var dirty = isDirty();
    var save = $('cSave'), rev = $('cRevert'), tag = $('cDirty');
    if (!save) return;
    save.disabled = !dirty || !!C.rawError || C.busy;
    rev.disabled = !dirty || C.busy;
    tag.hidden = !dirty;
  }

  /* ---------- helpers for the generic editor ---------- */
  function pretty(k) {
    return String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function titleOf(o, i) {
    var keys = ['title', 'name', 'platform', 'label', 'id'];
    for (var k = 0; k < keys.length; k++) if (typeof o[keys[k]] === 'string' && o[keys[k]]) return o[keys[k]];
    return 'Item ' + (i + 1);
  }
  function blankLike(sample) {
    if (Array.isArray(sample)) return [];
    if (isObj(sample)) { var o = {}; Object.keys(sample).forEach(function (k) { o[k] = blankLike(sample[k]); }); return o; }
    if (typeof sample === 'number') return 0;
    if (typeof sample === 'boolean') return false;
    return '';
  }
  function changed() { refreshBar(); }
  function structural() { render(); refreshBar(); }

  /* ---------- generic renderer ---------- */
  function renderNode(host, value, assign, label, path) {
    if (Array.isArray(value)) return renderArray(host, value, label, path);
    if (isObj(value)) return renderObject(host, value, label, path);

    var id = 'f_' + path.replace(/[^a-z0-9]/gi, '_');
    var wrap = el('div', { className: 'field' });
    wrap.appendChild(el('label', { text: label, attrs: { for: id } }));
    var input;
    if (typeof value === 'boolean') {
      input = el('input', { attrs: { id: id, type: 'checkbox' } });
      input.checked = value;
      input.addEventListener('change', function () { assign(input.checked); changed(); });
      wrap.className = 'field check';
    } else if (typeof value === 'number') {
      input = el('input', { attrs: { id: id, type: 'number', step: 'any' } });
      input.value = String(value);
      input.addEventListener('input', function () { var n = parseFloat(input.value); assign(isNaN(n) ? 0 : n); changed(); });
    } else {
      var text = value == null ? '' : String(value);
      var long = text.length > 80 || text.indexOf('\n') !== -1;
      input = long
        ? el('textarea', { attrs: { id: id, rows: String(Math.min(8, Math.max(3, Math.ceil(text.length / 70)))) } })
        : el('input', { attrs: { id: id, type: 'text', autocomplete: 'off', spellcheck: 'false' } });
      input.value = text;
      input.addEventListener('input', function () { assign(input.value); changed(); });
    }
    wrap.appendChild(input);
    host.appendChild(wrap);
  }

  function renderObject(host, obj, label, path) {
    var box = el('fieldset', { className: 'group' });
    if (label) box.appendChild(el('legend', { text: label }));
    Object.keys(obj).forEach(function (k) {
      renderNode(box, obj[k], function (v) { obj[k] = v; }, pretty(k), path + '.' + k);
    });
    host.appendChild(box);
  }

  function renderArray(host, arr, label, path) {
    var objects = arr.length > 0 && arr.every(isObj);
    var box = el('div', { className: 'group list' });
    var head = el('div', { className: 'list-head' }, [
      el('strong', { text: (label || 'List') + ' (' + arr.length + ')' }),
      el('button', {
        className: 'btn small', text: '+ Add', attrs: { type: 'button' },
        on: {
          click: function () {
            if (objects || (arr.length === 0 && C.sampleFor && C.sampleFor[path])) {
              var tpl = blankLike(arr.length ? arr[0] : C.sampleFor[path]);
              if (Object.prototype.hasOwnProperty.call(tpl, 'id')) tpl.id = 'new-' + Date.now().toString(36);
              arr.push(tpl);
              C.open[path + '.' + (arr.length - 1)] = true;
            } else {
              arr.push('');
            }
            structural();
          }
        }
      })
    ]);
    box.appendChild(head);

    arr.forEach(function (item, i) {
      var p = path + '.' + i;
      if (isObj(item)) {
        var card = el('details', { className: 'acard' });
        if (C.open[p]) card.open = true;
        card.addEventListener('toggle', function () { C.open[p] = card.open; });
        card.appendChild(el('summary', { text: (i + 1) + '. ' + titleOf(item, i) }));
        var inner = el('div', { className: 'acard-body' });
        Object.keys(item).forEach(function (k) {
          renderNode(inner, item[k], function (v) { item[k] = v; }, pretty(k), p + '.' + k);
        });
        inner.appendChild(el('div', { className: 'btn-row' }, [
          mini('Move up', i === 0, function () { swap(arr, i, i - 1); }),
          mini('Move down', i === arr.length - 1, function () { swap(arr, i, i + 1); }),
          mini('Duplicate', false, function () {
            var copy = JSON.parse(JSON.stringify(item));
            if (typeof copy.id === 'string') copy.id = copy.id + '-copy';
            arr.splice(i + 1, 0, copy);
          }),
          mini('Delete', false, function () {
            if (window.confirm('Delete "' + titleOf(item, i) + '"?')) arr.splice(i, 1); else return false;
          }, true)
        ]));
        card.appendChild(inner);
        box.appendChild(card);
      } else {
        var row = el('div', { className: 'prow' });
        var input = el('input', { attrs: { type: 'text', autocomplete: 'off', 'aria-label': (label || 'Item') + ' ' + (i + 1) } });
        input.value = item == null ? '' : String(item);
        input.addEventListener('input', function () { arr[i] = input.value; changed(); });
        row.appendChild(input);
        row.appendChild(mini('Remove', false, function () { arr.splice(i, 1); }, true));
        box.appendChild(row);
      }
    });
    if (!arr.length) box.appendChild(el('p', { className: 'muted small-note', text: 'Empty. Use + Add.' }));
    host.appendChild(box);
  }

  function swap(arr, a, b) { var t = arr[a]; arr[a] = arr[b]; arr[b] = t; }
  function mini(text, disabled, run, danger) {
    var b = el('button', {
      className: 'btn small' + (danger ? ' danger' : ''), text: text, attrs: { type: 'button' },
      on: { click: function () { if (run() !== false) structural(); } }
    });
    b.disabled = !!disabled;
    return b;
  }

  /* ---------- screen ---------- */
  function render() {
    var host = $('cBody');
    if (!host) return;
    var keep = host.scrollTop;
    clear(host);
    if (C.mode === 'raw') {
      var ta = el('textarea', { className: 'raw', attrs: { id: 'cRaw', spellcheck: 'false', 'aria-label': 'Raw JSON' } });
      ta.value = JSON.stringify(C.draft, null, 2);
      ta.addEventListener('input', function () {
        try { C.draft = JSON.parse(ta.value); C.rawError = ''; $('cRawErr').hidden = true; }
        catch (e) { C.rawError = e.message; $('cRawErr').textContent = 'Invalid JSON: ' + e.message; $('cRawErr').hidden = false; }
        refreshBar();
      });
      host.appendChild(ta);
      host.appendChild(el('p', { className: 'error', attrs: { id: 'cRawErr', role: 'alert' } }));
      $('cRawErr').hidden = true;
    } else if (C.draft !== null) {
      var root = C.draft;
      if (Array.isArray(root)) renderArray(host, root, C.label, 'root');
      else renderObject(host, root, '', 'root');
    }
    host.scrollTop = keep;
    $('cFormTab').classList.toggle('active', C.mode === 'form');
    $('cRawTab').classList.toggle('active', C.mode === 'raw');
  }

  function renderFiles() {
    var ul = $('cFiles');
    clear(ul);
    C.files.forEach(function (f) {
      ul.appendChild(el('li', {
        className: 'item' + (f.path === C.path ? ' selected' : ''), attrs: { tabindex: '0', role: 'button' },
        on: {
          click: function () { openFile(f.path); },
          keydown: function (e) { if (e.key === 'Enter') openFile(f.path); }
        }
      }, [
        el('div', { className: 'who', text: f.label }),
        el('div', { className: 'snippet', text: f.path.replace('frontend/data/', '') })
      ]));
    });
  }

  function leaveOk() {
    return !isDirty() || window.confirm('You have unsaved changes. Discard them?');
  }

  function openFile(path) {
    if (path !== C.path && !leaveOk()) return;
    C.busy = true; refreshBar();
    api('/api/admin-content?action=get&path=' + encodeURIComponent(path)).then(function (r) {
      C.busy = false;
      if (!r.body.ok) { say(r.body.error || 'Could not open file', true); refreshBar(); return; }
      C.path = r.body.path; C.label = r.body.label; C.warn = r.body.warn || '';
      C.sha = r.body.sha; C.draft = r.body.data; C.original = JSON.stringify(C.draft);
      C.open = {}; C.mode = 'form'; C.rawError = '';
      C.sampleFor = {};
      $('cTitle').textContent = C.label;
      $('cPath').textContent = C.path;
      $('cWarn').textContent = C.warn; $('cWarn').hidden = !C.warn;
      $('cEditor').hidden = false; $('cHistory').hidden = true;
      $('cEmptyHint').hidden = true;
      $('contentEditor').classList.add('open');
      renderFiles(); render(); refreshBar();
    }).catch(function () { C.busy = false; say('Network error', true); refreshBar(); });
  }

  function save() {
    if (!isDirty() || C.rawError) return;
    if (!window.confirm('Publish these changes to the live site now?\nThe site redeploys in about a minute.')) return;
    C.busy = true; refreshBar();
    api('/api/admin-content', 'POST', { action: 'save', path: C.path, sha: C.sha, data: C.draft }).then(function (r) {
      C.busy = false;
      if (r.body.ok) {
        C.sha = r.body.sha || C.sha; C.original = snapshot();
        say(r.body.unchanged ? 'No changes to save' : 'Saved. Live in about a minute.');
      } else {
        say(r.body.error || 'Save failed', true);
      }
      refreshBar();
    }).catch(function () { C.busy = false; say('Network error', true); refreshBar(); });
  }

  function revert() {
    if (!isDirty()) return;
    if (!window.confirm('Discard all unsaved changes?')) return;
    C.draft = JSON.parse(C.original); C.rawError = '';
    render(); refreshBar();
  }

  function fmt(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString();
  }

  function showHistory() {
    var box = $('cHistory');
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    clear(box);
    box.appendChild(el('p', { className: 'muted', text: 'Loading versions…' }));
    api('/api/admin-content?action=history&path=' + encodeURIComponent(C.path)).then(function (r) {
      clear(box);
      if (!r.body.ok) { box.appendChild(el('p', { className: 'error', text: r.body.error || 'Could not load history' })); return; }
      box.appendChild(el('h3', { className: 'section-title', text: 'Recent versions' }));
      r.body.commits.forEach(function (c, i) {
        var row = el('div', { className: 'hrow' }, [
          el('div', {}, [
            el('div', { text: c.message || '(no message)' }),
            el('div', { className: 'muted small-note', text: fmt(c.date) + ' · ' + c.short + (i === 0 ? ' · current' : '') })
          ])
        ]);
        if (i > 0) {
          row.appendChild(el('button', {
            className: 'btn small', text: 'Restore', attrs: { type: 'button' },
            on: { click: function () { restore(c); } }
          }));
        }
        box.appendChild(row);
      });
    }).catch(function () { clear(box); box.appendChild(el('p', { className: 'error', text: 'Network error' })); });
  }

  function restore(c) {
    if (isDirty() && !window.confirm('Unsaved edits will be lost. Continue?')) return;
    if (!window.confirm('Restore version ' + c.short + ' and publish it now?')) return;
    api('/api/admin-content', 'POST', { action: 'restore', path: C.path, sha: C.sha, ref: c.sha }).then(function (r) {
      if (!r.body.ok) { say(r.body.error || 'Restore failed', true); return; }
      say('Restored. Live in about a minute.');
      C.original = ''; C.draft = null;
      openFile(C.path);
    }).catch(function () { say('Network error', true); });
  }

  /* ---------- init / public hooks ---------- */
  function init() {
    if (C.inited) return;
    C.inited = true;
    $('cFormTab').addEventListener('click', function () {
      if (C.mode === 'form') return;
      if (C.rawError) { say('Fix the JSON first', true); return; }
      C.mode = 'form'; render();
    });
    $('cRawTab').addEventListener('click', function () { if (C.draft === null) return; C.mode = 'raw'; render(); });
    $('cSave').addEventListener('click', save);
    $('cRevert').addEventListener('click', revert);
    $('cHistBtn').addEventListener('click', showHistory);
    $('cBack').addEventListener('click', function () { $('contentEditor').classList.remove('open'); });
    window.addEventListener('beforeunload', function (e) { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

    api('/api/admin-content?action=list').then(function (r) {
      if (!r.body.ok) { say(r.body.error || 'Could not load content files', true); return; }
      C.configured = r.body.configured;
      C.files = r.body.files || [];
      $('cSetup').hidden = C.configured;
      $('cLayout').hidden = !C.configured;
      renderFiles();
    }).catch(function () { say('Network error', true); });
  }

  window.ARContent = {
    show: init,
    isDirty: isDirty,
    leaveOk: leaveOk
  };
})();

/* Chief of Myself — app. Nessuna dipendenza: i dati arrivano dal Worker, i calcoli stanno in logic.js. */
(function () {
  'use strict';
  const L = window.CMLogic;
  const CFG = window.CM_CONFIG || {};
  const API = String(CFG.API_URL || '').replace(/\/+$/, '');
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  /* ---------- Stato ---------- */
  const S = {
    notion: null,            // bundle dal Worker
    notionState: 'loading',  // loading | ok | error
    notionErr: '',
    fetchedAt: null,
    stale: false,
    day: null,
    cal: {},                 // { 'YYYY-MM-DD': {status, rows, warnings} }
    google: { state: 'idle', mail: null, drive: null }, // idle | loading | ok | off | error
    showAll: false,
    derived: null,
  };

  /* ---------- Helpers di disegno ---------- */
  const BRAND = { blue: '#003D5B', jade: '#007380', sea: '#25E2CC', rasp: '#CC3262', tang: '#FF8400', sun: '#FBCA18' };
  const HORIZON_COLORS = [BRAND.sea, BRAND.tang, BRAND.sun, '#E86A92', '#7FB3C8'];
  const STATUS_COLORS = { 'In Progress': BRAND.sea, Planning: BRAND.sun, Live: '#1FA3A8', Paused: '#7A93A3', Backlog: '#4F6B7C' };
  const PRIO_COLORS = { High: BRAND.rasp, Medium: BRAND.tang, Low: BRAND.jade, None: '#8AA0AD' };
  const SRC_COLORS = { Lavoro: BRAND.sea, Personale: BRAND.tang };
  const shade = (hex, k) => { const h = hex.replace('#', ''); const c = [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16)).map((v) => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k))))); return 'rgb(' + c.join(',') + ')'; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
  const safeUrl = (u) => (/^https:\/\//.test(String(u || '')) ? u : '#');
  const link = (text, url) => { const a = el('a', '', text); a.href = safeUrl(url); a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
  const pill = (text, cls) => el('span', 'cm-pill ' + cls, text);
  const cls = (s) => String(s || '').replace(/\s+/g, '-');
  const failedLine = (target, retry) => {
    const d = el('div', 'cm-failed', 'Dati non caricati');
    if (retry) { const b = el('button', '', 'Riprova'); b.type = 'button'; b.addEventListener('click', retry); d.append(b); }
    target.replaceChildren(d);
  };
  const shortName = L.shortName, horizonOrder = L.horizonOrder, sum = L.sum, fmtDate = L.fmtDateIt;
  const horizonColor = (h, all) => HORIZON_COLORS[Math.max(0, all.indexOf(h)) % HORIZON_COLORS.length];
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDay(d); };
  const todayIso = () => L.todayRome();

  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  /* ---------- API ---------- */
  const getPass = () => store.get('cm_pass') || '';
  class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
  async function api(path, opts) {
    opts = opts || {};
    let res;
    try {
      res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'X-Passphrase': getPass() }, opts.body ? { 'Content-Type': 'application/json' } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) { throw new ApiError('Nessuna connessione al Worker', 0, 'network'); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* non JSON */ }
    if (!res.ok) throw new ApiError((data && data.error) || ('Errore ' + res.status), res.status, data && data.code);
    return data;
  }

  /* ---------- Blocco con passphrase ---------- */
  function showLock(msg) {
    $('lock').hidden = false;
    const m = $('lock-msg');
    if (msg) { m.textContent = msg; m.hidden = false; } else m.hidden = true;
    setTimeout(() => $('lock-input').focus(), 30);
  }
  $('lock-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = $('lock-input').value;
    if (!v) return;
    $('lock-btn').disabled = true;
    store.set('cm_pass', v);
    try {
      await api('/api/ping');
      $('lock').hidden = true; $('lock-input').value = '';
      start();
    } catch (e) {
      store.del('cm_pass');
      showLock(e.status === 401 ? 'Passphrase non corretta.' : e.message);
    } finally { $('lock-btn').disabled = false; }
  });

  /* ---------- Caricamento dati ---------- */
  function hydrateFromCache() {
    try {
      const raw = store.get('cm_notion');
      if (!raw) return false;
      const c = JSON.parse(raw);
      if (!c || !c.projects) return false;
      S.notion = c; S.notionState = 'ok'; S.fetchedAt = c.fetched_at; S.stale = true;
      derive();
      return true;
    } catch (e) { return false; }
  }

  async function loadNotion(force) {
    if (!S.notion) S.notionState = 'loading';
    try {
      const b = await api('/api/notion' + (force ? '?refresh=1' : ''));
      S.notion = b; S.notionState = 'ok'; S.notionErr = ''; S.fetchedAt = b.fetched_at; S.stale = false;
      const ok = ['projects', 'tasks', 'worklog', 'decisions', 'meeting_rules'].every((k) => Array.isArray(b[k]));
      if (ok) store.set('cm_notion', JSON.stringify(b));
      derive();
    } catch (e) {
      if (e.status === 401) { store.del('cm_pass'); showLock('Passphrase non più valida.'); return; }
      S.notionErr = e.message;
      if (!S.notion) S.notionState = 'error'; else S.stale = true;
    }
  }

  async function loadCalendar(day, force) {
    const cur = S.cal[day];
    if (cur && cur.status === 'ok' && !force) return;
    if (!cur) S.cal[day] = { status: 'loading', rows: [] };
    redrawAgenda();
    try {
      const d = await api('/api/calendar?start=' + day + 'T00:00:00&end=' + addDays(day, 1) + 'T00:00:00');
      S.cal[day] = { status: 'ok', rows: d.events || [], warnings: d.warnings || [], at: Date.now() };
    } catch (e) {
      if (e.code === 'apps_script_not_configured') S.cal[day] = { status: 'off', rows: [] };
      else S.cal[day] = { status: 'error', rows: [], error: e.message };
    }
    if (day === S.day) redrawAgenda();
  }

  async function loadExtras() {
    S.google.state = 'loading';
    try {
      const [mail, drive] = await Promise.all([api('/api/mail'), api('/api/drive').catch(() => ({ items: [] }))]);
      S.google = { state: 'ok', mail, drive };
    } catch (e) {
      S.google = { state: e.code === 'apps_script_not_configured' ? 'off' : 'error', mail: null, drive: null, error: e.message };
    }
    drawGoogle();
  }

  async function refreshAll(force) {
    const btn = $('refresh'); btn.disabled = true; btn.textContent = 'Aggiorno…';
    document.body.classList.add('is-refreshing-all');
    await Promise.all([loadNotion(force), loadCalendar(S.day, true), loadExtras(), loadNotes()]);
    btn.disabled = false; btn.textContent = 'Aggiorna';
    document.body.classList.remove('is-refreshing-all');
    redrawAll();
  }

  /* ---------- Calcoli ---------- */
  function derive() {
    const n = S.notion; if (!n) { S.derived = null; return; }
    const arr = (k) => (Array.isArray(n[k]) ? n[k] : null);
    const today = todayIso();
    const d = { errors: {} };
    ['projects', 'tasks', 'worklog', 'decisions', 'meeting_rules'].forEach((k) => { if (!arr(k)) d.errors[k] = (n[k] && n[k].error) || 'non disponibile'; });
    if (arr('projects') && arr('tasks')) {
      d.portfolio = L.computePortfolio(n.projects, n.tasks, today);
      d.nextActions = L.computeNextActions(n.tasks, d.portfolio, today);
      d.byHorizon = L.computeByHorizon(d.nextActions);
      d.headline = L.computeHeadline(d.nextActions, d.portfolio, arr('worklog') || [], today);
    }
    S.derived = d;
  }

  /* ---------- Disegno ---------- */
  const bad = (key) => !!(S.derived && S.derived.errors[key]);
  const dep = (...keys) => keys.some(bad);
  const loading = () => S.notionState === 'loading' || (!S.derived && S.notionState !== 'error');
  const retry = () => refreshAll(true);

  function drawSync() {
    const s = $('sync-line');
    if (S.notionState === 'error') { s.textContent = 'Non riesco a raggiungere i dati: ' + S.notionErr; s.className = 'cm-sync is-stale'; return; }
    if (!S.fetchedAt) { s.innerHTML = '&nbsp;'; return; }
    const t = new Date(S.fetchedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: L.TZ });
    s.textContent = 'Aggiornato alle ' + t + (S.stale ? ' · dati salvati, riconnessione in corso' + (S.notionErr ? ' (' + S.notionErr + ')' : '') : '');
    s.className = 'cm-sync' + (S.stale ? ' is-stale' : '');
  }

  function drawHeadline() {
    const d = S.derived, h = d && d.headline;
    document.querySelectorAll('#headline .cm-tile-value').forEach((n) => n.classList.toggle('dash-skeleton', loading()));
    if (!h) { document.querySelectorAll('#headline [data-field]').forEach((n) => { n.textContent = '—'; }); return; }
    document.querySelectorAll('#headline [data-field]').forEach((n) => { n.textContent = String(h[n.dataset.field] ?? 0); });
    $('tile-overdue').classList.toggle('is-alert', h.overdue_tasks > 0);
    $('tile-stale').classList.toggle('is-alert', h.stale_projects > 0);
  }

  function drawMap() {
    const box = $('hierarchy'), d = S.derived;
    const legend = $('map-legend');
    legend.replaceChildren(
      ...[['In Progress', 'In corso'], ['Planning', 'Pianificazione'], ['Live', 'Live'], ['Paused', 'In hold']].map(([k, label]) => { const s = el('span', 'round', label); s.style.setProperty('--sw', STATUS_COLORS[k]); return s; }),
      el('span', 'ring', 'Da guardare'));
    box.classList.toggle('dash-skeleton', loading());
    if (S.notionState === 'error' && !d) { failedLine(box, retry); return; }
    if (!d) { box.replaceChildren(); return; }
    if (!d.portfolio) { failedLine(box, retry); return; }
    const horizons = horizonOrder(d.portfolio.map((p) => p.horizon));
    const statusOrder = { 'In Progress': 1, Planning: 2, Live: 3, Paused: 4, Backlog: 5 };
    box.replaceChildren(...horizons.map((h, i) => {
      const items = d.portfolio.filter((p) => p.horizon === h);
      const col = el('div', 'hz-col'); col.style.setProperty('--acc', horizonColor(h, horizons)); col.style.setProperty('--i', i);
      const m = String(h).match(/^(H\d)\s*[—-]\s*(.*)$/);
      const head = el('div', 'hz-head');
      const top = el('div', 'hz-head-top');
      top.append(el('span', 'hz-tag', m ? m[1] : (h === 'Personale' ? 'P' : '·')), el('span', 'hz-name', m ? m[2] : h));
      const open = sum(items, (p) => p.open_tasks);
      const active = items.filter(L.isActive).length;
      head.append(top, el('span', 'hz-meta', items.length + ' progetti · ' + active + ' attivi · ' + open + ' task aperte'));
      const bar = el('div', 'hz-bar');
      Object.keys(statusOrder).forEach((k) => { const n = items.filter((p) => p.status === k).length; if (n) { const seg = el('i'); seg.style.width = (n / items.length * 100) + '%'; seg.style.background = STATUS_COLORS[k]; seg.title = k + ': ' + n; bar.append(seg); } });
      head.append(bar);
      const branches = el('div', 'hz-branches');
      const groups = new Map();
      items.forEach((p) => { const g = p.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); });
      [...groups.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || a[0].localeCompare(b[0])).forEach(([g, list]) => {
        const box2 = el('div', 'hz-group');
        const gh = el('div', 'hz-group-head');
        const type = g ? (list[0].group_type || 'Program') : 'Direct';
        gh.append(el('span', 'hz-type t-' + type, type === 'Program' ? 'Programma' : type === 'Phase' ? 'Fase' : 'Diretti'));
        gh.append(el('span', '', g ? g.replace(/\s*\(.*\)\s*$/, '') : "Progetti dell'orizzonte"));
        const chips = el('div', 'hz-chips');
        list.sort((a, b) => (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9) || b.open_tasks - a.open_tasks || a.name.localeCompare(b.name)).forEach((p) => {
          const a = link('', p.project_url); a.textContent = '';
          const alert = L.attentionItems([p]).length > 0;
          a.className = 'hz-chip' + (alert ? ' is-alert' : '') + (p.status === 'Paused' || p.status === 'Backlog' ? ' is-dim' : '');
          a.style.setProperty('--sc', STATUS_COLORS[p.status] || '#8AA0AD');
          a.title = [p.name, p.status + (p.stage ? ' · ' + p.stage : ''), p.health, p.next_step ? 'Next: ' + p.next_step : ''].filter(Boolean).join('\n');
          a.append(el('span', 'sd'), el('span', 'nm', shortName(p.name)), el('span', 'ct' + (p.high_tasks ? ' hi' : ''), String(p.open_tasks)));
          chips.append(a);
        });
        box2.append(gh, chips);
        branches.append(box2);
      });
      col.append(head, branches);
      return col;
    }));
  }

  /* Agenda */
  function redrawAgenda() { drawAgenda(); }
  function drawAgenda() {
    const box = $('day-timeline'), strip = $('day-allday'), day = S.day;
    const t0 = todayIso();
    const dObj = new Date(day + 'T12:00:00');
    $('day-label').textContent = (day === t0 ? 'Oggi, ' : '') + dObj.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    $('day-legend').replaceChildren(...['Lavoro', 'Personale'].map((k) => { const s = el('span', '', k); s.style.setProperty('--sw', SRC_COLORS[k]); return s; }), (() => { const s = el('span', 'tk', 'Task'); s.style.setProperty('--sw', BRAND.sun); return s; })(), el('span', 'star', 'Alta'), (() => { const s = el('span', 'low', 'Bassa'); s.style.setProperty('--sw', BRAND.sea); return s; })());
    drawDayTasks();
    /* Task con scadenza in questo giorno: senza orario in alto, con orario nella griglia. */
    const dayTasks = (S.derived && S.derived.nextActions ? S.derived.nextActions : []).filter((t) => t.due === day);
    const taskChips = dayTasks.filter((t) => !t.due_at).map((t) => {
      const a = link('', t.task_url); a.className = 'dy-chip dy-task' + (t.priority === 'High' ? ' hi' : '');
      a.textContent = t.task; a.title = 'Task · ' + (t.priority || 'senza priorità') + (t.project ? ' · ' + shortName(t.project) : '') + ' · apri in Notion';
      return a;
    });
    const c = S.cal[day] || { status: 'loading', rows: [] };
    box.classList.toggle('dash-skeleton', c.status === 'loading');
    if (c.status === 'off') { strip.replaceChildren(...taskChips); box.replaceChildren(el('p', 'dy-note', 'Google non è ancora collegato: segui la guida (Apps Script) per vedere qui il calendario.')); return; }
    if (c.status === 'error') { strip.replaceChildren(...taskChips); failedLine(box, () => loadCalendar(day, true)); box.append(el('p', 'dy-note', c.error || '')); return; }
    if (c.status !== 'ok') { strip.replaceChildren(...taskChips); box.replaceChildren(); return; }
    const rules = S.notion && Array.isArray(S.notion.meeting_rules) ? S.notion.meeting_rules : [];
    const events = L.computeDayEvents(c.rows, rules);
    const dayStart = new Date(day + 'T00:00:00'), dayEnd = new Date(addDays(day, 1) + 'T00:00:00');
    const shown = events.filter((e) => e.importance !== 'Nascondi');
    const hidden = events.length - shown.length;
    strip.replaceChildren(...shown.filter((e) => e.all_day).map((e) => { const ch = el('button', 'dy-chip imp-' + e.importance, e.title); ch.type = 'button'; ch.style.setProperty('--sc', SRC_COLORS[e.source] || BRAND.sea); ch.title = e.title + (e.rule ? ' · regola: ' + e.rule : '') + ' · ' + e.source; ch.addEventListener('click', () => openEventCard(e)); return ch; }), ...taskChips);
    const timedTasks = dayTasks.filter((t) => t.due_at).map((t) => {
      const s = new Date(t.due_at);
      return { isTask: true, task: t, title: t.task, start: t.due_at, end: new Date(s.getTime() + 30 * 60000).toISOString(), importance: t.priority === 'High' ? 'Alta' : 'Normale', source: 'Task' };
    });
    const timed = shown.concat(timedTasks).filter((e) => !e.all_day && e.start).map((e) => {
      const s = new Date(e.start), en = e.end ? new Date(e.end) : new Date(new Date(e.start).getTime() + 30 * 60000);
      const s2 = s < dayStart ? dayStart : s, e2 = en > dayEnd ? dayEnd : en;
      return Object.assign({}, e, { s: s2, e: e2, sm: (s2 - dayStart) / 60000, em: Math.max((e2 - dayStart) / 60000, (s2 - dayStart) / 60000 + 20) });
    }).filter((e) => e.e > dayStart && e.s < dayEnd).sort((a, b) => a.sm - b.sm || b.em - a.em);
    let minH = 8, maxH = 19;
    timed.forEach((e) => { minH = Math.min(minH, Math.floor(e.sm / 60)); maxH = Math.max(maxH, Math.ceil(e.em / 60)); });
    maxH = Math.min(24, maxH);
    const hourPx = 46;
    const grid = el('div', 'dy-grid'); grid.style.height = ((maxH - minH) * hourPx) + 'px';
    for (let h = minH; h <= maxH; h++) {
      const y = (h - minH) * hourPx;
      const ln = el('div', 'dy-line'); ln.style.top = y + 'px'; grid.append(ln);
      const hl = el('span', 'dy-hour', pad(h) + ':00'); hl.style.top = y + 'px'; grid.append(hl);
    }
    const clusters = []; let cur = null;
    timed.forEach((e) => { if (!cur || e.sm >= cur.end) { cur = { items: [], end: e.em }; clusters.push(cur); } cur.items.push(e); cur.end = Math.max(cur.end, e.em); });
    clusters.forEach((cl) => {
      const lanes = [];
      cl.items.forEach((e) => { let i = lanes.findIndex((end) => end <= e.sm); if (i < 0) { i = lanes.length; lanes.push(0); } lanes[i] = e.em; e.lane = i; });
      cl.items.forEach((e) => { e.lanes = lanes.length; });
    });
    const fmt = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
    timed.forEach((e) => {
      let b;
      if (e.isTask) {
        b = link('', e.task.task_url); b.className = 'dy-ev dy-tk' + (e.task.priority === 'High' ? ' hi' : '');
      } else {
        b = el('button', 'dy-ev imp-' + e.importance); b.type = 'button';
        b.addEventListener('click', () => openEventCard(e));
      }
      b.style.setProperty('--sc', e.isTask ? BRAND.sun : (SRC_COLORS[e.source] || BRAND.sea));
      b.style.top = ((e.sm / 60 - minH) * hourPx + 1) + 'px';
      b.style.height = Math.max(22, (e.em - e.sm) / 60 * hourPx - 2) + 'px';
      const w = 100 / e.lanes;
      b.style.left = 'calc(' + (e.lane * w) + '% + 6px)'; b.style.width = 'calc(' + w + '% - 8px)';
      b.title = e.isTask ? 'Task alle ' + fmt(e.s) + ' · ' + (e.task.priority || 'senza priorità') + ' · apri in Notion' : e.title + ' · ' + fmt(e.s) + '–' + fmt(e.e) + ' · ' + e.source + ' · importanza ' + e.importance + (e.rule ? ' (regola: ' + e.rule + ')' : '') + ' · clic per la task collegata';
      b.append(el('b', '', e.title), el('span', '', e.isTask ? fmt(e.s) + ' · task' : fmt(e.s) + '–' + fmt(e.e)));
      grid.append(b);
    });
    if (day === t0) {
      const now = new Date(); const m = now.getHours() * 60 + now.getMinutes();
      if (m >= minH * 60 && m <= maxH * 60) { const nl = el('div', 'dy-now'); nl.style.top = ((m / 60 - minH) * hourPx) + 'px'; grid.append(nl); }
    }
    const notes = [];
    if (!timed.length) notes.push(el('p', 'dy-note', 'Nessuna riunione con orario in questo giorno.'));
    else if (shown.some((e) => !e.all_day)) notes.push(el('p', 'dy-note', 'Clicca un meeting per aprire la sua task in Notion.'));
    if (hidden) notes.push(el('p', 'dy-note', hidden + (hidden === 1 ? ' evento nascosto' : ' eventi nascosti') + ' dalle regole.'));
    (c.warnings || []).forEach((w) => notes.push(el('p', 'dy-note', w)));
    box.replaceChildren(...notes, grid);
  }

  function drawDayTasks() {
    const ul = $('day-tasks'), d = S.derived, day = S.day, t0 = todayIso();
    if (!d || !d.nextActions) { if (S.notionState === 'error') failedLine(ul, retry); else ul.replaceChildren(); return; }
    const list = d.nextActions.filter((t) => t.due === day || (day === t0 && t.overdue));
    if (!list.length) { ul.replaceChildren(el('li', 'cm-empty cm-empty-li', 'Nessuna task in scadenza in questo giorno.')); return; }
    ul.replaceChildren(...list.map((t) => {
      const li = el('li'); if (t.priority === 'High') li.style.setProperty('--acc', BRAND.rasp);
      li.append(link(t.task, t.task_url), el('span', 'cm-sub' + (t.overdue ? ' cm-late' : ''), [t.priority, t.project ? shortName(t.project) : '', t.overdue ? 'scaduta il ' + fmtDate(t.due) : (t.recurrence ? 'ricorrente' : '')].filter(Boolean).join(' · ')));
      return li;
    }));
  }

  function drawTasks() {
    const d = S.derived, tbody = document.querySelector('#tasks-table tbody'), more = $('tasks-more');
    const fH = $('f-horizon'), fP = $('f-priority');
    if (!d || !d.nextActions) {
      tbody.replaceChildren(); more.textContent = '';
      if (S.notionState === 'error' || (d && d.errors && (d.errors.tasks || d.errors.projects))) { const tr = el('tr'), td = el('td'); td.colSpan = 5; failedLine(td, retry); tr.append(td); tbody.append(tr); }
      return;
    }
    const horizons = horizonOrder(d.nextActions.map((t) => t.horizon).filter(Boolean));
    const cur = fH.value;
    fH.replaceChildren(new Option('Tutti gli orizzonti', ''), ...horizons.map((h) => new Option(shortName(h), h)));
    fH.value = horizons.includes(cur) ? cur : '';
    const pr = fP.value;
    let rows = d.nextActions.filter((t) => (!fH.value || t.horizon === fH.value) && (!pr || (pr === 'High' ? t.priority === 'High' : t.priority === 'High' || t.priority === 'Medium')));
    const total = rows.length;
    if (!S.showAll) rows = rows.slice(0, 12);
    tbody.replaceChildren(...rows.map((t) => {
      const tr = el('tr');
      const tdTask = el('td'); tdTask.append(link(t.task, t.task_url));
      const tdPrio = el('td'); if (t.priority) tdPrio.append(pill(t.priority, 'p-' + t.priority));
      const tdDue = el('td', 'cm-num' + (t.overdue ? ' cm-late' : ''), t.due ? fmtDate(t.due) : '');
      if (t.recurrence) tdDue.title = 'Ricorrente: ' + t.recurrence;
      tr.append(tdTask, el('td', 'cm-muted', t.project || ''), tdPrio, tdDue, el('td', 'cm-muted cm-hide-sm', t.status));
      return tr;
    }));
    more.textContent = total === 0 ? 'Nessuna task aperta con questi filtri.' : (!S.showAll && total > rows.length ? 'Mostrate ' + rows.length + ' di ' + total + '.' : '');
  }

  function drawPortfolio() {
    const body = $('portfolio-body'), d = S.derived;
    body.classList.toggle('dash-skeleton', loading());
    if (S.notionState === 'error' && !d) { failedLine(body, retry); return; }
    if (!d) { body.replaceChildren(); return; }
    if (!d.portfolio) { failedLine(body, retry); return; }
    const order = { 'In Progress': 1, Planning: 2, Live: 3, Paused: 4, Backlog: 5 };
    const horizons = horizonOrder(d.portfolio.map((p) => p.horizon));
    body.replaceChildren(...horizons.map((horizon, gi) => {
      const items = d.portfolio.filter((p) => p.horizon === horizon);
      const wrap = el('div', 'cm-horizon'); wrap.id = 'horizon-' + gi; wrap.style.setProperty('--acc', horizonColor(horizon, horizons));
      wrap.append(el('h3', 'cm-h3', horizon));
      const scroll = el('div', 'cm-scroll'), table = el('table', 'cm-table'), head = el('tr');
      [['Progetto'], ['Programma / fase', '', 1], ['Stato'], ['Health', '', 1], ['Next step', '', 1], ['Task aperte', 'cm-num'], ['Giorni da review', 'cm-num']].forEach(([label, c, hide]) => { const th = el('th', c || '', label); if (hide) th.classList.add('cm-hide-sm'); head.append(th); });
      const thead = el('thead'); thead.append(head);
      const tbody = el('tbody');
      items.sort((a, b) => (order[a.status] || 9) - (order[b.status] || 9) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name)).forEach((p) => {
        const tr = el('tr');
        const tdName = el('td'); tdName.append(link(p.name, p.project_url));
        const tdStatus = el('td'); tdStatus.append(pill(p.status, 's-' + cls(p.status))); if (p.stage) tdStatus.title = 'Stadio: ' + p.stage;
        const tdHealth = el('td', 'cm-hide-sm'); if (p.health) tdHealth.append(pill(p.health, 'h-' + cls(p.health)));
        const tdTasks = el('td', 'cm-num' + (p.overdue_tasks ? ' cm-late' : ''), String(p.open_tasks)); if (p.high_tasks) tdTasks.title = p.high_tasks + ' High';
        const stale = L.isActive(p) && (p.days_since_review === null || p.days_since_review > 14);
        tr.append(tdName, el('td', 'cm-group cm-hide-sm', p.group || ''), tdStatus, tdHealth, el('td', 'cm-next cm-hide-sm', p.next_step || ''), tdTasks, el('td', 'cm-num' + (stale ? ' cm-stale' : ' cm-muted'), p.days_since_review === null ? '' : String(p.days_since_review)));
        tbody.append(tr);
      });
      table.append(thead, tbody); scroll.append(table); wrap.append(scroll);
      return wrap;
    }));
  }

  function drawAttention() {
    const ul = $('attention-list'), d = S.derived;
    if (!d || !d.portfolio) { if (S.notionState === 'error' || (d && d.errors.projects)) failedLine(ul, retry); else ul.replaceChildren(); return; }
    const items = L.attentionItems(d.portfolio);
    if (!items.length) { ul.replaceChildren(el('li', 'cm-empty cm-empty-li', 'Niente da segnalare: tutti i progetti attivi sono in ordine.')); return; }
    ul.replaceChildren(...items.map((p) => {
      const li = el('li'); if (p.health === 'At risk') li.style.setProperty('--acc', BRAND.tang);
      li.append(link(p.name, p.project_url), el('span', 'cm-sub', L.attentionReasons(p).join(' · ') + (p.next_step ? ' — ' + p.next_step : '')));
      return li;
    }));
  }

  function drawLoad() {
    const box = $('load-chart'), d = S.derived;
    const keys = [['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low'], ['None', 'Senza priorità']];
    $('load-legend').replaceChildren(...keys.map(([k, label]) => { const s = el('span', '', label); s.style.setProperty('--sw', PRIO_COLORS[k]); return s; }));
    box.classList.toggle('dash-skeleton', loading());
    if (!d || !d.byHorizon) { if (S.notionState === 'error' || (d && d.errors && d.errors.tasks)) failedLine(box, retry); else box.replaceChildren(); return; }
    if (!d.byHorizon.length) { box.replaceChildren(el('p', 'cm-empty', 'Nessuna task aperta.')); return; }
    const order = horizonOrder(d.byHorizon.map((x) => x.horizon));
    const max = Math.max(1, ...d.byHorizon.map((x) => x.total));
    const wrap = el('div', 'ld');
    order.forEach((h) => {
      const r = d.byHorizon.find((x) => x.horizon === h);
      const row = el('div', 'ld-row');
      const m = String(h).match(/^(H\d)\s*[—-]\s*(.*)$/);
      const lab = el('span', 'ld-label', m ? m[1] + ' ' + m[2].replace(/:.*$/, '') : h); lab.title = h;
      const track = el('div', 'ld-track'); track.style.width = (r.total / max * 100) + '%';
      keys.forEach(([k, name]) => { if (!r[k]) return; const seg = el('i'); seg.style.flex = String(r[k]); seg.style.background = PRIO_COLORS[k]; seg.title = name + ': ' + r[k]; track.append(seg); });
      const holder = el('div'); holder.append(track);
      row.append(lab, holder, el('span', 'ld-total', String(r.total)));
      wrap.append(row);
    });
    box.replaceChildren(wrap);
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k])); return e; };
  function drawStatus() {
    const box = $('status-chart'), d = S.derived;
    box.classList.toggle('dash-skeleton', loading());
    if (!d || !d.portfolio) { if (S.notionState === 'error' || (d && d.errors && (d.errors.projects || d.errors.tasks))) failedLine(box, retry); else box.replaceChildren(); return; }
    const labels = { 'In Progress': 'In corso', Planning: 'Pianificazione', Live: 'Live', Paused: 'In hold', Backlog: 'Backlog' };
    const counts = Object.keys(labels).map((k) => ({ k, label: labels[k], n: d.portfolio.filter((p) => p.status === k).length })).filter((x) => x.n);
    const total = sum(counts, (x) => x.n);
    if (!total) { box.replaceChildren(el('p', 'cm-empty', 'Nessun progetto.')); return; }
    const size = 150, c = size / 2, rr = 52, sw = 22, circ = 2 * Math.PI * rr;
    const svg = svgEl('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, role: 'img', 'aria-label': 'Progetti per stato' });
    const defs = svgEl('defs'); svg.append(defs);
    let offset = 0; const gap = counts.length > 1 ? 3 : 0;
    counts.forEach((x, i) => {
      const gr = svgEl('linearGradient', { id: 'gr-' + i, x1: 0, y1: 0, x2: 1, y2: 1 });
      gr.append(svgEl('stop', { offset: 0, 'stop-color': shade(STATUS_COLORS[x.k], 0.25) }), svgEl('stop', { offset: 1, 'stop-color': shade(STATUS_COLORS[x.k], -0.2) }));
      defs.append(gr);
      const len = x.n / total * circ;
      const arc = svgEl('circle', { cx: c, cy: c, r: rr, fill: 'none', stroke: 'url(#gr-' + i + ')', 'stroke-width': sw, 'stroke-dasharray': Math.max(0, len - gap) + ' ' + (circ - Math.max(0, len - gap)), 'stroke-dashoffset': -offset, transform: 'rotate(-90 ' + c + ' ' + c + ')' });
      svg.append(arc); offset += len;
    });
    const t1 = svgEl('text', { x: c, y: c + 3, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 700, fill: 'var(--color-fg)' }); t1.textContent = total;
    const t2 = svgEl('text', { x: c, y: c + 22, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--color-fg-muted)' }); t2.textContent = 'progetti';
    svg.append(t1, t2);
    const legend = el('div', 'cm-legend');
    counts.forEach((x) => { const s = el('span', '', x.label); s.style.setProperty('--sw', STATUS_COLORS[x.k]); s.append(el('b', '', String(x.n))); legend.append(s); });
    box.replaceChildren(svg, legend);
  }

  function drawLog() {
    const days = $('log-days'), ul = $('log-list'), n = S.notion;
    if (!n || !Array.isArray(n.worklog)) { days.replaceChildren(); if (S.notionState === 'error' || (n && n.worklog)) failedLine(ul, retry); else ul.replaceChildren(); return; }
    const wl = n.worklog, t0 = todayIso();
    const have = new Set(wl.filter((w) => w.day).map((w) => L.daysBetween(w.day, t0)));
    const names = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    days.replaceChildren(...[6, 5, 4, 3, 2, 1, 0].map((ago) => {
      const d = new Date(addDays(t0, -ago) + 'T12:00:00');
      const b = el('div', 'cm-day' + (have.has(ago) ? ' on' : ''));
      b.title = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }) + (have.has(ago) ? ': voce registrata' : ': nessuna voce');
      b.append(el('i'), el('span', '', names[d.getDay()]));
      return b;
    }));
    if (!wl.length) { ul.replaceChildren(el('li', 'cm-empty cm-empty-li', 'Ancora nessuna voce. Raccontami in Claude cosa hai fatto e deciso.')); return; }
    ul.replaceChildren(...wl.slice(0, 5).map((w) => {
      const li = el('li');
      li.append(link(w.entry, w.entry_url), el('span', 'cm-sub', [fmtDate(w.day), w.impact_level ? 'impatto ' + w.impact_level : '', (w.horizon || []).join(', ')].filter(Boolean).join(' · ')));
      return li;
    }));
  }

  function drawDecisions() {
    const ul = $('decision-list'), n = S.notion;
    if (!n || !Array.isArray(n.decisions)) { if (S.notionState === 'error' || (n && n.decisions)) failedLine(ul, retry); else ul.replaceChildren(); return; }
    const open = L.openDecisions(n.decisions, todayIso());
    if (!open.length) { ul.replaceChildren(el('li', 'cm-empty cm-empty-li', 'Nessuna decisione aperta.')); return; }
    ul.replaceChildren(...open.slice(0, 6).map((x) => {
      const li = el('li'), k = x.days_to_review;
      const when = k === null ? 'senza data di review' : k < 0 ? 'review scaduta da ' + (-k) + ' giorni' : k === 0 ? 'review oggi' : 'review tra ' + k + ' giorni (' + fmtDate(x.review_on) + ')';
      li.append(link(x.decision, x.decision_url), el('span', 'cm-sub' + (k !== null && k <= 0 ? ' cm-late' : ''), [when, x.domain].filter(Boolean).join(' · ')));
      return li;
    }));
  }

  function drawGoogle() {
    const card = $('google-card'), g = S.google;
    if (g.state === 'off' || g.state === 'idle') { card.hidden = true; $('nv-google').hidden = true; return; }
    card.hidden = false; $('nv-google').hidden = false;
    const ml = $('mail-list'), dl = $('drive-list');
    if (g.state === 'loading') { ml.replaceChildren(el('li', 'cm-empty cm-empty-li', 'Carico…')); dl.replaceChildren(); return; }
    if (g.state === 'error') { failedLine(ml, () => loadExtras()); dl.replaceChildren(); return; }
    $('mail-title').textContent = 'Gmail · ' + (g.mail.unread || 0) + ' non lette';
    ml.replaceChildren(...(g.mail.items.length ? g.mail.items.map((m) => {
      const li = el('li'); li.append(link(m.subject, m.url), el('span', 'cm-sub', [m.from, fmtDate(m.date)].filter(Boolean).join(' · '))); return li;
    }) : [el('li', 'cm-empty cm-empty-li', 'Nessuna mail importante da leggere.')]));
    dl.replaceChildren(...((g.drive && g.drive.items) || []).map((f) => {
      const li = el('li'); li.append(link(f.name, f.url), el('span', 'cm-sub', fmtDate(f.modified))); return li;
    }));
  }

  /* ---------- Sezioni espandibili ---------- */
  const sections = [];
  function setupSections() {
    document.querySelectorAll('.cm > .cm-card, .cm-row > .cm-card, .cm-grid > .cm-card').forEach((card) => {
      const h2 = card.querySelector('.cm-h2'); if (!h2) return;
      let head = h2; while (head.parentElement && head.parentElement !== card) head = head.parentElement;
      head.classList.add('cm-sec-head');
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'cm-toggle'; btn.setAttribute('aria-expanded', 'true');
      const chev = el('span', 'cm-chev'); chev.setAttribute('aria-hidden', 'true');
      while (h2.firstChild) btn.append(h2.firstChild);
      btn.prepend(chev); h2.append(btn);
      const set = (open) => { card.classList.toggle('is-collapsed', !open); btn.setAttribute('aria-expanded', String(open)); if (open) requestAnimationFrame(redrawAll); syncToggleAll(); };
      btn.addEventListener('click', () => set(card.classList.contains('is-collapsed')));
      card._setOpen = set;
      const up = el('button', 'cm-top', '↑'); up.type = 'button'; up.title = 'Torna in alto'; up.setAttribute('aria-label', 'Torna in alto');
      up.addEventListener('click', () => { const smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' }); });
      card.append(up);
      sections.push(set);
    });
  }

  /* Un solo pulsante: se tutte le sezioni sono aperte le comprime, altrimenti le apre tutte. */
  const allOpen = () => !document.querySelector('.cm-card.is-collapsed');
  function syncToggleAll() { const b = $('toggle-all'); if (b) b.textContent = allOpen() ? 'Comprimi tutto' : 'Espandi tutto'; }

  /* Vai a una sezione: la riapre se è compressa, poi ci scorre. */
  function goTo(id) {
    const card = $(id); if (!card || card.hidden) return;
    if (card._setOpen && card.classList.contains('is-collapsed')) card._setOpen(true);
    const smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    card.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }

  /* ---------- Redraw ---------- */
  function redrawAll() {
    drawSync(); drawHeadline(); drawAgenda(); drawMap(); drawAttention(); drawTasks();
    drawLoad(); drawStatus(); drawLog(); drawDecisions(); drawGoogle(); drawPortfolio(); drawNotesSoft();
  }
  /* Le note si ridisegnano senza toccare l'editor se ci stai scrivendo. */
  function drawNotesSoft() {
    const ed = $('nt-editor'); if (!ed) return;
    const focused = ed.contains(document.activeElement);
    const box = $('nt-board'); box.dataset.view = NT.q ? 'list' : NT.view;
    drawNoteTree(); drawNoteList(); if (!focused) drawNoteEditor(); drawNoteStatus();
  }

  /* ---------- Claude (abbonamento): copia il contesto e apre claude.ai ---------- */
  function copySync(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  function askClaude(mode) {
    const d = S.derived;
    if (!d || !d.portfolio) { toast('Dati non ancora caricati'); return; }
    const day = todayIso(), cal = S.cal[day];
    const agenda = cal && cal.status === 'ok' ? L.computeDayEvents(cal.rows, (S.notion && S.notion.meeting_rules) || []) : [];
    const text = L.buildDigest({
      today: day, headline: d.headline, agenda, nextActions: d.nextActions, portfolio: d.portfolio,
      decisions: (S.notion && S.notion.decisions) || [], worklog: (S.notion && S.notion.worklog) || [],
    }, mode);
    let copied = copySync(text);
    if (!copied && navigator.clipboard) navigator.clipboard.writeText(text).then(() => {}, () => {});
    toast(copied ? 'Contesto copiato: incollalo in Claude' : 'Apro Claude: copia manualmente se non è già negli appunti');
    window.open('https://claude.ai/new', '_blank', 'noopener');
  }

  /* ---------- Nuova task ---------- */
  function openTaskDialog() {
    const d = S.derived, sel = $('t-proj');
    sel.replaceChildren(new Option('Nessun progetto', ''));
    if (d && d.portfolio) {
      const act = d.portfolio.filter((p) => p.status !== 'Backlog').sort((a, b) => a.name.localeCompare(b.name));
      act.forEach((p) => sel.append(new Option(shortName(p.name), p.project_id)));
    }
    $('task-form').reset(); $('t-msg').hidden = true; $('t-save').disabled = false;
    const dlg = $('task-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    setTimeout(() => $('t-title').focus(), 30);
  }
  $('task-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('t-msg');
    const body = {
      title: $('t-title').value.trim(),
      priority: (document.querySelector('input[name=prio]:checked') || {}).value || 'Medium',
      status: (document.querySelector('input[name=status]:checked') || {}).value || 'Not Started',
    };
    if (!body.title) return;
    if ($('t-due').value) body.due = $('t-due').value;
    if ($('t-rec').value) body.recurrence = $('t-rec').value;
    if ($('t-proj').value) body.project_id = $('t-proj').value;
    if ($('t-notes').value.trim()) body.notes = $('t-notes').value.trim();
    if ($('t-links').value.trim()) body.links = $('t-links').value.trim();
    $('t-save').disabled = true;
    try {
      const r = await api('/api/tasks', { method: 'POST', body });
      markConverted(r && r.url);
      $('task-dialog').close();
      toast('Task creata in Notion');
      await loadNotion(true); redrawAll();
      return r;
    } catch (e) {
      msg.className = 'form-msg err'; msg.textContent = e.message; msg.hidden = false; $('t-save').disabled = false;
    }
  });
  $('t-cancel').addEventListener('click', () => $('task-dialog').close());

  /* ---------- Scrivere su Google: evento, email, Doc ---------- */
  const openDlg = (id) => { const d = $(id); if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); };
  const showMsg = (id, text, ok) => { const m = $(id); m.className = 'form-msg ' + (ok ? 'ok' : 'err'); m.textContent = text; m.hidden = false; };
  const needGoogle = () => { if (S.google.state === 'off') { toast('Google non è collegato: vedi il README'); return true; } return false; };

  function openEventDialog() {
    if (needGoogle()) return;
    $('event-form').reset(); $('e-msg').hidden = true; $('e-save').disabled = false;
    const h = new Date().getHours() + 1, t = (n) => pad(Math.min(23, n)) + ':00';
    $('e-date').value = S.day || todayIso(); $('e-start').value = t(h); $('e-end').value = h >= 23 ? '23:59' : t(h + 1);
    $('e-times').hidden = false;
    openDlg('event-dialog'); setTimeout(() => $('e-title').focus(), 30);
  }
  $('e-allday').addEventListener('change', () => { $('e-times').hidden = !!$('e-allday').value; });
  $('event-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const allDay = !!$('e-allday').value, day = $('e-date').value;
    const body = { title: $('e-title').value.trim(), description: $('e-notes').value.trim(), location: $('e-loc').value.trim() };
    if (!body.title || !day) return;
    if (allDay) { body.all_day = true; body.start = day; }
    else {
      if (!$('e-start').value || !$('e-end').value) return showMsg('e-msg', 'Inserisci inizio e fine');
      body.start = day + 'T' + $('e-start').value + ':00'; body.end = day + 'T' + $('e-end').value + ':00';
    }
    $('e-save').disabled = true;
    try {
      await api('/api/calendar/events', { method: 'POST', body });
      $('event-dialog').close(); toast('Evento creato nel calendario personale');
      if (S.day) { delete S.cal[S.day]; loadCalendar(S.day, true); }
    } catch (e) { showMsg('e-msg', e.message); $('e-save').disabled = false; }
  });
  $('e-cancel').addEventListener('click', () => $('event-dialog').close());

  function openMailDialog() {
    if (needGoogle()) return;
    $('mail-form').reset(); $('m-msg').hidden = true; $('m-draft').disabled = false; $('m-send').disabled = false;
    openDlg('mail-dialog'); setTimeout(() => $('m-to').focus(), 30);
  }
  async function submitMail(mode) {
    const to = $('m-to').value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean), subject = $('m-subj').value.trim();
    if (!to.length || !subject) return showMsg('m-msg', 'Servono almeno destinatario e oggetto');
    if (mode === 'send' && !window.confirm('Invio davvero questa email a ' + to.join(', ') + '?')) return;
    $('m-draft').disabled = true; $('m-send').disabled = true;
    try {
      await api('/api/mail/send', { method: 'POST', body: { mode, confirm: mode === 'send', to, subject, body: $('m-body').value } });
      $('mail-dialog').close(); toast(mode === 'send' ? 'Email inviata' : 'Bozza salvata in Gmail');
      if (mode === 'send') loadExtras();
    } catch (e) { showMsg('m-msg', e.message); $('m-draft').disabled = false; $('m-send').disabled = false; }
  }
  $('mail-form').addEventListener('submit', (ev) => { ev.preventDefault(); submitMail('draft'); });
  $('m-send').addEventListener('click', () => submitMail('send'));
  $('m-cancel').addEventListener('click', () => $('mail-dialog').close());

  function openDocDialog() {
    if (needGoogle()) return;
    $('doc-form').reset(); $('d-msg').hidden = true; $('d-save').disabled = false;
    openDlg('doc-dialog'); setTimeout(() => $('d-name').focus(), 30);
  }
  $('doc-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = $('d-name').value.trim(); if (!name) return;
    $('d-save').disabled = true;
    try {
      const r = await api('/api/drive/docs', { method: 'POST', body: { name, content: $('d-text').value } });
      markConverted(r && (r.url || r.doc_url));
      $('doc-dialog').close(); toast('Doc creato su Drive'); loadExtras();
    } catch (e) { showMsg('d-msg', e.message); $('d-save').disabled = false; }
  });
  $('d-cancel').addEventListener('click', () => $('doc-dialog').close());

  /* ---------- Note: Workbook › Notebook › Nota ----------
     Prima salvo sul dispositivo, poi invio a Notion (2 secondi dopo che smetti di scrivere).
     Se il Worker non risponde le modifiche restano qui e partono al primo collegamento. */
  const NOTE_COLORS = { default: '#8AA0AD', gray: '#7FB3C8', brown: '#B08968', orange: BRAND.tang, yellow: BRAND.sun, green: BRAND.jade, blue: BRAND.sea, purple: '#8E7CC3', pink: '#E86A92', red: BRAND.rasp };
  const NT = {
    state: 'idle', err: '', workbooks: [], notes: [],
    wb: null, nb: null, cur: null, q: '', view: 'wb',
    bodies: {},     // id -> { content, base, readonly, loading }
    pending: {},    // id -> { fields…, content?, base_content? }
    inflight: {}, timers: {}, conflict: null, lastSaved: null, offline: false,
  };
  const jget = (k, d) => { try { const v = JSON.parse(store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const persistNotes = () => {
    store.set('cm_notes', JSON.stringify({ workbooks: NT.workbooks, notes: NT.notes }));
    store.set('cm_notes_bodies', JSON.stringify(NT.bodies, (k, v) => (k === 'loading' ? undefined : v)));
    store.set('cm_notes_pending', JSON.stringify(NT.pending));
    store.set('cm_notes_sel', JSON.stringify({ wb: NT.wb, nb: NT.nb, cur: NT.cur }));
  };
  function hydrateNotes() {
    const c = jget('cm_notes', null);
    if (c && Array.isArray(c.notes)) { NT.workbooks = c.workbooks || []; NT.notes = c.notes; NT.state = 'ok'; }
    NT.bodies = jget('cm_notes_bodies', {});
    NT.pending = jget('cm_notes_pending', {});
    const s = jget('cm_notes_sel', {});
    NT.wb = s.wb || null; NT.nb = s.nb || null; NT.cur = s.cur || null;
  }
  const noteById = (id) => NT.notes.find((n) => n.id === id);
  const isTmp = (id) => String(id).startsWith('tmp-');
  const wbColor = (name) => { const o = NT.workbooks.find((w) => w.name === name); return NOTE_COLORS[(o && o.color) || 'default'] || NOTE_COLORS.default; };
  const visibleNotes = () => NT.notes.filter((n) => n.stato !== 'Archiviata');
  function workbookList() {
    const names = NT.workbooks.map((w) => w.name);
    visibleNotes().forEach((n) => { if (!names.includes(n.workbook)) names.push(n.workbook); });
    return names;
  }
  function notebookList(wb) {
    const list = [];
    visibleNotes().filter((n) => n.workbook === wb).forEach((n) => { if (!list.includes(n.notebook)) list.push(n.notebook); });
    return list.sort((a, b) => a.localeCompare(b, 'it'));
  }
  const byEdited = (a, b) => String(b.edited || '').localeCompare(String(a.edited || ''));

  async function loadNotes() {
    if (NT.state !== 'ok') NT.state = 'loading';
    drawNotes();
    try {
      const d = await api('/api/notes');
      /* Le note con modifiche non ancora inviate tengono la versione locale. */
      const local = {};
      NT.notes.forEach((n) => { if (NT.pending[n.id]) local[n.id] = n; });
      const fresh = (d.notes || []).map((n) => local[n.id] || n);
      NT.notes.filter((n) => isTmp(n.id)).forEach((n) => fresh.unshift(n));
      NT.notes = fresh; NT.workbooks = d.workbooks || [];
      NT.state = 'ok'; NT.err = ''; NT.offline = false;
      const ids = new Set(NT.notes.map((n) => n.id));
      Object.keys(NT.bodies).forEach((id) => { if (!ids.has(id)) delete NT.bodies[id]; });
      persistNotes();
    } catch (e) {
      if (e.status === 401) return;
      NT.err = e.message;
      if (NT.state !== 'ok') NT.state = 'error'; else NT.offline = true;
    }
    fixSelection(); drawNotes(); flushAll();
  }

  function fixSelection() {
    const wbs = workbookList();
    if (!NT.wb || !wbs.includes(NT.wb)) NT.wb = wbs.find((w) => notebookList(w).length) || wbs[0] || null;
    const nbs = NT.wb ? notebookList(NT.wb) : [];
    if (!NT.nb || !nbs.includes(NT.nb)) NT.nb = nbs[0] || null;
    const cur = NT.cur && noteById(NT.cur);
    if (!cur || cur.stato === 'Archiviata') NT.cur = null;
  }

  /* Apre una nota: mostra subito la copia locale, poi chiede a Notion la versione aggiornata. */
  async function openNote(id, opts) {
    NT.cur = id; NT.conflict = null;
    const n = noteById(id); if (n) { NT.wb = n.workbook; NT.nb = n.notebook; }
    NT.view = 'note'; persistNotes(); drawNotes(true);
    if (isTmp(id)) return;
    const b = NT.bodies[id] || (NT.bodies[id] = { content: '', base: '', readonly: false });
    if (NT.pending[id] && 'content' in NT.pending[id]) return;
    if (!b.fetched) b.loading = true;
    if (opts && opts.noFetch) return;
    try {
      const d = await api('/api/notes/' + id);
      const nowB = NT.bodies[id];
      if (!nowB || (NT.pending[id] && 'content' in NT.pending[id])) return;
      Object.assign(nowB, { content: d.content, base: d.content, readonly: !!d.readonly, fetched: true, loading: false });
      const i = NT.notes.findIndex((x) => x.id === id); if (i >= 0) NT.notes[i] = Object.assign({}, NT.notes[i], pick(d));
      persistNotes();
      if (NT.cur !== id) return;
      const ta = $('nt-body');
      if (ta && !d.readonly && document.activeElement !== $('nt-title')) {
        /* Aggiorno solo il testo, senza ridisegnare: se stai già scrivendo nel titolo non perdi il cursore. */
        if (ta.value !== d.content) ta.value = d.content;
        ta.classList.remove('dash-skeleton'); drawNoteList(); drawNoteStatus();
      } else if (!ta || d.readonly) drawNotes(true);
    } catch (e) {
      if (NT.bodies[id]) NT.bodies[id].loading = false;
      if (e.status === 410 || e.status === 404) { NT.notes = NT.notes.filter((x) => x.id !== id); NT.cur = null; persistNotes(); toast('La nota non esiste più in Notion'); drawNotes(true); return; }
      if (NT.cur === id) { NT.offline = true; drawNoteStatus(); }
    }
  }
  const pick = (d) => ({ id: d.id, url: d.url, title: d.title, workbook: d.workbook, notebook: d.notebook, stato: d.stato, diventata: d.diventata, project_ids: d.project_ids, created: d.created, edited: d.edited });

  /* Crea una nota (prima sul dispositivo, poi in Notion). */
  function newNote(fields, open) {
    const id = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    const n = { id, url: '', title: fields.title || '', workbook: fields.workbook, notebook: fields.notebook, stato: 'Attiva', diventata: '', project_ids: fields.project_id ? [fields.project_id] : [], created: now, edited: now };
    NT.notes.unshift(n);
    NT.bodies[id] = { content: fields.content || '', base: '', readonly: false, fetched: true };
    NT.pending[id] = { title: n.title, workbook: n.workbook, notebook: n.notebook, content: fields.content || '' };
    if (fields.project_id) NT.pending[id].project_id = fields.project_id;
    persistNotes();
    if (open) openNote(id); else drawNotes();
    flushNote(id);
    return id;
  }

  /* Registra una modifica e programma l'invio. */
  function queueChange(id, fields, now) {
    const n = noteById(id); if (!n) return;
    const p = NT.pending[id] || (NT.pending[id] = {});
    Object.assign(p, fields);
    if ('content' in fields) {
      const b = NT.bodies[id] || (NT.bodies[id] = { content: '', base: '', readonly: false });
      b.content = fields.content;
      if (!('base_content' in p)) p.base_content = b.base || '';
    }
    ['title', 'workbook', 'notebook', 'stato', 'diventata'].forEach((k) => { if (k in fields) n[k] = fields[k]; });
    if ('project_id' in fields) n.project_ids = fields.project_id ? [fields.project_id] : [];
    n.edited = new Date().toISOString();
    persistNotes();
    clearTimeout(NT.timers[id]);
    NT.timers[id] = setTimeout(() => flushNote(id), now ? 0 : 2000);
    drawNoteStatus();
  }

  async function flushNote(id, force) {
    clearTimeout(NT.timers[id]);
    const p = NT.pending[id]; if (!p) return;
    if (force) p.force = true;
    /* Con un conflitto aperto aspetto la tua scelta, senza ritentare da solo. */
    if (NT.conflict && NT.conflict.id === id && !p.force) return;
    if (NT.inflight[id]) { NT.inflight[id].again = true; return; }
    const sent = JSON.parse(JSON.stringify(p));
    NT.inflight[id] = { again: false };
    drawNoteStatus();
    try {
      let d, sentKeys;
      if (isTmp(id)) {
        /* Nota nuova: la creo. Stato e link, se cambiati nel frattempo, partono subito dopo. */
        sentKeys = ['title', 'workbook', 'notebook', 'content', 'project_id', 'base_content'].filter((k) => k in sent);
        d = await api('/api/notes', { method: 'POST', body: { title: sent.title, workbook: sent.workbook, notebook: sent.notebook, content: sent.content || '', project_id: sent.project_id || undefined } });
      } else {
        sentKeys = Object.keys(sent);
        d = await api('/api/notes/' + id, { method: 'POST', body: sent });
      }
      const newId = d.id;
      const cur = NT.pending[id];
      /* Tolgo dal pendente solo ciò che è stato inviato e non è cambiato nel frattempo. */
      sentKeys.forEach((k) => { if (cur && JSON.stringify(cur[k]) === JSON.stringify(sent[k])) delete cur[k]; });
      if (cur && 'base_content' in cur && !('content' in cur)) delete cur.base_content;
      if (cur && !('content' in cur)) delete cur.force;
      const b = NT.bodies[id] || { content: '', readonly: false };
      if (typeof d.content === 'string') { b.base = d.content; if (cur && 'content' in cur) cur.base_content = d.content; }
      b.fetched = true;
      const idx = NT.notes.findIndex((x) => x.id === id);
      if (idx >= 0) {
        const local = NT.notes[idx];
        const merged = Object.assign({}, pick(d));
        if (cur) ['title', 'workbook', 'notebook', 'stato', 'diventata'].forEach((k) => { if (k in cur) merged[k] = local[k]; });
        NT.notes[idx] = merged;
      }
      if (newId !== id) {
        /* Nota nuova o ricreata: cambia l'indirizzo in Notion. */
        NT.bodies[newId] = b; delete NT.bodies[id];
        if (cur && Object.keys(cur).length) NT.pending[newId] = cur;
        delete NT.pending[id];
        if (NT.cur === id) NT.cur = newId;
        if (NT.inflight[id]) NT.inflight[newId] = NT.inflight[id];
      } else if (cur && !Object.keys(cur).length) delete NT.pending[id];
      const fin = NT.inflight[newId] || NT.inflight[id];
      delete NT.inflight[id]; delete NT.inflight[newId];
      NT.lastSaved = new Date(); NT.offline = false; NT.conflict = null;
      if (NT.notes[idx] && NT.notes[idx].stato === 'Archiviata') { NT.notes.splice(idx, 1); delete NT.bodies[newId]; delete NT.pending[newId]; if (NT.cur === newId) NT.cur = null; fixSelection(); }
      persistNotes();
      /* Non ridisegno l'editor: perderesti il punto in cui stai scrivendo. */
      drawNoteTree(); drawNoteList(); drawNoteStatus();
      if (!NT.cur) drawNoteEditor();
      if (fin && fin.again || NT.pending[newId]) { clearTimeout(NT.timers[newId]); NT.timers[newId] = setTimeout(() => flushNote(newId), 600); }
    } catch (e) {
      delete NT.inflight[id];
      if (e.status === 401) { drawNoteStatus(); return; }
      if (e.code === 'conflict') {
        /* Le altre modifiche (titolo, posizione, stato) non aspettano: le invio da sole. */
        const cur = NT.pending[id]; NT.conflict = { id, message: e.message };
        const props = {}; if (cur) Object.keys(cur).forEach((k) => { if (!['content', 'base_content', 'force'].includes(k)) props[k] = cur[k]; });
        drawNoteStatus();
        if (Object.keys(props).length) {
          try { const d2 = await api('/api/notes/' + id, { method: 'POST', body: props }); Object.keys(props).forEach((k) => { if (cur && JSON.stringify(cur[k]) === JSON.stringify(props[k])) delete cur[k]; }); const i2 = NT.notes.findIndex((x) => x.id === id); if (i2 >= 0) NT.notes[i2] = Object.assign({}, NT.notes[i2], { url: d2.url, edited: d2.edited, stato: d2.stato, diventata: d2.diventata }); if (d2.stato === 'Archiviata') { NT.notes = NT.notes.filter((x) => x.id !== id); delete NT.pending[id]; delete NT.bodies[id]; if (NT.cur === id) { NT.cur = null; NT.conflict = null; } } persistNotes(); drawNoteTree(); drawNoteList(); drawNoteStatus(); }
          catch (e2) { /* resta in attesa */ }
        }
        return;
      }
      if (e.code === 'readonly') {
        const cur = NT.pending[id]; if (cur) { delete cur.content; delete cur.base_content; if (!Object.keys(cur).length) delete NT.pending[id]; }
        if (NT.bodies[id]) NT.bodies[id].readonly = true;
        persistNotes(); toast(e.message); openNote(id); return;
      }
      if (e.status === 410 || e.status === 404) {
        NT.notes = NT.notes.filter((x) => x.id !== id); delete NT.pending[id]; delete NT.bodies[id];
        if (NT.cur === id) NT.cur = null; persistNotes(); toast('La nota non esiste più in Notion'); drawNotes(); return;
      }
      if (e.status === 400) { NT.err = e.message; toast(e.message); drawNoteStatus(); return; }
      NT.offline = true; drawNoteStatus();
    }
  }
  function flushAll() { Object.keys(NT.pending).forEach((id) => { if (!NT.inflight[id]) flushNote(id); }); }

  /* Conflitto: la nota è cambiata in Notion mentre la modificavi qui. */
  async function resolveConflict(keepMine) {
    const c = NT.conflict; if (!c) return;
    NT.conflict = null;
    if (keepMine) { if (NT.pending[c.id]) NT.pending[c.id].force = true; flushNote(c.id, true); return; }
    const p = NT.pending[c.id]; if (p) { delete p.content; delete p.base_content; if (!Object.keys(p).length) delete NT.pending[c.id]; }
    if (NT.bodies[c.id]) NT.bodies[c.id].fetched = false;
    persistNotes(); openNote(c.id);
  }

  /* Disegno */
  function drawNotes(editorToo) {
    const box = $('nt-board'); if (!box) return;
    box.dataset.view = NT.q ? 'list' : NT.view;
    drawNoteTree(); drawNoteList();
    if (editorToo !== false) drawNoteEditor();
    drawNoteStatus();
  }
  function drawNoteTree() {
    const tree = $('nt-tree');
    if (NT.state === 'loading' && !NT.notes.length) { tree.replaceChildren(el('p', 'cm-empty', 'Carico le note…')); return; }
    if (NT.state === 'error') { failedLine(tree, loadNotes); tree.append(el('p', 'dy-note', NT.err)); return; }
    const out = [el('p', 'nt-lbl', 'Workbook')];
    workbookList().forEach((w) => {
      const b = el('button', 'nt-wb' + (w === NT.wb ? ' on' : '')); b.type = 'button';
      b.style.setProperty('--wc', wbColor(w));
      b.append(el('i'), el('span', '', w), el('span', 'nt-ct', String(visibleNotes().filter((n) => n.workbook === w).length)));
      b.addEventListener('click', () => { NT.wb = w; NT.nb = notebookList(w)[0] || null; NT.cur = null; NT.q = ''; $('nt-q').value = ''; NT.view = 'wb'; persistNotes(); drawNotes(); });
      out.push(b);
      if (w === NT.wb) {
        notebookList(w).forEach((nb) => {
          const x = el('button', 'nt-nb' + (nb === NT.nb && !NT.q ? ' on' : '')); x.type = 'button';
          x.append(el('span', '', nb), el('span', 'nt-ct', String(visibleNotes().filter((n) => n.workbook === w && n.notebook === nb).length)));
          x.addEventListener('click', () => { NT.nb = nb; NT.q = ''; $('nt-q').value = ''; NT.view = 'list'; persistNotes(); drawNotes(false); });
          out.push(x);
        });
        const add = el('button', 'nt-nb nt-add', '+ Notebook'); add.type = 'button';
        add.addEventListener('click', () => askName('Nuovo notebook in ' + w, 'Nome del notebook', (name) => {
          NT.nb = name; NT.q = '';
          if (notebookList(w).includes(name)) { NT.view = 'list'; persistNotes(); drawNotes(); toast('Il notebook ' + name + ' esiste già: l\'ho aperto'); return; }
          newNote({ workbook: w, notebook: name, title: '' }, true);
        }));
        out.push(add);
      }
    });
    const addW = el('button', 'nt-wb nt-add', '+ Workbook'); addW.type = 'button';
    addW.addEventListener('click', () => askName('Nuovo workbook', 'Nome del workbook', (name) => {
      const ex = notebookList(name); NT.wb = name; NT.q = '';
      if (ex.length) { NT.nb = ex[0]; NT.view = 'wb'; persistNotes(); drawNotes(); toast('Il workbook ' + name + ' esiste già: l\'ho aperto'); return; }
      NT.nb = 'Generale'; newNote({ workbook: name, notebook: 'Generale', title: '' }, true);
    }));
    out.push(addW);
    tree.replaceChildren(...out);
  }
  function noteSnippet(n) {
    const b = NT.bodies[n.id]; const t = b && b.content ? b.content.split('\n').find((l) => l.trim()) || '' : '';
    return t.replace(/^(\s*[-*•]\s+|\s*\[[ xX]\]\s?)/, '').slice(0, 70);
  }
  function drawNoteList() {
    const list = $('nt-list'), head = $('nt-list-head');
    const q = NT.q.trim().toLowerCase();
    let rows;
    if (q) {
      rows = visibleNotes().filter((n) => (n.title || '').toLowerCase().includes(q) || ((NT.bodies[n.id] && NT.bodies[n.id].content) || '').toLowerCase().includes(q));
      head.textContent = rows.length + (rows.length === 1 ? ' nota trovata' : ' note trovate');
    } else {
      rows = visibleNotes().filter((n) => n.workbook === NT.wb && n.notebook === NT.nb);
      head.textContent = NT.wb ? NT.wb + (NT.nb ? ' › ' + NT.nb : '') : 'Nessun workbook';
    }
    rows.sort(byEdited);
    const items = rows.map((n) => {
      const b = el('button', 'nt-it' + (n.id === NT.cur ? ' on' : '')); b.type = 'button';
      const t = el('span', 'nt-it-t', n.title || 'Senza titolo'); if (!n.title) t.classList.add('is-empty');
      const meta = [q ? n.workbook + ' › ' + n.notebook : '', n.edited ? fmtDate(String(n.edited).slice(0, 10)) : '', n.stato === 'Trasformata' ? 'trasformata' : '', NT.pending[n.id] ? 'da inviare' : ''].filter(Boolean).join(' · ');
      b.append(t, el('span', 'nt-it-s', noteSnippet(n) || ' '), el('span', 'nt-it-m', meta));
      b.addEventListener('click', () => openNote(n.id));
      return b;
    });
    if (!q && NT.wb && NT.nb) {
      const add = el('button', 'nt-it nt-add', '+ Nuova nota'); add.type = 'button';
      add.addEventListener('click', () => newNote({ workbook: NT.wb, notebook: NT.nb, title: '' }, true));
      items.push(add);
    }
    if (!items.length) items.push(el('p', 'cm-empty', q ? 'Nessuna nota con queste parole.' : 'Scegli o crea un notebook a sinistra.'));
    list.replaceChildren(...items);
  }
  function drawNoteEditor() {
    const ed = $('nt-editor');
    const n = NT.cur && noteById(NT.cur);
    if (!n) {
      ed.replaceChildren(el('p', 'cm-empty nt-placeholder', NT.notes.length ? 'Apri una nota dall\'elenco, o creane una nuova.' : 'Nessuna nota ancora. Crea un workbook o usa “+ Nota” in alto.'));
      return;
    }
    const b = NT.bodies[n.id] || { content: '', readonly: false };
    const back = el('button', 'cm-btn nt-back', '‹ Note'); back.type = 'button';
    back.addEventListener('click', () => { NT.view = 'list'; drawNotes(false); });
    const path = el('div', 'nt-path'); path.append(back, el('span', '', n.workbook + ' › ' + n.notebook));
    const title = el('input', 'field-in nt-title'); title.id = 'nt-title'; title.value = n.title || ''; title.placeholder = 'Titolo'; title.maxLength = 200;
    title.addEventListener('input', () => { queueChange(NT.cur, { title: title.value }); const it = document.querySelector('#nt-list .nt-it.on .nt-it-t'); if (it) { it.textContent = title.value || 'Senza titolo'; it.classList.toggle('is-empty', !title.value); } });
    const body = el('textarea', 'field-in nt-body'); body.id = 'nt-body'; body.value = b.content || ''; body.placeholder = 'Scrivi… Una riga con “- ” diventa un elenco, con “[ ] ” una checkbox.'; body.maxLength = 20000;
    body.readOnly = !!b.readonly;
    body.addEventListener('input', () => queueChange(NT.cur, { content: body.value }));
    body.addEventListener('blur', () => { if (NT.pending[NT.cur]) flushNote(NT.cur); });
    const kids = [path, title];
    if (b.readonly) kids.push(el('p', 'form-msg', 'Questa nota contiene elementi aggiunti in Notion (titoli, immagini, tabelle…): qui puoi leggerla e cambiarne titolo o posizione, il testo si modifica da Notion.'));
    if (b.loading && !b.content) body.classList.add('dash-skeleton');
    kids.push(body);
    const conflict = el('div', 'form-msg err nt-conflict'); conflict.id = 'nt-conflict'; conflict.hidden = true;
    kids.push(conflict);
    const proj = el('select', 'field-in nt-proj'); proj.setAttribute('aria-label', 'Progetto');
    proj.append(new Option('Nessun progetto', ''));
    const d = S.derived;
    if (d && d.portfolio) d.portfolio.filter((p) => p.status !== 'Backlog' || (n.project_ids || []).includes(p.project_id)).sort((a, c) => a.name.localeCompare(c.name)).forEach((p) => proj.append(new Option(shortName(p.name), p.project_id)));
    proj.value = (n.project_ids || [])[0] || '';
    if (proj.value !== ((n.project_ids || [])[0] || '')) { proj.append(new Option('Progetto collegato', n.project_ids[0])); proj.value = n.project_ids[0]; }
    proj.addEventListener('change', () => queueChange(NT.cur, { project_id: proj.value }, true));
    const acts = el('div', 'nt-acts');
    const btn = (label, fn, extra) => { const x = el('button', 'cm-btn' + (extra ? ' ' + extra : ''), label); x.type = 'button'; x.addEventListener('click', fn); return x; };
    acts.append(
      btn('Trasforma in task', () => noteToTask(NT.cur), 'nt-main'),
      btn('In bozza email', () => noteToMail(NT.cur)),
      btn('In Doc su Drive', () => noteToDoc(NT.cur)),
      btn('Sposta', () => moveNote(NT.cur)),
      btn('Archivia', () => archiveNote(NT.cur)),
    );
    if (n.url) { const a = link('Apri in Notion', n.url); a.className = 'cm-btn'; acts.append(a); }
    if (n.diventata) { const a = link('Vedi cosa è diventata', n.diventata); a.className = 'cm-btn'; acts.append(a); }
    const foot = el('div', 'nt-foot'); foot.append(proj, el('span', 'nt-status', ''));
    kids.push(acts, foot);
    ed.replaceChildren(...kids);
  }
  function drawNoteStatus() {
    const s = document.querySelector('#nt-editor .nt-status'), id = NT.cur;
    const c = $('nt-conflict');
    if (c) {
      if (NT.conflict && NT.conflict.id === id) {
        c.hidden = false;
        const k1 = el('button', 'cm-btn', 'Tieni la versione di Notion'); k1.type = 'button'; k1.addEventListener('click', () => resolveConflict(false));
        const k2 = el('button', 'cm-btn', 'Sovrascrivi con la mia'); k2.type = 'button'; k2.addEventListener('click', () => resolveConflict(true));
        c.replaceChildren(el('span', '', 'La nota è stata modificata in Notion mentre la scrivevi qui. '), k1, k2);
      } else c.hidden = true;
    }
    const pend = Object.keys(NT.pending).length;
    const g = $('nt-sync');
    if (g) g.textContent = pend ? pend + (pend === 1 ? ' nota da inviare a Notion' : ' note da inviare a Notion') + (NT.offline ? ' · nessuna connessione, riprovo da solo' : '') : (NT.offline ? 'Note salvate sul dispositivo: Notion non raggiungibile' : '');
    if (!s || !id) return;
    let text, cls = '';
    if (NT.inflight[id]) text = 'Salvo…';
    else if (NT.pending[id]) { text = NT.offline ? 'Salvata sul dispositivo, la invio appena torna la connessione' : 'Modifiche in corso'; cls = 'is-wait'; }
    else if (NT.lastSaved) text = 'Salvata in Notion · ' + NT.lastSaved.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    else text = isTmp(id) ? '' : 'Salvata in Notion';
    s.textContent = text; s.className = 'nt-status ' + cls;
  }

  /* Piccola finestra per dare un nome (workbook, notebook). */
  function askName(title, label, done, initial) {
    $('n-title').textContent = title; $('n-label').textContent = label;
    $('n-input').value = initial || ''; $('n-msg').hidden = true;
    const dlg = $('name-dialog'); dlg._done = done; openDlg('name-dialog'); setTimeout(() => $('n-input').focus(), 30);
  }
  $('name-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = $('n-input').value.trim();
    if (!v || v.length > 80 || v.includes(',')) { showMsg('n-msg', 'Max 80 caratteri e senza virgole'); return; }
    const dlg = $('name-dialog'); dlg.close(); if (dlg._done) dlg._done(v);
  });
  $('n-cancel').addEventListener('click', () => $('name-dialog').close());

  /* Sposta in un altro workbook / notebook. */
  let moving = null;
  function fillMoveLists(wb) {
    const nbs = notebookList(wb);
    $('mv-nb-list').replaceChildren(...nbs.map((x) => new Option(x, x)));
  }
  function moveNote(id) {
    const n = noteById(id); if (!n) return;
    moving = id;
    const sel = $('mv-wb');
    sel.replaceChildren(...workbookList().map((w) => new Option(w, w)), new Option('+ Nuovo workbook…', '__new'));
    sel.value = n.workbook; $('mv-wb-new').hidden = true; $('mv-wb-new').value = '';
    $('mv-nb').value = n.notebook; fillMoveLists(n.workbook); $('mv-msg').hidden = true;
    openDlg('move-dialog');
  }
  $('mv-wb').addEventListener('change', () => { const nw = $('mv-wb').value === '__new'; $('mv-wb-new').hidden = !nw; if (!nw) fillMoveLists($('mv-wb').value); });
  $('move-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const wb = ($('mv-wb').value === '__new' ? $('mv-wb-new').value : $('mv-wb').value).trim(), nb = $('mv-nb').value.trim();
    const okName = (v) => v && v.length <= 80 && !v.includes(',');
    if (!okName(wb) || !okName(nb)) { showMsg('mv-msg', 'Workbook e notebook: max 80 caratteri, senza virgole'); return; }
    $('move-dialog').close();
    queueChange(moving, { workbook: wb, notebook: nb }, true);
    NT.wb = wb; NT.nb = nb; persistNotes(); drawNotes(); toast('Nota spostata in ' + wb + ' › ' + nb);
  });
  $('mv-cancel').addEventListener('click', () => $('move-dialog').close());

  function archiveNote(id) {
    const n = noteById(id); if (!n) return;
    if (!window.confirm('Archivio “' + (n.title || 'Senza titolo') + '”? Resta in Notion con stato Archiviata.')) return;
    if (isTmp(id) && !NT.inflight[id]) {
      NT.notes = NT.notes.filter((x) => x.id !== id); delete NT.pending[id]; delete NT.bodies[id];
    } else {
      queueChange(id, { stato: 'Archiviata' }, true);
      n.stato = 'Archiviata';
    }
    NT.cur = null; NT.view = 'list'; fixSelection(); persistNotes(); drawNotes(); toast('Nota archiviata');
  }

  /* Da nota a task, email o Doc. */
  let fromNote = null;
  const noteText = (id) => ((NT.bodies[id] && NT.bodies[id].content) || '').trim();
  function noteToTask(id) {
    const n = noteById(id); if (!n) return;
    openTaskDialog();
    fromNote = id;
    $('t-title').value = (n.title || noteText(id).split('\n')[0] || '').slice(0, 300);
    $('t-notes').value = noteText(id).slice(0, 1900);
    const pid = (n.project_ids || [])[0];
    if (pid && [...$('t-proj').options].some((o) => o.value === pid)) $('t-proj').value = pid;
  }
  function noteToMail(id) {
    const n = noteById(id); if (!n) return;
    if (needGoogle()) return;
    openMailDialog();
    $('m-subj').value = (n.title || '').slice(0, 300); $('m-body').value = noteText(id);
  }
  function noteToDoc(id) {
    const n = noteById(id); if (!n) return;
    if (needGoogle()) return;
    openDocDialog();
    fromNote = id;
    $('d-name').value = (n.title || 'Nota').slice(0, 200); $('d-text').value = noteText(id);
  }
  /* Dopo la creazione di una task o di un Doc partito da una nota: la nota diventa "Trasformata". */
  function markConverted(url) {
    const id = fromNote; fromNote = null;
    if (!id || !noteById(id)) return;
    const f = { stato: 'Trasformata' }; if (url && /^https:\/\//.test(url)) f.diventata = url;
    queueChange(id, f, true);
    if (NT.cur === id) drawNoteEditor();
  }
  ['task-dialog', 'doc-dialog'].forEach((d) => $(d).addEventListener('close', () => { setTimeout(() => { if (!$('task-dialog').open && !$('doc-dialog').open) fromNote = null; }, 0); }));

  /* Nota rapida dall'intestazione: va nell'Inbox, se non scegli altro. */
  function openQuickNote() {
    $('quick-form').reset(); $('qn-msg').hidden = true;
    const wbs = workbookList(); if (!wbs.includes('Inbox')) wbs.unshift('Inbox');
    $('qn-wb').replaceChildren(...wbs.map((w) => new Option(w, w)));
    $('qn-wb').value = 'Inbox'; $('qn-nb').value = 'Rapide';
    $('qn-nb-list').replaceChildren(...notebookList('Inbox').map((x) => new Option(x, x)));
    openDlg('quick-dialog'); setTimeout(() => $('qn-text').focus(), 30);
  }
  $('qn-wb').addEventListener('change', () => { const nbs = notebookList($('qn-wb').value); $('qn-nb-list').replaceChildren(...nbs.map((x) => new Option(x, x))); $('qn-nb').value = nbs[0] || 'Generale'; });
  $('quick-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('qn-text').value, title = $('qn-title').value.trim() || (text.trim().split('\n')[0] || '').slice(0, 80);
    const wb = $('qn-wb').value, nb = $('qn-nb').value.trim() || 'Rapide';
    if (!text.trim() && !title) { showMsg('qn-msg', 'Scrivi qualcosa'); return; }
    if (nb.length > 80 || nb.includes(',')) { showMsg('qn-msg', 'Notebook: max 80 caratteri, senza virgole'); return; }
    $('quick-dialog').close();
    newNote({ workbook: wb, notebook: nb, title, content: text }, false);
    toast('Nota salvata in ' + wb + ' › ' + nb);
  });
  $('qn-cancel').addEventListener('click', () => $('quick-dialog').close());

  function bindNotes() {
    $('add-note').addEventListener('click', openQuickNote);
    $('nt-q').addEventListener('input', () => { NT.q = $('nt-q').value; drawNotes(false); });
    $('nt-list-back').addEventListener('click', () => { NT.view = 'wb'; drawNotes(false); });
    window.addEventListener('online', flushAll);
    window.addEventListener('pagehide', () => { persistNotes(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { persistNotes(); flushAll(); } });
    setInterval(() => { if (Object.keys(NT.pending).length && getPass()) flushAll(); }, 60000);
  }

  /* ---------- Meeting → task collegata ---------- */
  let cardEvent = null;
  const evKey = (e) => (e.event_id || '') + '|' + String(e.start || '').slice(0, 10);
  const evLinks = () => jget('cm_evtask', {});
  function evWhen(e) {
    const d = new Date(String(e.start).slice(0, 10) + 'T12:00:00');
    const day = d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
    if (e.all_day) return day + ', tutto il giorno';
    const t = (x) => new Date(x).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: L.TZ });
    return day + ', ' + t(e.start) + (e.end ? '–' + t(e.end) : '');
  }
  function openEventCard(e) {
    cardEvent = e;
    $('ev-title').textContent = e.title;
    $('ev-when').textContent = evWhen(e);
    $('ev-meta').textContent = ['Calendario ' + e.source, 'importanza ' + e.importance + (e.rule ? ' (regola: ' + e.rule + ')' : '')].join(' · ');
    const known = evLinks()[evKey(e)];
    $('ev-open').textContent = known ? 'Apri la task collegata' : 'Apri task';
    $('ev-open').disabled = !e.event_id;
    $('ev-hint').textContent = !e.event_id ? 'Questo evento non ha un identificativo: aggiorna lo script Google.' : known ? 'La task esiste già: la apro in Notion.' : 'Se non c\'è ancora, la creo in Notion (scadenza il giorno del meeting) e la apro.';
    $('ev-msg').hidden = true; $('ev-link').hidden = true;
    openDlg('event-card');
  }
  $('ev-open').addEventListener('click', async () => {
    const e = cardEvent; if (!e || !e.event_id) return;
    /* Apro subito la scheda (i browser bloccano le finestre aperte dopo un'attesa), poi ci carico la task. */
    let w = null; try { w = window.open('about:blank', '_blank'); } catch (x) { w = null; }
    $('ev-open').disabled = true; $('ev-open').textContent = 'Un attimo…';
    try {
      const r = await api('/api/tasks/from-event', { method: 'POST', body: { event_id: e.event_id, day: String(e.start).slice(0, 10), title: e.title, when: evWhen(e), source: e.source } });
      const m = evLinks(); m[evKey(e)] = r.url; store.set('cm_evtask', JSON.stringify(m));
      if (w && !w.closed) { w.location.href = r.url; $('event-card').close(); }
      else { const a = $('ev-link'); a.href = safeUrl(r.url); a.hidden = false; }
      toast(r.existed ? 'Task collegata aperta' : 'Task creata in Notion');
      if (!r.existed) loadNotion(true).then(redrawAll);
    } catch (err) {
      if (w && !w.closed) w.close();
      showMsg('ev-msg', err.message);
    } finally { $('ev-open').disabled = false; $('ev-open').textContent = evLinks()[evKey(e)] ? 'Apri la task collegata' : 'Apri task'; }
  });
  $('ev-close').addEventListener('click', () => $('event-card').close());

  /* ---------- Eventi ---------- */
  function bind() {
    $('add-task').addEventListener('click', openTaskDialog);
    $('add-event').addEventListener('click', openEventDialog);
    $('add-mail').addEventListener('click', openMailDialog);
    $('add-doc').addEventListener('click', openDocDialog);
    bindNotes();
    $('refresh').addEventListener('click', () => refreshAll(true));
    $('claude-brief').addEventListener('click', () => askClaude('brief'));
    $('claude-weekly').addEventListener('click', () => askClaude('weekly'));
    $('f-horizon').addEventListener('change', drawTasks);
    $('f-priority').addEventListener('change', drawTasks);
    $('f-all').addEventListener('click', () => { S.showAll = !S.showAll; $('f-all').setAttribute('aria-pressed', String(S.showAll)); $('f-all').textContent = S.showAll ? 'Mostra le prime 12' : 'Mostra tutte'; drawTasks(); });
    const setDay = (d) => { S.day = d; drawAgenda(); loadCalendar(d); };
    $('day-prev').addEventListener('click', () => setDay(addDays(S.day, -1)));
    $('day-next').addEventListener('click', () => setDay(addDays(S.day, 1)));
    $('day-today').addEventListener('click', () => setDay(todayIso()));
    $('toggle-all').addEventListener('click', () => { const open = !allOpen(); sections.forEach((s) => s(open)); });
    document.querySelectorAll('[data-go]').forEach((n) => n.addEventListener('click', (ev) => { ev.preventDefault(); goTo(n.getAttribute('data-go')); }));
    const tb = $('tiles-toggle');
    tb.addEventListener('click', () => { const c = $('hero').classList.toggle('is-collapsed'); tb.setAttribute('aria-expanded', String(!c)); tb.textContent = c ? 'Mostra i numeri' : 'Nascondi i numeri'; });
    if (CFG.RULES_URL) $('rules-link').href = CFG.RULES_URL; else $('rules-link').hidden = true;
    let last = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !getPass()) return;
      if (Date.now() - last > 5 * 60000) { last = Date.now(); loadNotion(false).then(redrawAll); loadCalendar(S.day, true); loadNotes(); }
      else drawAgenda();
    });
    setInterval(() => { if (document.visibilityState === 'visible' && S.day === todayIso()) drawAgenda(); }, 60000);
  }

  /* ---------- Avvio ---------- */
  let started = false;
  function start() {
    if (started) { refreshAll(false); return; }
    started = true;
    hydrateFromCache();
    redrawAll();
    Promise.all([loadNotion(false), loadCalendar(S.day), loadExtras(), loadNotes()]).then(redrawAll);
  }

  function init() {
    S.day = todayIso();
    hydrateNotes(); fixSelection();
    setupSections();
    syncToggleAll();
    bind();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    if (!API || /TUO-SUBDOMINIO/.test(API)) { redrawAll(); showLock('Manca l\'indirizzo del Worker: modifica config.js (vedi guida).'); $('lock-form').querySelectorAll('input,button').forEach((n) => { n.disabled = true; }); return; }
    if (!getPass()) { redrawAll(); showLock(); return; }
    start();
  }
  init();
})();

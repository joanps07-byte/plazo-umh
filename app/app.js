// Plazo — app (sin dependencias, sin compilación).
// Lee el Campus Virtual UMH con la API móvil oficial de Moodle, directamente desde el dispositivo.
// El servidor de Plazo solo interviene si activas las notificaciones push.
import { demoData } from './demo.js';

const MOODLE = 'https://campus.umh.es';
const FORCED_DEMO = document.documentElement.hasAttribute('data-demo'); // vista previa sin servidor
const DEMO = FORCED_DEMO || new URLSearchParams(location.search).has('demo');
const NS = DEMO ? 'plazo.demo.' : 'plazo.';
const $ = (sel, root = document) => root.querySelector(sel);
const sec = () => Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch { /* almacenamiento lleno o bloqueado */ } },
  clear() { try { Object.keys(localStorage).filter((k) => k.startsWith(NS)).forEach((k) => localStorage.removeItem(k)); } catch { /* nada */ } },
};

const S = {
  account: store.get('account', null),
  data: store.get('data', null),
  server: store.get('server', { events: [], changes: [], prefs: null }),
  local: store.get('local', { changes: [], seenAt: 0, pushAsked: false }),
  settings: store.get('settings', { classes: false, theme: 'auto' }),
  view: 'hoy', filter: 'pendientes', feedFilter: 'todo', query: '',
  calMonth: null, calDay: null, busy: false, expired: false, push: false, error: null,
};
const save = (k) => store.set(k, S[k]);

/* ───────────── iconos ───────────── */
const I = {
  hoy: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  calendario: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  tareas: '<svg viewBox="0 0 24 24"><path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M3.5 6.5l1.2 1.2 2-2.4M3.5 12l1.2 1.2 2-2.4M3.5 17.5l1.2 1.2 2-2.4"/></svg>',
  avisos: '<svg viewBox="0 0 24 24"><path d="M6 10a6 6 0 1 1 12 0c0 4.5 2 5.5 2 6.5H4c0-1 2-2 2-6.5z"/><path d="M10 19.5a2 2 0 0 0 4 0"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5v4.2h-4.2"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l8 4.5V5.5L7 10H4z"/><path d="M18.5 9.5a4 4 0 0 1 0 5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.200 18.900l1-5.400-4-3.800 5.400-.700z"/></svg>',
  cap: '<svg viewBox="0 0 24 24"><path d="M2.500 9.500L12 5l9.500 4.500L12 14z"/><path d="M6.500 12v4c1.500 1.500 3.500 2 5.500 2s4-.500 5.500-2v-4"/></svg>',
};

/* ───────────── fechas ───────────── */
const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const D = (ts) => new Date(ts * 1000);
const dkey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayDiff = (ts) => Math.round((startOfDay(D(ts)) - startOfDay(new Date())) / 86400000);
const fullDate = (ts, withTime = true) => { const d = D(ts); return `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}${withTime ? ' · ' + hm(d) : ''}`; };
function rel(ts) {
  const diff = ts - sec(), a = Math.abs(diff), days = dayDiff(ts);
  let t;
  if (a < 3600) t = Math.max(1, Math.round(a / 60)) + ' min';
  else if (a < 24 * 3600) t = Math.round(a / 3600) + ' h';
  else if (days === 1) return 'mañana';
  else if (days === -1) return 'ayer';
  else t = Math.abs(days) + ' d';
  return diff >= 0 ? 'en ' + t : 'hace ' + t;
}
function ago(ts) {
  const a = sec() - ts;
  if (a < 3600) return Math.max(1, Math.round(a / 60)) + ' min';
  if (a < 86400) return Math.round(a / 3600) + ' h';
  if (a < 7 * 86400) return Math.round(a / 86400) + ' d';
  const d = D(ts); return `${d.getDate()} ${MO[d.getMonth()]}`;
}

/* ───────────── campus (Moodle) ───────────── */
function flatten(obj, prefix, params) {
  for (const k of Object.keys(obj)) {
    const v = obj[k], key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, params); else params.append(key, String(v));
  }
}
async function ws(fn, args = {}, token = S.account?.token) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json' });
  flatten(args, '', body);
  let res;
  try { res = await fetch(MOODLE + '/webservice/rest/server.php', { method: 'POST', body, credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch { const e = new Error('Sin conexión con el campus.'); e.code = 'network'; throw e; }
  const data = await res.json().catch(() => null);
  if (!data && !res.ok) { const e = new Error('El campus respondió ' + res.status); e.code = 'http'; throw e; }
  if (data && data.exception) { const e = new Error(data.message || data.errorcode); e.code = data.errorcode; throw e; }
  return data;
}
const TOKEN_ERRORS = ['invalidtoken', 'accessexception', 'invalidlogin'];

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...(S.account?.auth ? { authorization: 'Bearer ' + S.account.auth } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || 'El servidor de Plazo respondió ' + res.status); e.status = res.status; e.code = data.error; throw e; }
  return data;
}

function tidyCourse(full) {
  let s = String(full || '').replace(/\s*\([^()]*\)\s*$/, '').trim() || String(full || '');
  if (s.length > 3 && s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/(\s)(De|Del|La|Las|El|Los|Y|E|En|A|Con|Para|Por)(?=\s)/g, (m, sp, w) => sp + w.toLowerCase());
  }
  return s;
}
function parseToken(input) {
  let s = String(input || '').trim();
  try { s = decodeURIComponent(s); } catch { /* se usa tal cual */ }
  const m = s.match(/token=([A-Za-z0-9+/=_-]+)/);
  if (m) s = m[1];
  if (/^[a-f0-9]{32}$/i.test(s)) return s.toLowerCase();
  try {
    const parts = atob(s.replace(/-/g, '+').replace(/_/g, '/')).split(':::');
    if (parts.length >= 2 && /^[a-f0-9]{32}$/i.test(parts[1])) return parts[1].toLowerCase();
  } catch { /* no es base64 */ }
  return null;
}

async function pool(items, size, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const n = i++; out[n] = await fn(items[n]).catch(() => null); } }));
  return out;
}

async function loadAll() {
  const now = sec(), uid = S.account.userid, prev = S.data;
  const [assign, timeline, forums, notif, calTok] = await Promise.all([
    ws('mod_assign_get_assignments'),
    ws('core_calendar_get_action_events_by_timesort', { timesortfrom: now - 45 * 86400, timesortto: now + 240 * 86400, limitnum: 50 }),
    ws('mod_forum_get_forums_by_courses'),
    ws('message_popup_get_popup_notifications', { useridto: uid, newestfirst: 1, limit: 30, offset: 0 }),
    S.account.calToken ? null : ws('core_calendar_get_calendar_export_token').catch(() => null),
  ]);
  if (calTok?.token) { S.account.calToken = calTok.token; save('account'); }

  const courses = {};
  const ids = (assign.courses || []).map((c) => c.id).sort((a, b) => a - b);
  for (const c of assign.courses || []) courses[c.id] = { name: tidyCourse(c.fullname), color: ids.indexOf(c.id) % 10 };

  const pendingCm = new Set();
  for (const e of timeline.events || []) {
    if (e.modulename !== 'assign') continue;
    const m = /[?&]id=(\d+)/.exec(e.url || '');
    pendingCm.add(m ? +m[1] : e.instance);
  }
  const full = (timeline.events || []).length >= 50;
  const horizon = full ? timeline.events[timeline.events.length - 1].timesort : Infinity;

  const tasks = [];
  for (const c of assign.courses || []) for (const a of c.assignments || []) {
    const due = a.duedate || 0;
    let state = 'done';
    if (pendingCm.has(a.cmid) || (due && due > horizon)) state = 'pending';
    else if (!due) state = 'nodate';
    else if (due < now - 45 * 86400) state = 'old';
    tasks.push({ id: a.id, cmid: a.cmid, course: c.id, name: a.name, due, opens: a.allowsubmissionsfromdate || 0, cutoff: a.cutoffdate || 0, modified: a.timemodified || 0, intro: a.intro || '', state });
  }

  const newsForums = (forums || []).filter((f) => f.type === 'news' && f.numdiscussions > 0);
  const cache = prev?.forumCache || {};
  const forumCache = {};
  const [calendar] = await Promise.all([
    ws('core_calendar_get_calendar_events', { events: { courseids: ids }, options: { userevents: 1, siteevents: 1, timestart: now - 30 * 86400, timeend: now + 240 * 86400, ignorehidden: 1 } }).catch(() => ({ events: [] })),
    pool(newsForums, 4, async (f) => {
      const hit = cache[f.id];
      if (hit && hit.n === f.numdiscussions && hit.at > now - 6 * 3600) { forumCache[f.id] = hit; return; }
      const r = await ws('mod_forum_get_forum_discussions', { forumid: f.id, sortorder: 3, page: 0, perpage: 6 });
      forumCache[f.id] = { n: f.numdiscussions, at: now, items: (r.discussions || []).map((d) => ({ id: d.discussion || d.id, course: f.course, subject: d.subject || d.name, html: d.message || '', author: d.userfullname || '', created: d.created || d.timemodified || now })) };
    }),
  ]);
  for (const f of newsForums) if (!forumCache[f.id] && cache[f.id]) forumCache[f.id] = cache[f.id];
  const notices = Object.values(forumCache).flatMap((c) => c.items).sort((a, b) => b.created - a.created).slice(0, 80);

  const events = [];
  for (const e of calendar.events || []) {
    if (e.modulename === 'assign') continue;
    let kind = 'event';
    e.name = String(e.name || '').replace(/^[\s:]+/, '');
    if (/ex[aá]men|parcial/i.test(e.name)) kind = 'exam';
    else if (/^\s*(teor[ií]a|pr[aá]ctica|seminario|laboratorio|tutor[ií]a)\b/i.test(e.name)) kind = 'class';
    else if (e.modulename === 'quiz') kind = 'quiz';
    events.push({ id: 'm' + e.id, kind, name: e.name, course: e.courseid || 0, start: e.timestart, end: e.timestart + (e.timeduration || 0), place: '' });
    if (e.courseid && !courses[e.courseid]) courses[e.courseid] = { name: '', color: 9 };
  }

  const notifs = (notif.notifications || []).map((n) => {
    let custom = {}; try { custom = JSON.parse(n.customdata || '{}'); } catch { /* sin datos extra */ }
    return { id: n.id, component: n.component, type: custom.messagetype || n.eventtype || '', subject: n.subject || '', text: n.smallmessage || '', url: n.contexturl || '', ts: n.timecreated || now, course: custom.courseid ? +custom.courseid : 0 };
  });

  // Cambios detectados en este dispositivo (sirven aunque no uses el servidor)
  if (prev?.tasks?.length) {
    const before = new Map(prev.tasks.map((t) => [t.id, t]));
    const known = new Set(S.local.changes.map((c) => c.k));
    for (const t of tasks) {
      const b = before.get(t.id);
      const c = !b ? { k: `task_new:${t.id}`, t: 'task_new', ts: now, title: t.name, courseId: t.course, due: t.due, ref: t.id }
        : b.due !== t.due ? { k: `task_due:${t.id}:${t.due}`, t: 'task_due', ts: now, title: t.name, courseId: t.course, from: b.due, due: t.due, ref: t.id } : null;
      if (c && !known.has(c.k)) S.local.changes.unshift(c);
    }
    S.local.changes = S.local.changes.slice(0, 60); save('local');
  }
  S.data = { courses, tasks, events, notices, notifs, forumCache, fetchedAt: now };
  save('data');

  if (S.account.auth) {
    try { S.server = await api('/api/feed'); save('server'); S.expired = S.server.status === 'relogin'; }
    catch (e) { if (e.status === 401) { delete S.account.auth; save('account'); S.push = false; } }
  }
}

async function refresh(manual) {
  if (S.busy || !S.account) return;
  if (DEMO) { if (manual) toast('Datos de demostración'); return; }
  S.busy = true; S.error = null; paintRefresh();
  try { await loadAll(); S.expired = false; if (manual) toast('Actualizado'); }
  catch (e) {
    if (TOKEN_ERRORS.includes(e.code)) S.expired = true;
    else { S.error = e.message; if (manual) toast(e.message); }
  }
  S.busy = false; render();
}

/* ───────────── datos derivados ───────────── */
const course = (id) => S.data?.courses?.[id] || { name: '', color: 9 };
const cc = (id) => 'c' + course(id).color;
function allChanges() {
  const map = new Map();
  for (const c of [...(S.server.changes || []), ...S.local.changes]) if (!map.has(c.k)) map.set(c.k, c);
  return [...map.values()];
}
function allEvents() {
  const detected = (S.server.events || []).map((e) => ({ id: e.id, kind: 'exam', detected: true, source: e.source, name: e.title, course: e.courseId || 0, courseName: e.course, start: e.start, end: e.end || e.start, allDay: e.allDay, place: e.place || '', url: e.url, noticeId: e.noticeId }));
  return [...(S.data?.events || []), ...detected];
}
function dueChange(taskId) { return allChanges().filter((c) => c.t === 'task_due' && c.ref === taskId).sort((a, b) => b.ts - a.ts)[0]; }
function upcoming(days) {
  const now = sec(), end = now + days * 86400;
  const items = [];
  for (const t of S.data.tasks) if (t.due > now && t.due <= end && t.state !== 'old') items.push({ ts: t.due, task: t });
  for (const e of allEvents()) if (e.kind !== 'class' && e.start > now - 3600 && e.start <= end) items.push({ ts: e.start, event: e });
  return items.sort((a, b) => a.ts - b.ts);
}
function feed() {
  const items = [];
  for (const n of S.data.notices) items.push({ k: 'notice:' + n.id, kind: 'aviso', ts: n.created, title: n.subject, sub: course(n.course).name, course: n.course, notice: n.id });
  for (const c of allChanges()) {
    const name = c.courseId ? course(c.courseId).name : c.course || '';
    if (c.t === 'task_new') items.push({ k: c.k, kind: 'plazo', icon: 'plus', ts: c.ts, title: 'Tarea nueva: ' + c.title, sub: [name, c.due ? 'entrega ' + fullDate(c.due) : ''].filter(Boolean).join(' — '), course: c.courseId, task: c.ref });
    else if (c.t === 'task_due') items.push({ k: c.k, kind: 'plazo', icon: 'clock', ts: c.ts, title: 'Plazo cambiado: ' + c.title, sub: `${c.from ? fullDate(c.from) : 'sin fecha'} → ${c.due ? fullDate(c.due) : 'sin fecha'}`, course: c.courseId, task: c.ref, strong: true });
    else if (c.t === 'exam') items.push({ k: c.k, kind: 'aviso', icon: 'cap', ts: c.ts, title: 'Examen detectado: ' + c.title, sub: [name, c.due ? fullDate(c.due, !c.allDay) : ''].filter(Boolean).join(' — '), course: c.courseId, event: c.ref, strong: true });
  }
  for (const n of S.data.notifs) {
    if (n.component === 'mod_forum' || n.type === 'submissionreceipt') continue;
    items.push({ k: 'notif:' + n.id, kind: 'nota', icon: 'star', ts: n.ts, title: n.subject, sub: course(n.course).name || 'Campus', course: n.course, url: n.url });
  }
  return items.sort((a, b) => b.ts - a.ts);
}
const unread = () => (S.data ? feed().filter((i) => i.ts > S.local.seenAt).length : 0);

/* ───────────── HTML del campus → HTML seguro ───────────── */
const KEEP = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'A', 'H4', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'PRE', 'CODE', 'SUP', 'SUB', 'HR']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LINK', 'META', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'TEMPLATE', 'NOSCRIPT']);
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const clean = (node, out) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) { out.appendChild(document.createTextNode(child.nodeValue)); continue; }
      if (child.nodeType !== 1 || DROP.has(child.tagName)) continue;
      let tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) tag = 'H4';
      if (tag === 'IMG') { out.appendChild(document.createTextNode(child.getAttribute('alt') ? `[imagen: ${child.getAttribute('alt')}]` : '[imagen]')); continue; }
      if (tag === 'DIV') tag = 'P';
      if (!KEEP.has(tag)) { clean(child, out); continue; }
      const el = document.createElement(tag);
      if (tag === 'A') {
        const href = child.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) { el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      }
      clean(child, el);
      out.appendChild(el);
    }
  };
  const box = document.createElement('div');
  clean(doc.body, box);
  return box.innerHTML;
}

/* ───────────── piezas de interfaz ───────────── */
function chipFor(t) {
  if (t.state === 'done') return '<span class="chip muted">Entregada</span>';
  if (!t.due) return '<span class="chip muted">Sin fecha</span>';
  const diff = t.due - sec();
  if (t.state === 'old') return '<span class="chip muted">Cerrada</span>';
  if (diff < 0) return `<span class="chip late">${esc(rel(t.due))}</span>`;
  return `<span class="chip ${diff < 48 * 3600 ? 'soon' : ''}">${esc(rel(t.due))}</span>`;
}
function whenBlock(ts) {
  if (!ts) return '<div class="when"><div class="dn">–</div></div>';
  const d = D(ts);
  return `<div class="when"><div class="wd">${WD[d.getDay()]}</div><div class="dn">${d.getDate()}</div><div class="mo">${MO[d.getMonth()]}</div></div>`;
}
function taskRow(t) {
  return `<button class="row ${t.state === 'done' || t.state === 'old' ? 'done' : ''}" data-act="task" data-id="${t.id}">
    ${whenBlock(t.due)}
    <div class="body ${cc(t.course)}"><div class="t">${esc(t.name)}</div><div class="s">${esc(course(t.course).name)}${t.due ? ' · ' + hm(D(t.due)) : ''}</div></div>
    <div class="end">${chipFor(t)}</div></button>`;
}
function eventRow(e) {
  const label = e.kind === 'exam' ? (e.detected ? 'Examen · detectado' : 'Examen') : e.kind === 'quiz' ? 'Cuestionario' : e.kind === 'class' ? 'Clase' : 'Evento';
  const name = e.courseName || course(e.course).name;
  return `<button class="row" data-act="event" data-id="${esc(e.id)}">
    ${whenBlock(e.start)}
    <div class="body ${e.course ? cc(e.course) : ''}"><div class="t">${esc(e.name)}</div><div class="s">${esc([name, e.allDay ? 'todo el día' : hm(D(e.start)) + (e.end > e.start ? '–' + hm(D(e.end)) : '')].filter(Boolean).join(' · '))}</div></div>
    <div class="end"><span class="chip ${e.kind === 'exam' ? 'exam' : 'muted'}">${label}</span></div></button>`;
}
const group = (rows, empty) => `<div class="group">${rows.length ? rows.join('') : `<div class="empty">${empty}</div>`}</div>`;
function header(title, sub) {
  const initials = (S.account?.name || 'Tú').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<header class="top"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    <button class="icon-btn ${S.busy ? 'spin' : ''}" id="refresh" data-act="refresh" aria-label="Actualizar">${I.refresh}</button>
    <button class="me" data-act="settings" aria-label="Ajustes y cuenta">${esc(initials)}</button></header>`;
}
function banners() {
  let h = '';
  if (DEMO) h += `<div class="banner info"><span>Estás viendo una demostración con datos inventados.</span>${FORCED_DEMO ? '' : '<button data-act="exit-demo">Salir</button>'}</div>`;
  if (S.expired) h += `<div class="banner"><span>El acceso al campus ha caducado. Los datos pueden estar desactualizados.</span><button data-act="reconnect">Conectar</button></div>`;
  else if (S.error) h += `<div class="banner"><span>${esc(S.error)}</span><button data-act="refresh">Reintentar</button></div>`;
  return h;
}

/* ───────────── vistas ───────────── */
function viewHoy() {
  const now = sec(), d = new Date();
  const tasks = S.data.tasks;
  const late = tasks.filter((t) => t.state === 'pending' && t.due && t.due < now).sort((a, b) => b.due - a.due);
  const nextUp = upcoming(240).filter((i) => (i.task ? i.task.state === 'pending' : i.event.kind === 'exam'))[0];
  let hero;
  if (nextUp) {
    const diff = nextUp.ts - now, days = dayDiff(nextUp.ts);
    const [num, unit] = diff < 3600 ? [Math.max(1, Math.round(diff / 60)), 'min'] : diff < 36 * 3600 ? [Math.round(diff / 3600), diff < 5400 ? 'hora' : 'horas'] : [days, 'días'];
    const it = nextUp.task || nextUp.event;
    hero = `<button class="next" data-act="${nextUp.task ? 'task' : 'event'}" data-id="${esc(it.id)}">
      <div class="lab">${nextUp.task ? 'Tu próxima entrega, en' : 'Tu próximo examen, en'}</div>
      <div class="count">${num}<small>${unit}</small></div>
      <div class="what">${esc(it.name)}</div>
      <div class="meta">${esc([it.courseName || course(it.course).name, fullDate(nextUp.ts, !it.allDay)].filter(Boolean).join(' — '))}</div></button>`;
  } else {
    hero = `<div class="calm"><b>Nada pendiente</b><span>No tienes entregas ni exámenes a la vista.</span></div>`;
  }

  // Carga de los próximos 14 días
  const byDay = {};
  for (const t of tasks) if (t.due) (byDay[dkey(D(t.due))] ||= []).push(`<i class="${cc(t.course)} ${t.state === 'pending' ? '' : 'done'}"></i>`);
  for (const e of allEvents()) if (e.kind === 'exam') (byDay[dkey(D(e.start))] ||= []).unshift('<i class="exam"></i>');
  let strip = '';
  for (let i = 0; i < 14; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i), k = dkey(day), marks = byDay[k] || [];
    strip += `<button class="${i === 0 ? 'today' : ''} ${day.getDay() % 6 === 0 ? 'wknd' : ''}" data-act="goto-day" data-day="${k}" aria-label="${day.getDate()} de ${MONTHS[day.getMonth()]}: ${marks.length} ${marks.length === 1 ? 'elemento' : 'elementos'}">
      <span class="bar">${marks.slice(0, 3).join('')}${marks.length > 3 ? `<em>+${marks.length - 3}</em>` : ''}</span><span class="wd">${WD[day.getDay()][0].toUpperCase()}</span><span class="dn">${day.getDate()}</span></button>`;
  }

  const week = upcoming(7).filter((i) => !(i.task && i.task === nextUp?.task));
  const news = feed().slice(0, 3);
  const pushHint = !DEMO && !S.push && !S.local.pushAsked
    ? `<div class="banner info"><span>Activa las notificaciones para enterarte de tareas nuevas y cambios de plazo.</span><button data-act="settings">Activar</button></div>` : '';
  return `${header('Hoy', `${WD[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`)}${banners()}${pushHint}${hero}
    ${late.length ? `<div class="section-title"><span>Fuera de plazo (${late.length})</span></div>${group(late.slice(0, 4).map(taskRow))}` : ''}
    <div class="section-title"><span>Próximos 14 días</span><button data-act="tab" data-view="calendario">Ver calendario</button></div>
    <div class="load">${strip}</div>
    <div class="section-title"><span>Esta semana</span><button data-act="tab" data-view="tareas">Todas las tareas</button></div>
    ${group(week.map((i) => (i.task ? taskRow(i.task) : eventRow(i.event))), 'Sin más entregas ni exámenes en los próximos 7 días.')}
    <div class="section-title"><span>Últimas novedades</span><button data-act="tab" data-view="avisos">Ver todas</button></div>
    ${group(news.map(feedRow), 'Todavía no hay avisos de tus asignaturas.')}`;
}

function viewCalendario() {
  const today = new Date();
  if (!S.calMonth) S.calMonth = [today.getFullYear(), today.getMonth()];
  if (!S.calDay) S.calDay = dkey(today);
  const [y, m] = S.calMonth;
  const first = new Date(y, m, 1), offset = (first.getDay() + 6) % 7;
  const byDay = {};
  const add = (ts, mark) => (byDay[dkey(D(ts))] ||= []).push(mark);
  for (const t of S.data.tasks) if (t.due) add(t.due, `<i class="${cc(t.course)} ${t.state === 'pending' ? '' : 'done'}"></i>`);
  for (const e of allEvents()) if (e.kind === 'exam') (byDay[dkey(D(e.start))] ||= []).unshift('<i class="exam"></i>'); else if (e.kind !== 'class') add(e.start, '<i class="c9"></i>');
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const day = new Date(y, m, 1 - offset + i), k = dkey(day);
    if (i >= 35 && day.getMonth() !== m && new Date(y, m, 1 - offset + 35).getMonth() !== m) break;
    const marks = byDay[k] || [];
    cells += `<button class="${day.getMonth() !== m ? 'out' : ''} ${k === dkey(today) ? 'today' : ''}" data-act="pick-day" data-day="${k}" aria-pressed="${k === S.calDay}" aria-label="${day.getDate()} de ${MONTHS[day.getMonth()]}">
      <span class="n">${day.getDate()}</span><span class="marks">${marks.slice(0, 3).join('')}${marks.length > 3 ? `<em>+${marks.length - 3}</em>` : ''}</span></button>`;
  }
  const [sy, sm, sd] = S.calDay.split('-').map(Number), sel = new Date(sy, sm - 1, sd);
  const dayItems = [];
  for (const t of S.data.tasks) if (t.due && dkey(D(t.due)) === S.calDay) dayItems.push({ ts: t.due, html: taskRow(t) });
  for (const e of allEvents()) if (dkey(D(e.start)) === S.calDay && (e.kind !== 'class' || S.settings.classes)) dayItems.push({ ts: e.start, html: eventRow(e) });
  dayItems.sort((a, b) => a.ts - b.ts);
  const diff = dayDiff(sel.getTime() / 1000);
  const selLabel = `${WD[sel.getDay()]} ${sel.getDate()} de ${MONTHS[sel.getMonth()]}${diff === 0 ? ' · hoy' : diff === 1 ? ' · mañana' : ''}`;
  return `${header('Calendario')}${banners()}
    <div class="cal-head"><h2>${MONTHS[m]} ${y !== today.getFullYear() ? y : ''}</h2>
      <div><button class="today-btn" data-act="cal-today">Hoy</button><button class="icon-btn" data-act="cal-move" data-step="-1" aria-label="Mes anterior">${I.prev}</button><button class="icon-btn" data-act="cal-move" data-step="1" aria-label="Mes siguiente">${I.next}</button></div></div>
    <div class="cal"><div class="dow">${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((x) => `<span>${x}</span>`).join('')}</div><div class="days">${cells}</div></div>
    <div class="legend"><span><i></i>Entrega pendiente</span><span><i class="done"></i>Entregada</span><span><i class="exam"></i>Examen</span></div>
    <div class="section-title"><span>${selLabel}</span></div>
    ${group(dayItems.map((i) => i.html), S.settings.classes ? 'Nada este día.' : 'Sin entregas ni exámenes este día.')}
    <div class="section-title"><span>Opciones</span></div>
    <div class="group"><button class="switch-row" role="switch" aria-checked="${S.settings.classes}" data-act="toggle-classes"><span class="lbl">Mostrar clases<small>Teoría y prácticas del calendario del campus</small></span><span class="switch"></span></button></div>`;
}

function viewTareas() {
  const now = sec(), q = S.query.trim().toLowerCase();
  let list = S.data.tasks.filter((t) => (S.filter === 'pendientes' ? t.state === 'pending' : S.filter === 'entregadas' ? t.state === 'done' : true));
  if (q) list = list.filter((t) => (t.name + ' ' + course(t.course).name).toLowerCase().includes(q));
  const buckets = [['Fuera de plazo', []], ['Hoy', []], ['Mañana', []], ['Esta semana', []], ['La semana que viene', []], ['Más adelante', []], ['Sin fecha', []], ['Anteriores', []]];
  const weekEnd = 7 - ((new Date().getDay() + 6) % 7); // días hasta el domingo incluido
  for (const t of list) {
    const dd = t.due ? dayDiff(t.due) : null;
    let b;
    if (!t.due) b = 6;
    else if (t.due < now) b = t.state === 'pending' ? 0 : 7;
    else if (dd === 0) b = 1; else if (dd === 1) b = 2; else if (dd < weekEnd) b = 3; else if (dd < weekEnd + 7) b = 4; else b = 5;
    buckets[b][1].push(t);
  }
  buckets[7][1].sort((a, b) => b.due - a.due);
  for (const [, arr] of buckets.slice(0, 6)) arr.sort((a, b) => a.due - b.due);
  const counts = { pendientes: S.data.tasks.filter((t) => t.state === 'pending').length };
  const body = buckets.filter(([, arr]) => arr.length).map(([name, arr]) => `<div class="section-title"><span>${name} (${arr.length})</span></div>${group(arr.slice(0, name === 'Anteriores' ? 40 : 200).map(taskRow))}`).join('');
  const empty = q ? `Ninguna tarea coincide con «${esc(S.query)}».` : S.filter === 'pendientes' ? 'No tienes entregas pendientes.' : 'No hay tareas en esta lista.';
  return `${header('Tareas', `${counts.pendientes} ${counts.pendientes === 1 ? 'pendiente' : 'pendientes'}`)}${banners()}
    <div class="seg" role="group" aria-label="Filtro">${[['pendientes', 'Pendientes'], ['entregadas', 'Entregadas'], ['todas', 'Todas']].map(([k, l]) => `<button data-act="filter" data-filter="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join('')}</div>
    <input class="search" id="q" type="search" placeholder="Buscar por tarea o asignatura" value="${esc(S.query)}" aria-label="Buscar tareas" autocomplete="off">
    <div id="task-list">${body || `<div class="section-title"></div>${group([], empty)}`}</div>`;
}

function feedRow(i) {
  const fresh = i.ts > S.local.seenAt;
  const act = i.notice ? `data-act="notice" data-id="${i.notice}"` : i.task ? `data-act="task" data-id="${i.task}"` : i.event ? `data-act="event" data-id="${esc(i.event)}"` : i.url ? `data-act="open" data-url="${esc(i.url)}"` : '';
  return `<button class="row" ${act}><div class="glyph">${I[i.icon || 'megaphone']}</div>
    <div class="body ${i.course ? cc(i.course) : ''}"><div class="t">${esc(i.title)}</div><div class="s">${esc(i.sub || '')}</div></div>
    <div class="end">${fresh ? '<span class="dot" aria-label="Nuevo"></span>' : `<span class="tm">${esc(ago(i.ts))}</span>`}</div></button>`;
}
function viewAvisos() {
  const all = feed();
  const list = all.filter((i) => S.feedFilter === 'todo' || i.kind === S.feedFilter);
  const n = all.filter((i) => i.ts > S.local.seenAt).length;
  return `${header('Novedades', n ? `${n} sin leer` : 'Estás al día')}${banners()}
    <div class="seg" role="group" aria-label="Tipo">${[['todo', 'Todo'], ['aviso', 'Avisos'], ['plazo', 'Plazos'], ['nota', 'Notas']].map(([k, l]) => `<button data-act="feed-filter" data-filter="${k}" aria-pressed="${S.feedFilter === k}">${l}</button>`).join('')}</div>
    ${group(list.slice(0, 120).map(feedRow), S.feedFilter === 'plazo' ? 'Aquí aparecerán las tareas nuevas y los cambios de plazo.' : S.feedFilter === 'nota' ? 'Aquí aparecerán las retroalimentaciones y calificaciones.' : 'Todavía no hay novedades.')}`;
}

function viewWelcome() {
  const passport = String(Math.floor(Math.random() * 1e9));
  const url = `${MOODLE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile&confirmed=1`;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `<main class="welcome">
    <img class="mark" src="icons/icon-192.png" alt="" width="60" height="60">
    <h1>Tus plazos del campus, sin sustos</h1>
    <p class="lead">Plazo reúne tus tareas, exámenes y avisos del Campus Virtual UMH y te avisa cuando algo cambia.</p>
    ${ios && !standalone ? `<div class="banner info"><span>Para recibir notificaciones en el iPhone, primero pulsa Compartir y elige «Añadir a pantalla de inicio». Después abre Plazo desde el icono.</span></div>` : ''}
    <ol class="steps">
      <li><h2>Entra en el campus</h2><p>Se abre la página oficial de la UMH. Inicia sesión como siempre, con tu código incluido. Plazo nunca ve tu contraseña.</p>
        <a class="btn" href="${url}" target="_blank" rel="noopener">Abrir el Campus Virtual</a></li>
      <li><h2>Copia el enlace de acceso</h2><p>Al entrar verás el enlace <q>Haga clic aquí si la aplicación no se abre automáticamente</q>. Mantenlo pulsado y elige «Copiar enlace». Si el iPhone pregunta si quieres abrir otra app, pulsa Cancelar.</p></li>
      <li><h2>Pégalo aquí</h2><p>Vuelve a Plazo y pega el enlace copiado.</p>
        <div class="field"><input id="token" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="moodlemobile://token=…" aria-label="Enlace de acceso copiado"><button data-act="paste">Pegar</button></div>
        <p class="error" id="connect-error" role="alert"></p>
        <button class="btn" data-act="connect" id="connect-btn">Conectar</button></li>
    </ol>
    <p class="foot">App no oficial, sin relación con la Universidad Miguel Hernández. El acceso se guarda solo en este dispositivo y puedes revocarlo en el campus, en Preferencias → Claves de seguridad. <button data-act="demo">Ver una demostración</button></p>
  </main>`;
}

/* ───────────── hojas ───────────── */
function openSheet(html) {
  $('#sheet-root').innerHTML = `<div class="sheet-back" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  $('#sheet-root .sheet').focus?.();
}
function closeSheet() { $('#sheet-root').innerHTML = ''; document.body.style.overflow = ''; }
const sheetTop = (title, kicker, colorClass = '') => `<div class="sheet-top"><div><h2>${esc(title)}</h2>${kicker ? `<div class="kicker ${colorClass ? 'dot ' + colorClass : ''}">${esc(kicker)}</div>` : ''}</div><button class="icon-btn" data-act="close-sheet" data-force="1" aria-label="Cerrar">${I.close}</button></div>`;

function sheetTask(id) {
  const t = S.data.tasks.find((x) => x.id === +id);
  if (!t) return toast('Esa tarea ya no está en el campus');
  const ch = dueChange(t.id);
  const status = { pending: t.due && t.due < sec() ? 'Fuera de plazo, sin entregar' : 'Pendiente de entregar', done: 'Entregada', nodate: 'Sin fecha de entrega', old: 'Cerrada' }[t.state];
  openSheet(`${sheetTop(t.name, course(t.course).name, cc(t.course))}
    <dl class="facts">
      <dt>Entrega</dt><dd>${t.due ? `${esc(fullDate(t.due))} (${esc(rel(t.due))})` : 'Sin fecha'}${ch && ch.from ? `<br><s>${esc(fullDate(ch.from))}</s>` : ''}</dd>
      <dt>Estado</dt><dd>${status}</dd>
      ${t.opens && t.opens > sec() ? `<dt>Se abre</dt><dd>${esc(fullDate(t.opens))}</dd>` : ''}
      ${t.cutoff ? `<dt>Límite final</dt><dd>${esc(fullDate(t.cutoff))}</dd>` : ''}
    </dl>
    ${t.intro ? `<div class="rich">${sanitize(t.intro)}</div>` : ''}
    <div class="actions"><a class="btn" href="${MOODLE}/mod/assign/view.php?id=${t.cmid}" target="_blank" rel="noopener">Abrir en el campus</a></div>`);
}
function sheetNotice(id) {
  const n = S.data.notices.find((x) => x.id === +id);
  if (!n) return toast('Ese aviso ya no está disponible');
  const ev = (S.server.events || []).find((e) => e.noticeId === n.id);
  openSheet(`${sheetTop(n.subject, [course(n.course).name, n.author, fullDate(n.created)].filter(Boolean).join(' · '), cc(n.course))}
    ${ev ? `<div class="banner info"><span>Plazo ha detectado un examen en este aviso: ${esc(fullDate(ev.start, !ev.allDay))}. Compruébalo en el texto.</span><button data-act="dismiss-event" data-id="${esc(ev.id)}">Quitar</button></div>` : ''}
    <div class="rich">${sanitize(n.html)}</div>
    <div class="actions"><a class="btn ghost" href="${MOODLE}/mod/forum/discuss.php?d=${n.id}" target="_blank" rel="noopener">Abrir en el campus</a></div>`);
}
function sheetEvent(id) {
  const e = allEvents().find((x) => x.id === id);
  if (!e) return toast('Ese evento ya no está disponible');
  const name = e.courseName || course(e.course).name;
  openSheet(`${sheetTop(e.name, name, e.course ? cc(e.course) : '')}
    <dl class="facts"><dt>Cuándo</dt><dd>${esc(fullDate(e.start, !e.allDay))}${!e.allDay && e.end > e.start ? '–' + hm(D(e.end)) : ''} (${esc(rel(e.start))})</dd>
      ${e.place ? `<dt>Dónde</dt><dd>${esc(e.place)}</dd>` : ''}
      <dt>Origen</dt><dd>${e.detected ? `Detectado en un aviso (${e.source === 'ia' ? 'IA' : 'reglas'})` : 'Calendario del campus'}</dd></dl>
    ${e.detected ? `<p class="note">La fecha se ha extraído automáticamente del texto del aviso y puede estar equivocada. Compruébala antes de fiarte.</p>
      <div class="actions">${e.noticeId && S.data.notices.some((n) => n.id === e.noticeId) ? `<button class="btn" data-act="notice" data-id="${e.noticeId}">Ver el aviso original</button>` : `<a class="btn" href="${esc(e.url)}" target="_blank" rel="noopener">Abrir el aviso en el campus</a>`}
      <button class="btn danger" data-act="dismiss-event" data-id="${esc(e.id)}">No es un examen, quitarlo</button></div>` : ''}`);
}
function sheetSettings() {
  const prefs = S.server.prefs || { task_new: true, task_due: true, notice: true, feedback: true, exam: true };
  const types = [['task_new', 'Tareas nuevas'], ['task_due', 'Cambios de plazo'], ['notice', 'Avisos de profesores'], ['feedback', 'Retroalimentación y notas'], ['exam', 'Exámenes detectados en avisos']];
  const calUrl = S.account.calToken ? `webcal://campus.umh.es/calendar/export_execute.php?userid=${S.account.userid}&authtoken=${S.account.calToken}&preset_what=all&preset_time=recentupcoming` : '';
  const feedUrl = S.account.feedPath ? `webcal://${location.host}${S.account.feedPath}` : '';
  const cadence = S.server.cadenceMinutes;
  openSheet(`${sheetTop('Ajustes', S.account.name || '')}
    <div class="section-title"><span>Notificaciones</span></div>
    <div class="group">
      <button class="switch-row" role="switch" aria-checked="${S.push}" data-act="toggle-push"><span class="lbl">Avisarme en este dispositivo<small>${S.push ? `Activas${cadence ? ` · el campus se revisa cada ${cadence} min aprox.` : ''}` : 'Con la app cerrada también'}</small></span><span class="switch"></span></button>
      ${S.push ? types.map(([k, l]) => `<button class="switch-row" role="switch" aria-checked="${prefs[k] !== false}" data-act="toggle-pref" data-pref="${k}"><span class="lbl">${l}</span><span class="switch"></span></button>`).join('') + `<button class="link-row" data-act="test-push"><span>Enviar una notificación de prueba</span><span>›</span></button>` : ''}
    </div>
    <p class="note">Para avisarte con la app cerrada, el servidor de Plazo guarda tu acceso al campus cifrado y consulta por ti tareas, avisos y notificaciones. Si no las activas, nada sale de este dispositivo.</p>
    <div class="section-title"><span>Calendario del iPhone</span></div>
    <div class="group">
      ${calUrl ? `<a class="link-row" href="${esc(calUrl)}"><span>Suscribirme a entregas y clases del campus</span><span>›</span></a>` : ''}
      ${feedUrl ? `<a class="link-row" href="${esc(feedUrl)}"><span>Suscribirme a los exámenes detectados</span><span>›</span></a>` : ''}
      ${!calUrl && !feedUrl ? '<div class="empty">Disponible cuando termine la primera carga.</div>' : ''}
    </div>
    <div class="section-title"><span>Aspecto</span></div>
    <div class="seg" role="group" aria-label="Tema">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, l]) => `<button data-act="theme" data-theme="${k}" aria-pressed="${S.settings.theme === k}">${l}</button>`).join('')}</div>
    <div class="section-title"><span>Cuenta y datos</span></div>
    <div class="group">
      <a class="link-row" href="${MOODLE}/user/managetoken.php" target="_blank" rel="noopener"><span>Revocar el acceso desde el campus</span><span>›</span></a>
      <button class="link-row red" data-act="disconnect"><span>Desconectar y borrar mis datos</span><span>›</span></button>
    </div>
    <p class="note">Plazo es una app no oficial hecha por estudiantes. No pertenece a la Universidad Miguel Hernández. ${S.data?.fetchedAt ? `Última lectura del campus: hace ${esc(ago(S.data.fetchedAt))}.` : ''}</p>`);
}

/* ───────────── notificaciones push ───────────── */
const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
async function currentSub() { try { const reg = await navigator.serviceWorker?.getRegistration(); return (await reg?.pushManager?.getSubscription()) || null; } catch { return null; } }
async function enablePush() {
  if (DEMO) return toast('La demostración no envía notificaciones');
  S.local.pushAsked = true; save('local');
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return toast(/iphone|ipad/i.test(navigator.userAgent) ? 'Añade Plazo a la pantalla de inicio y ábrela desde el icono' : 'Este navegador no admite notificaciones push');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Permiso denegado. Puedes cambiarlo en los ajustes del sistema');
  try {
    const cfg = await api('/api/config');
    if (!cfg.ready) throw new Error('El servidor de Plazo no está configurado: ' + (cfg.reason || ''));
    if (!S.account.auth) { const r = await api('/api/register', { method: 'POST', body: { token: S.account.token } }); S.account.auth = r.auth; S.account.feedPath = r.feedPath; save('account'); }
    const reg = await navigator.serviceWorker.ready;
    const key = b64uBytes(cfg.vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))) !== btoa(String.fromCharCode(...key))) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    S.push = true;
    try { S.server = await api('/api/feed'); save('server'); } catch { /* se cargará en la próxima actualización */ }
    toast('Notificaciones activadas');
  } catch (e) { toast(e.message || 'No se pudieron activar las notificaciones'); }
  render(); sheetSettings();
}
async function disablePush() {
  const sub = await currentSub();
  try { if (sub) { await api('/api/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); } } catch { /* ya no existía */ }
  S.push = false; render(); sheetSettings(); toast('Notificaciones desactivadas en este dispositivo');
}
async function disconnect() {
  if (FORCED_DEMO) return toast('No disponible en la demostración');
  if (!confirm('Se borrarán tus datos de este dispositivo y del servidor de Plazo. ¿Continuar?')) return;
  if (!DEMO) {
    const sub = await currentSub();
    try { if (sub) await sub.unsubscribe(); } catch { /* nada */ }
    if (S.account?.auth) await api('/api/account', { method: 'DELETE' }).catch(() => {});
  }
  store.clear();
  location.href = location.pathname;
}

async function connect() {
  const input = $('#token'), err = $('#connect-error'), btn = $('#connect-btn');
  const token = parseToken(input.value);
  err.textContent = '';
  if (!token) { err.textContent = 'Eso no parece el enlace de acceso. Debe empezar por moodlemobile://token='; return; }
  btn.disabled = true; btn.textContent = 'Conectando…';
  try {
    const info = await ws('core_webservice_get_site_info', {}, token);
    if (String(info.siteurl || '').replace(/\/+$/, '') !== MOODLE) throw new Error('El enlace no es del Campus Virtual UMH.');
    const keep = S.account && S.account.userid === info.userid ? S.account : {};
    S.account = { ...keep, token, userid: info.userid, name: info.fullname || '' };
    save('account'); S.expired = false; S.view = 'hoy';
    if (S.account.auth) await api('/api/register', { method: 'POST', body: { token } }).catch(() => {});
    render();
    await refresh();
  } catch (e) {
    err.textContent = TOKEN_ERRORS.includes(e.code) ? 'El campus ha rechazado el enlace. Repite el paso 1 y copia uno nuevo.' : e.message;
    btn.disabled = false; btn.textContent = 'Conectar';
  }
}

/* ───────────── pintado y eventos ───────────── */
function applyTheme() { const t = S.settings.theme; if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; }
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2600); }
function paintRefresh() { $('#refresh')?.classList.toggle('spin', S.busy); }
function tabs() {
  const n = unread();
  return `<nav class="tabs" aria-label="Secciones"><div class="tabs-in">${[['hoy', 'Hoy'], ['calendario', 'Calendario'], ['tareas', 'Tareas'], ['avisos', 'Novedades']].map(([k, l]) => `<button class="tab" data-act="tab" data-view="${k}" ${S.view === k ? 'aria-current="page"' : ''}>${I[k]}<span>${l}</span>${k === 'avisos' && n && S.view !== 'avisos' ? `<span class="badge">${n > 9 ? '9+' : n}</span>` : ''}</button>`).join('')}</div></nav>`;
}
function render() {
  const app = $('#app');
  if (!S.account || S.view === 'conectar') { app.innerHTML = viewWelcome(); return; }
  if (!S.data) { app.innerHTML = `<div class="screen">${header('Hoy')}${banners()}<div class="calm"><b>${S.error ? 'No se ha podido leer el campus' : 'Leyendo tu campus…'}</b><span>${S.error ? esc(S.error) : 'La primera carga tarda unos segundos.'}</span></div></div>`; return; }
  const view = { hoy: viewHoy, calendario: viewCalendario, tareas: viewTareas, avisos: viewAvisos }[S.view] || viewHoy;
  app.innerHTML = `<div class="screen">${view()}</div>${tabs()}`;
}
function go(view) {
  if (S.view === 'avisos' && view !== 'avisos') { S.local.seenAt = sec(); save('local'); }
  S.view = view; render(); window.scrollTo(0, 0);
}

const actions = {
  tab: (d) => go(d.view),
  refresh: () => refresh(true),
  settings: () => sheetSettings(),
  task: (d) => sheetTask(d.id),
  notice: (d) => sheetNotice(d.id),
  event: (d) => sheetEvent(d.id),
  open: (d) => { if (/^https:\/\//.test(d.url)) window.open(d.url, '_blank', 'noopener'); },
  'close-sheet': (d, ev, el) => { if (d.force || ev.target === el) closeSheet(); },
  filter: (d) => { S.filter = d.filter; render(); },
  'feed-filter': (d) => { S.feedFilter = d.filter; render(); },
  'goto-day': (d) => { const [y, m] = d.day.split('-').map(Number); S.calMonth = [y, m - 1]; S.calDay = d.day; go('calendario'); },
  'pick-day': (d) => { const [y, m] = d.day.split('-').map(Number); S.calMonth = [y, m - 1]; S.calDay = d.day; const top = window.scrollY; render(); window.scrollTo(0, top); },
  'cal-move': (d) => { const dt = new Date(S.calMonth[0], S.calMonth[1] + +d.step, 1); S.calMonth = [dt.getFullYear(), dt.getMonth()]; render(); },
  'cal-today': () => { const t = new Date(); S.calMonth = [t.getFullYear(), t.getMonth()]; S.calDay = dkey(t); render(); },
  'toggle-classes': () => { S.settings.classes = !S.settings.classes; save('settings'); const top = window.scrollY; render(); window.scrollTo(0, top); },
  theme: (d) => { S.settings.theme = d.theme; save('settings'); applyTheme(); sheetSettings(); },
  'toggle-push': () => (S.push ? disablePush() : enablePush()),
  'toggle-pref': async (d) => {
    const prefs = { ...(S.server.prefs || {}) }; prefs[d.pref] = prefs[d.pref] === false;
    S.server.prefs = prefs; save('server'); sheetSettings();
    try { await api('/api/prefs', { method: 'POST', body: { prefs } }); } catch (e) { toast(e.message); }
  },
  'test-push': async () => { try { await api('/api/test-push', { method: 'POST' }); toast('Enviada. Debería llegar en unos segundos'); } catch (e) { toast(e.message); } },
  'dismiss-event': async (d) => {
    S.server.events = (S.server.events || []).filter((e) => e.id !== d.id); save('server'); closeSheet(); render(); toast('Examen quitado del calendario');
    if (!DEMO) await api('/api/events/dismiss', { method: 'POST', body: { id: d.id } }).catch(() => {});
  },
  disconnect,
  reconnect: () => { S.view = 'conectar'; render(); window.scrollTo(0, 0); },
  connect,
  paste: async () => { try { $('#token').value = await navigator.clipboard.readText(); } catch { toast('Mantén pulsado el campo y elige Pegar'); } },
  demo: () => { location.href = location.pathname + '?demo'; },
  'exit-demo': () => { store.clear(); location.href = location.pathname; },
};
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset, ev, el);
});
document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'q') return;
  S.query = ev.target.value;
  const tmp = document.createElement('div'); tmp.innerHTML = viewTareas();
  $('#task-list').innerHTML = $('#task-list', tmp).innerHTML;
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); if (ev.key === 'Enter' && ev.target.id === 'token') connect(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.account && S.data && sec() - S.data.fetchedAt > 300) refresh(); });

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h || !S.account) return;
  const [k, v] = h.split('=');
  if (k === 'conectar') S.view = 'conectar';
  else if (k === 'calendario' || k === 'novedades') S.view = k === 'novedades' ? 'avisos' : 'calendario';
  render();
  if (S.data && k === 'tarea') sheetTask(v);
  if (S.data && k === 'aviso') { S.view = 'avisos'; render(); sheetNotice(v); }
  history.replaceState(null, '', location.pathname + location.search);
}
window.addEventListener('hashchange', route);

async function start() {
  applyTheme();
  if (DEMO) { const d = demoData(); S.account = d.account; S.data = d.data; S.server = d.server; S.local = d.local; }
  render(); route();
  if ('serviceWorker' in navigator && !DEMO) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open' && e.data.url) { location.hash = e.data.url.split('#')[1] || ''; refresh(); } });
    S.push = !!(await currentSub()) && !!S.account?.auth;
    if (S.account) render();
  }
  if (S.account && !DEMO) refresh();
}
start();

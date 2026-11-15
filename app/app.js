// Plazo 1.1 — app (sin dependencias, sin compilación).
// Lee el Campus Virtual UMH con la API móvil oficial de Moodle, directamente desde el dispositivo.
// El servidor de Plazo aporta la IA (clasifica tareas y lee avisos), los recordatorios y las notificaciones.
import { demoData } from './demo.js';

const VERSION = '1.1.0';
const MOODLE = 'https://campus.umh.es';
const FORCED_DEMO = document.documentElement.hasAttribute('data-demo'); // vista previa sin servidor
const DEMO = FORCED_DEMO || new URLSearchParams(location.search).has('demo');
const NS = DEMO ? 'plazo.demo.' : 'plazo.';
const $ = (sel, root = document) => root.querySelector(sel);
const sec = () => Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch { /* almacenamiento lleno o bloqueado */ } },
  clear() { try { Object.keys(localStorage).filter((k) => k.startsWith(NS)).forEach((k) => localStorage.removeItem(k)); } catch { /* nada */ } },
};

const DEFAULT_REM = { examen: [604800, 86400], entrega: [86400, 10800], actividad: [86400, 3600] };
const S = {
  account: store.get('account', null),
  data: store.get('data', null),
  server: store.get('server', { events: [], changes: [], cls: {} }),
  local: store.get('local', { changes: [], seenAt: 0, pushAsked: false }),
  ustate: store.get('ustate', { rev: 0, manual: [], marks: {} }),
  settings: { theme: 'auto', localOnly: false, show: { entrega: true, examen: true, actividad: true, clase: false }, ...store.get('settings', {}) },
  view: 'hoy', agendaType: 'entrega', filter: 'pendientes', feedFilter: 'todo', query: '',
  calMonth: null, calDay: null, busy: false, expired: false, push: false, error: null, serverTried: false, serverIssue: null,
};
S.settings.show = { entrega: true, examen: true, actividad: true, clase: false, ...(S.settings.show || {}) };
const save = (k) => store.set(k, S[k]);

/* ───────────── tipos ───────────── */
const TYPES = ['entrega', 'examen', 'actividad'];
const T = {
  entrega: { one: 'Entrega', many: 'Entregas', cls: 't-entrega', next: 'Próxima entrega', none: 'Sin entregas pendientes' },
  examen: { one: 'Examen', many: 'Exámenes', cls: 't-examen', next: 'Próximo examen', none: 'Sin exámenes a la vista' },
  actividad: { one: 'Actividad', many: 'Actividades', cls: 't-actividad', next: 'Próxima actividad', none: 'Sin actividades a la vista' },
  clase: { one: 'Clase', many: 'Clases', cls: 't-clase' },
};
// Mismas reglas que worker/index.js: sirven cuando la IA del servidor aún no ha clasificado la tarea.
const RX_INFO = /^\s*(calificaci|notas?\b|resultados?\b|soluci[oó]n|soluciones|revisi[oó]n\b|listado|lista de|actas?\b|gu[ií]a\b|material|plantilla|enunciado|documentaci[oó]n|anexo|r[uú]brica)|\b(calificaciones|notas (del?|de la|finales|provisionales|definitivas))\b/i;
const RX_EXAM = /\b(ex[aá]men(es)?|parcial(es)?|prueba (escrita|objetiva|final|de evaluaci[oó]n|presencial|te[oó]rica|pr[aá]ctica)|control|test (de evaluaci[oó]n|final)|convocatoria (ordinaria|extraordinaria)|recuperaci[oó]n)\b/i;
const ruleType = (name) => (RX_INFO.test(name) ? 'info' : RX_EXAM.test(name) ? 'examen' : 'entrega');

/* ───────────── iconos ───────────── */
const I = {
  hoy: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  calendario: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  agenda: '<svg viewBox="0 0 24 24"><path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M3.5 6.5l1.2 1.2 2-2.4M3.5 12l1.2 1.2 2-2.4M3.5 17.5l1.2 1.2 2-2.4"/></svg>',
  avisos: '<svg viewBox="0 0 24 24"><path d="M6 10a6 6 0 1 1 12 0c0 4.5 2 5.5 2 6.5H4c0-1 2-2 2-6.5z"/><path d="M10 19.5a2 2 0 0 0 4 0"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5v4.2h-4.2"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l8 4.5V5.5L7 10H4z"/><path d="M18.5 9.5a4 4 0 0 1 0 5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3l-4.8 2.6 1-5.4-4-3.8 5.4-.7z"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.3l2.5 2.5 4.9-5.3"/></svg>',
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
function countdown(ts) {
  const diff = ts - sec();
  if (diff < 3600) return [Math.max(1, Math.round(diff / 60)), 'min'];
  if (diff < 36 * 3600) return [Math.round(diff / 3600), diff < 5400 ? 'hora' : 'horas'];
  const d = dayDiff(ts); return [d, d === 1 ? 'día' : 'días'];
}

/* ───────────── campus (Moodle) y servidor ───────────── */
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
  if (DEMO) return {};
  let res;
  try { res = await fetch(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...(S.account?.auth ? { authorization: 'Bearer ' + S.account.auth } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }); }
  catch { const e = new Error('Sin conexión con el servidor de Plazo.'); e.code = 'network'; throw e; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || 'El servidor de Plazo respondió ' + res.status); e.status = res.status; e.code = data.error; throw e; }
  return data;
}

/** Da de alta este usuario en el servidor de Plazo (IA, recordatorios y notificaciones). */
async function ensureServer(force) {
  if (DEMO || S.settings.localOnly || !S.account) return false;
  if (S.account.auth) return true;
  if (S.serverTried && !force) return false;
  S.serverTried = true; S.serverIssue = null;
  try {
    const cfg = await api('/api/config');
    if (!cfg.ready) throw new Error(cfg.reason || 'El servidor no está listo.');
    const r = await api('/api/register', { method: 'POST', body: { token: S.account.token } });
    S.account.auth = r.auth; S.account.feedPath = r.feedPath; save('account');
    return true;
  } catch (e) { S.serverIssue = e.status === 404 ? 'Esta instalación no tiene servidor.' : e.message; return false; }
}

let syncTimer = 0;
function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 1200); }
async function syncNow() {
  if (DEMO || !S.account?.auth || !S.data) return;
  const now = sec();
  const agenda = items().filter((i) => !i.hidden && TYPES.includes(i.type) && i.ts > now && (i.type !== 'entrega' || i.state === 'pending'))
    .sort((a, b) => a.ts - b.ts).slice(0, 250)
    .map((i) => ({ k: i.key, t: i.type, title: i.title, course: courseName(i), ts: i.ts, ...(i.allDay ? { allDay: 1 } : {}), ...(i.task ? { a: i.task.id } : {}), ...(i.course ? { c: i.course } : {}) }));
  try { await api('/api/sync', { method: 'POST', body: { ustate: S.ustate, agenda } }); } catch { /* se reintenta en la próxima actualización */ }
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
async function pool(list, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => { while (i < list.length) { const n = i++; await fn(list[n]).catch(() => null); } }));
}

async function loadAll() {
  const now = sec(), uid = S.account.userid, prev = S.data;
  const [assign, timeline, forums, notif, calTok] = await Promise.all([
    ws('mod_assign_get_assignments'),
    ws('core_calendar_get_action_events_by_timesort', { timesortfrom: now - 45 * 86400, timesortto: now + 240 * 86400, limitnum: 50 }),
    ws('mod_forum_get_forums_by_courses'),
    ws('message_popup_get_popup_notifications', { useridto: uid, newestfirst: 1, limit: 30, offset: 0 }),
    S.account.calToken ? null : ws('core_calendar_get_calendar_export_token').catch(() => null),
    ensureServer(),
  ]);
  if (calTok?.token) { S.account.calToken = calTok.token; save('account'); }

  const courses = {};
  const ids = (assign.courses || []).map((c) => c.id).sort((a, b) => a - b);
  for (const c of assign.courses || []) courses[c.id] = { name: tidyCourse(c.fullname) };

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
    const name = String(e.name || '').replace(/^[\s:]+/, '');
    let kind = 'actividad';
    if (/ex[aá]men|parcial/i.test(name)) kind = 'examen';
    else if (/^\s*(teor[ií]a|pr[aá]ctica|laboratorio|tutor[ií]a|clase)\b/i.test(name)) kind = 'clase';
    else if (e.modulename === 'quiz') kind = 'entrega';
    events.push({ id: 'm' + e.id, kind, name, course: e.courseid || 0, start: e.timestart, end: e.timestart + (e.timeduration || 0) });
    if (e.courseid && !courses[e.courseid]) courses[e.courseid] = { name: '' };
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
  S.data = { v: 2, courses, tasks, events, notices, notifs, forumCache, fetchedAt: now };
  save('data'); dirty();

  if (S.account.auth) {
    try {
      S.server = await api('/api/feed'); save('server');
      S.expired = S.server.status === 'relogin';
      if (S.server.ustate && S.server.ustate.rev > S.ustate.rev) { S.ustate = S.server.ustate; save('ustate'); }
      dirty(); syncSoon();
    } catch (e) { if (e.status === 401) { delete S.account.auth; save('account'); S.push = false; S.serverTried = false; } }
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

/* ───────────── agenda unificada: entregas, exámenes y actividades ───────────── */
let memo = null;
const dirty = () => { memo = null; };
const course = (id) => S.data?.courses?.[id] || { name: '' };
const courseName = (it) => it.courseName || course(it.course).name || '';

/** Une tareas del campus, calendario del campus, lo detectado en avisos y lo añadido a mano. */
function items() {
  if (memo) return memo;
  const now = sec(), marks = S.ustate.marks || {}, cls = S.server.cls || {}, out = [];
  for (const t of S.data?.tasks || []) {
    const key = 'a:' + t.id, mk = marks[key] || {};
    const type = mk.type || cls[t.id] || ruleType(t.name);
    const it = { key, src: 'tarea', type: type === 'info' ? 'entrega' : type, title: t.name, course: t.course, ts: t.due, end: t.due, task: t };
    if (type !== 'entrega' && !mk.type) it.auto = cls[t.id] ? 'ia' : 'reglas';
    if (type === 'info' || mk.hide) { it.hidden = true; it.info = type === 'info'; it.state = 'hidden'; }
    else if (it.type === 'entrega') it.state = mk.done ? 'done' : t.state;
    else it.state = !t.due ? 'nodate' : t.due > now ? 'pending' : 'past';
    it.userDone = !!mk.done && it.state === 'done';
    out.push(it);
  }
  for (const e of S.data?.events || []) {
    const mk = marks[e.id] || {};
    const kind = e.kind === 'exam' ? 'examen' : e.kind === 'class' ? 'clase' : e.kind === 'event' || e.kind === 'quiz' ? 'actividad' : e.kind; // datos guardados por la versión 1
    const type = mk.type && mk.type !== 'info' ? mk.type : kind;
    const it = { key: e.id, src: 'calendario', type, title: e.name, course: e.course, ts: e.start, end: e.end || e.start, state: e.start > now ? 'pending' : 'past' };
    if (mk.hide || mk.type === 'info') { it.hidden = true; it.state = 'hidden'; }
    if (type === 'entrega' && !it.hidden) it.state = mk.done ? 'done' : e.start > now ? 'pending' : 'old';
    out.push(it);
  }
  const taken = new Set(out.filter((i) => !i.hidden).map((i) => `${i.type}|${i.course}|${dkey(D(i.ts))}`));
  for (const e of S.server.events || []) {
    const mk = marks[e.id] || {};
    const type = (mk.type && mk.type !== 'info' ? mk.type : e.type) || 'examen';
    if (taken.has(`${type}|${e.courseId || 0}|${dkey(D(e.start))}`)) continue; // ya está en el campus ese mismo día
    const it = { key: e.id, src: 'aviso', source: e.source, type, title: e.title, course: e.courseId || 0, courseName: e.course, ts: e.start, end: e.end || e.start, allDay: !!e.allDay, place: e.place || '', url: e.url, noticeId: e.noticeId };
    it.state = type === 'entrega' ? (mk.done ? 'done' : 'pending') : e.start > now ? 'pending' : 'past';
    if (mk.hide) { it.hidden = true; it.state = 'hidden'; }
    out.push(it);
  }
  for (const m of S.ustate.manual || []) {
    const key = 'u:' + m.id, mk = marks[key] || {};
    const it = { key, src: 'manual', type: m.type, title: m.title, course: m.course || 0, ts: m.ts, end: m.ts, allDay: !!m.allDay, place: m.place || '', note: m.note || '', manual: m };
    it.state = m.type === 'entrega' ? (mk.done ? 'done' : 'pending') : m.ts > now ? 'pending' : 'past';
    it.userDone = !!mk.done;
    out.push(it);
  }
  memo = out;
  return out;
}
const visible = () => items().filter((i) => !i.hidden);
const byKey = (key) => items().find((i) => i.key === key);
function setMark(key, patch) {
  const m = { ...(S.ustate.marks[key] || {}), ...patch };
  for (const k of Object.keys(m)) if (!m[k]) delete m[k];
  if (Object.keys(m).length) S.ustate.marks[key] = m; else delete S.ustate.marks[key];
  S.ustate.rev = Date.now(); save('ustate'); dirty(); syncSoon();
}
function allChanges() {
  const map = new Map();
  for (const c of [...(S.server.changes || []), ...S.local.changes]) if (!map.has(c.k)) map.set(c.k, c);
  return [...map.values()];
}
function dueChange(taskId) { return allChanges().filter((c) => c.t === 'task_due' && c.ref === taskId).sort((a, b) => b.ts - a.ts)[0]; }
function upcoming(days, types = TYPES) {
  const now = sec(), end = now + days * 86400;
  return visible().filter((i) => types.includes(i.type) && i.ts > now && i.ts <= end && i.state !== 'old').sort((a, b) => a.ts - b.ts);
}
function feed() {
  const list = [], hiddenTasks = new Set(items().filter((i) => i.hidden && i.task).map((i) => i.task.id));
  for (const n of S.data.notices) list.push({ k: 'notice:' + n.id, kind: 'aviso', ts: n.created, title: n.subject, sub: course(n.course).name, notice: n.id });
  for (const c of allChanges()) {
    const name = c.courseId ? course(c.courseId).name : c.course || '';
    const it = c.t === 'detected' || c.t === 'exam' ? byKey(c.ref) : byKey('a:' + c.ref);
    const type = it ? it.type : TYPES.includes(c.kind) ? c.kind : c.t === 'exam' ? 'examen' : 'entrega';
    if ((c.t === 'task_new' || c.t === 'task_due') && hiddenTasks.has(c.ref)) continue;
    if (c.t === 'task_new') list.push({ k: c.k, kind: 'cambio', icon: 'plus', type, ts: c.ts, title: `${type === 'examen' ? 'Nuevo' : 'Nueva'} ${type}: ${c.title}`, sub: [name, c.due ? fullDate(c.due) : ''].filter(Boolean).join(' — '), item: 'a:' + c.ref });
    else if (c.t === 'task_due') list.push({ k: c.k, kind: 'cambio', icon: 'clock', type, ts: c.ts, title: 'Fecha cambiada: ' + c.title, sub: `${c.from ? fullDate(c.from) : 'sin fecha'} → ${c.due ? fullDate(c.due) : 'sin fecha'}`, item: 'a:' + c.ref });
    else if (c.t === 'detected' || c.t === 'exam') list.push({ k: c.k, kind: 'cambio', icon: 'spark', type, ts: c.ts, title: `${T[type].one} en un aviso: ${c.title}`, sub: [name, c.due ? fullDate(c.due, !c.allDay) : ''].filter(Boolean).join(' — '), item: c.ref });
  }
  for (const n of S.data.notifs) {
    if (n.component === 'mod_forum' || n.type === 'submissionreceipt') continue;
    list.push({ k: 'notif:' + n.id, kind: 'nota', icon: 'star', ts: n.ts, title: n.subject, sub: course(n.course).name || 'Campus', url: n.url });
  }
  return list.sort((a, b) => b.ts - a.ts);
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
function chipFor(it) {
  if (it.state === 'hidden') return '<span class="chip muted">Oculta</span>';
  if (it.type === 'entrega') {
    if (it.state === 'done') return `<span class="chip muted">${it.userDone ? 'Hecha' : 'Entregada'}</span>`;
    if (!it.ts) return '<span class="chip muted">Sin fecha</span>';
    if (it.state === 'old') return '<span class="chip muted">Cerrada</span>';
    const diff = it.ts - sec();
    if (diff < 0) return `<span class="chip late">${esc(rel(it.ts))}</span>`;
    return `<span class="chip ${diff < 48 * 3600 ? 'soon' : ''}">${esc(rel(it.ts))}</span>`;
  }
  if (!it.ts) return '<span class="chip muted">Sin fecha</span>';
  if (it.ts < sec()) return '<span class="chip muted">Pasado</span>';
  return `<span class="chip">${esc(rel(it.ts))}</span>`;
}
function whenBlock(ts) {
  if (!ts) return '<div class="when"><div class="dn">–</div></div>';
  const d = D(ts);
  return `<div class="when"><div class="wd">${WD[d.getDay()]}</div><div class="dn">${d.getDate()}</div><div class="mo">${MO[d.getMonth()]}</div></div>`;
}
function row(it, mixed) {
  const faded = ['done', 'old', 'past', 'hidden'].includes(it.state);
  const time = it.ts ? (it.allDay ? 'todo el día' : hm(D(it.ts)) + (it.end > it.ts ? '–' + hm(D(it.end)) : '')) : '';
  const sub = [mixed ? T[it.type].one : '', courseName(it), time].filter(Boolean).join(' · ');
  const check = it.type === 'entrega' && it.state === 'pending';
  return `<div class="row ${T[it.type].cls} ${faded ? 'done' : ''}">
    <button class="row-main" data-act="item" data-key="${esc(it.key)}">${whenBlock(it.ts)}
      <div class="body"><div class="t">${esc(it.title)}</div><div class="s">${esc(sub)}</div></div>
      <div class="end">${chipFor(it)}</div></button>
    ${check ? `<button class="check" data-act="done" data-key="${esc(it.key)}" aria-label="Marcar como hecha: ${esc(it.title)}">${I.check}</button>` : ''}</div>`;
}
const group = (rows, empty) => `<div class="group">${rows.length ? rows.join('') : `<div class="empty">${empty}</div>`}</div>`;
function header(title, sub, extra = '') {
  const initials = (S.account?.name || 'Tú').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<header class="top"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${extra}
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
const mark = (it) => `<i class="mk ${T[it.type].cls} ${it.type === 'entrega' && it.state !== 'pending' ? 'done' : ''}"></i>`;
function marksByDay(types) {
  const map = {};
  const order = { examen: 0, entrega: 1, actividad: 2, clase: 3 };
  for (const it of visible()) if (it.ts && types.includes(it.type)) (map[dkey(D(it.ts))] ||= []).push(it);
  for (const k of Object.keys(map)) map[k] = map[k].sort((a, b) => order[a.type] - order[b.type]).map(mark);
  return map;
}

/* ───────────── vistas ───────────── */
function nextCard(type) {
  const now = sec();
  const it = visible().filter((i) => i.type === type && i.ts > now && (type !== 'entrega' || i.state === 'pending')).sort((a, b) => a.ts - b.ts)[0];
  if (!it) return `<div class="next empty ${T[type].cls}"><div class="lab">${T[type].next}</div><div class="what">${T[type].none}</div></div>`;
  const [num, unit] = countdown(it.ts);
  return `<button class="next ${T[type].cls}" data-act="item" data-key="${esc(it.key)}">
    <div class="lab">${T[type].next}</div><div class="count">${num}<small>${unit}</small></div>
    <div class="what">${esc(it.title)}</div><div class="meta">${esc([courseName(it), fullDate(it.ts, !it.allDay)].filter(Boolean).join(' — '))}</div></button>`;
}
function viewHoy() {
  const now = sec(), d = new Date();
  const late = visible().filter((i) => i.type === 'entrega' && i.state === 'pending' && i.ts && i.ts < now).sort((a, b) => b.ts - a.ts);
  const byDay = marksByDay(TYPES);
  let strip = '';
  for (let i = 0; i < 14; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i), k = dkey(day), marks = byDay[k] || [];
    strip += `<button class="${i === 0 ? 'today' : ''} ${day.getDay() % 6 === 0 ? 'wknd' : ''}" data-act="goto-day" data-day="${k}" aria-label="${day.getDate()} de ${MONTHS[day.getMonth()]}: ${marks.length} ${marks.length === 1 ? 'elemento' : 'elementos'}">
      <span class="bar">${marks.slice(0, 3).join('')}${marks.length > 3 ? `<em>+${marks.length - 3}</em>` : ''}</span><span class="wd">${WD[day.getDay()][0].toUpperCase()}</span><span class="dn">${day.getDate()}</span></button>`;
  }
  const act = upcoming(30, ['actividad'])[0];
  const week = upcoming(7);
  const news = feed().slice(0, 3);
  const pushHint = !DEMO && !S.push && !S.local.pushAsked
    ? `<div class="banner info"><span>Activa las notificaciones para recibir recordatorios y enterarte de los cambios.</span><button data-act="settings">Activar</button></div>` : '';
  return `${header('Hoy', `${WD[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`)}${banners()}${pushHint}
    <div class="duo">${nextCard('entrega')}${nextCard('examen')}</div>
    ${act ? `<div class="section-title"><span>${T.actividad.next}</span></div>${group([row(act)])}` : ''}
    ${late.length ? `<div class="section-title"><span>Fuera de plazo (${late.length})</span><button data-act="agenda" data-type="entrega">Ver todas</button></div>${group(late.slice(0, 4).map((i) => row(i)))}<p class="note">Si ya la hiciste o no vas a entregarla, márcala con el círculo y saldrá de pendientes.</p>` : ''}
    <div class="section-title"><span>Próximos 14 días</span><button data-act="tab" data-view="calendario">Ver calendario</button></div>
    <div class="load">${strip}</div>
    <div class="legend">${TYPES.map((t) => `<span><i class="mk ${T[t].cls}"></i>${T[t].one}</span>`).join('')}</div>
    <div class="section-title"><span>Esta semana</span><button data-act="tab" data-view="agenda">Ver agenda</button></div>
    ${group(week.map((i) => row(i, true)), 'Nada en los próximos 7 días.')}
    <div class="section-title"><span>Últimos avisos</span><button data-act="tab" data-view="avisos">Ver todos</button></div>
    ${group(news.map(feedRow), 'Todavía no hay avisos de tus asignaturas.')}`;
}

function listBody() {
  const now = sec(), q = S.query.trim().toLowerCase(), type = S.agendaType;
  const match = (i) => !q || (i.title + ' ' + courseName(i)).toLowerCase().includes(q);
  const mine = visible().filter((i) => i.type === type && match(i));
  const sections = [];
  if (type === 'entrega') {
    const list = mine.filter((i) => (S.filter === 'pendientes' ? i.state === 'pending' : S.filter === 'hechas' ? i.state === 'done' : true));
    const buckets = [['Fuera de plazo', []], ['Hoy', []], ['Mañana', []], ['Esta semana', []], ['La semana que viene', []], ['Más adelante', []], ['Sin fecha', []], ['Anteriores', []]];
    const weekEnd = 7 - ((new Date().getDay() + 6) % 7);
    for (const i of list) {
      const dd = i.ts ? dayDiff(i.ts) : null;
      let b;
      if (!i.ts) b = 6;
      else if (i.ts < now) b = i.state === 'pending' ? 0 : 7;
      else if (dd === 0) b = 1; else if (dd === 1) b = 2; else if (dd < weekEnd) b = 3; else if (dd < weekEnd + 7) b = 4; else b = 5;
      buckets[b][1].push(i);
    }
    buckets[7][1].sort((a, b) => b.ts - a.ts);
    for (const [, arr] of buckets.slice(0, 6)) arr.sort((a, b) => a.ts - b.ts);
    for (const [name, arr] of buckets) if (arr.length) sections.push([`${name} (${arr.length})`, arr.slice(0, name === 'Anteriores' ? 40 : 200)]);
    if (S.filter === 'todas') {
      const hidden = items().filter((i) => i.hidden && match(i)).sort((a, b) => b.ts - a.ts);
      if (hidden.length) sections.push([`No requieren acción (${hidden.length})`, hidden.slice(0, 60), 'Publicaciones del profesor (calificaciones, soluciones, material) y lo que has ocultado. No cuentan como pendientes.']);
    }
  } else {
    const next = mine.filter((i) => i.ts > now || !i.ts).sort((a, b) => a.ts - b.ts);
    const past = mine.filter((i) => i.ts && i.ts <= now).sort((a, b) => b.ts - a.ts);
    if (next.length) sections.push([`Próximos (${next.length})`, next]);
    if (past.length) sections.push([`Pasados (${past.length})`, past.slice(0, 30)]);
  }
  if (!sections.length) {
    const empty = q ? `Nada coincide con «${esc(S.query)}».` : type === 'entrega' ? (S.filter === 'pendientes' ? 'No tienes entregas pendientes.' : 'No hay entregas en esta lista.') : `${T[type].none}. Puedes añadir ${type === 'examen' ? 'uno' : 'una'} con el botón +.`;
    return `<div class="section-title"></div>${group([], empty)}`;
  }
  return sections.map(([name, arr, note]) => `<div class="section-title"><span>${name}</span></div>${group(arr.map((i) => row(i)))}${note ? `<p class="note">${note}</p>` : ''}`).join('');
}
function viewAgenda() {
  const now = sec();
  const count = (t) => visible().filter((i) => i.type === t && (t === 'entrega' ? i.state === 'pending' : i.ts > now)).length;
  const add = `<button class="icon-btn add" data-act="add" aria-label="Añadir a mano">${I.plus}</button>`;
  return `${header('Agenda', 'Lo que tienes que hacer tú', add)}${banners()}
    <div class="types" role="group" aria-label="Tipo">${TYPES.map((t) => `<button class="${T[t].cls}" data-act="agenda" data-type="${t}" aria-pressed="${S.agendaType === t}"><b>${count(t)}</b><span>${T[t].many}</span></button>`).join('')}</div>
    ${S.agendaType === 'entrega' ? `<div class="seg" role="group" aria-label="Filtro">${[['pendientes', 'Pendientes'], ['hechas', 'Hechas'], ['todas', 'Todas']].map(([k, l]) => `<button data-act="filter" data-filter="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join('')}</div>` : ''}
    <input class="search" id="q" type="search" placeholder="Buscar por título o asignatura" value="${esc(S.query)}" aria-label="Buscar" autocomplete="off">
    <div id="list">${listBody()}</div>`;
}

function viewCalendario() {
  const today = new Date();
  if (!S.calMonth) S.calMonth = [today.getFullYear(), today.getMonth()];
  if (!S.calDay) S.calDay = dkey(today);
  const [y, m] = S.calMonth, show = S.settings.show;
  const on = ['entrega', 'examen', 'actividad', 'clase'].filter((t) => show[t]);
  const first = new Date(y, m, 1), offset = (first.getDay() + 6) % 7;
  const byDay = marksByDay(on.filter((t) => t !== 'clase'));
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const day = new Date(y, m, 1 - offset + i), k = dkey(day);
    if (i >= 35 && new Date(y, m, 1 - offset + 35).getMonth() !== m) break;
    const marks = byDay[k] || [];
    cells += `<button class="${day.getMonth() !== m ? 'out' : ''} ${k === dkey(today) ? 'today' : ''}" data-act="pick-day" data-day="${k}" aria-pressed="${k === S.calDay}" aria-label="${day.getDate()} de ${MONTHS[day.getMonth()]}">
      <span class="n">${day.getDate()}</span><span class="marks">${marks.slice(0, 3).join('')}${marks.length > 3 ? `<em>+${marks.length - 3}</em>` : ''}</span></button>`;
  }
  const [sy, sm, sd] = S.calDay.split('-').map(Number), sel = new Date(sy, sm - 1, sd);
  const dayItems = visible().filter((i) => i.ts && on.includes(i.type) && dkey(D(i.ts)) === S.calDay).sort((a, b) => a.ts - b.ts);
  const diff = dayDiff(sel.getTime() / 1000);
  const selLabel = `${WD[sel.getDay()]} ${sel.getDate()} de ${MONTHS[sel.getMonth()]}${diff === 0 ? ' · hoy' : diff === 1 ? ' · mañana' : ''}`;
  return `${header('Calendario', '', `<button class="icon-btn add" data-act="add" data-day="${S.calDay}" aria-label="Añadir a mano">${I.plus}</button>`)}${banners()}
    <div class="filters" role="group" aria-label="Qué se muestra">${['entrega', 'examen', 'actividad', 'clase'].map((t) => `<button class="${T[t].cls}" data-act="show" data-type="${t}" aria-pressed="${!!show[t]}"><i class="mk ${T[t].cls}"></i>${T[t].many}</button>`).join('')}</div>
    <div class="cal-head"><h2>${MONTHS[m]} ${y !== today.getFullYear() ? y : ''}</h2>
      <div><button class="today-btn" data-act="cal-today">Hoy</button><button class="icon-btn" data-act="cal-move" data-step="-1" aria-label="Mes anterior">${I.prev}</button><button class="icon-btn" data-act="cal-move" data-step="1" aria-label="Mes siguiente">${I.next}</button></div></div>
    <div class="cal"><div class="dow">${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((x) => `<span>${x}</span>`).join('')}</div><div class="days">${cells}</div></div>
    <div class="section-title"><span>${selLabel}</span></div>
    ${group(dayItems.map((i) => row(i, true)), on.length ? 'Nada este día con los filtros elegidos.' : 'Elige arriba qué quieres ver.')}`;
}

function feedRow(i) {
  const fresh = i.ts > S.local.seenAt;
  const act = i.notice ? `data-act="notice" data-id="${i.notice}"` : i.item ? `data-act="item" data-key="${esc(i.item)}"` : i.url ? `data-act="open" data-url="${esc(i.url)}"` : '';
  return `<div class="row ${i.type ? T[i.type].cls : ''}"><button class="row-main" ${act}><div class="glyph">${I[i.icon || 'megaphone']}</div>
    <div class="body"><div class="t">${esc(i.title)}</div><div class="s">${esc(i.sub || '')}</div></div>
    <div class="end">${fresh ? '<span class="dot" aria-label="Nuevo"></span>' : `<span class="tm">${esc(ago(i.ts))}</span>`}</div></button></div>`;
}
function viewAvisos() {
  const all = feed();
  const list = all.filter((i) => S.feedFilter === 'todo' || i.kind === S.feedFilter);
  const n = all.filter((i) => i.ts > S.local.seenAt).length;
  const empty = { cambio: 'Aquí aparecerán las novedades del campus y los cambios de fecha.', nota: 'Aquí aparecerán tus calificaciones y la retroalimentación de los profesores.' }[S.feedFilter] || 'Todavía no hay avisos.';
  return `${header('Avisos', n ? `${n} sin leer` : 'Estás al día')}${banners()}
    <div class="seg" role="group" aria-label="Tipo">${[['todo', 'Todo'], ['aviso', 'Profesores'], ['cambio', 'Cambios'], ['nota', 'Notas']].map(([k, l]) => `<button data-act="feed-filter" data-filter="${k}" aria-pressed="${S.feedFilter === k}">${l}</button>`).join('')}</div>
    ${group(list.slice(0, 120).map(feedRow), empty)}`;
}

function viewWelcome() {
  const passport = String(Math.floor(Math.random() * 1e9));
  const url = `${MOODLE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile&confirmed=1`;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `<main class="welcome">
    <img class="mark" src="icons/icon-192.png" alt="" width="60" height="60">
    <h1>Tus plazos del campus, sin sustos</h1>
    <p class="lead">Plazo reúne tus entregas, exámenes y actividades del Campus Virtual UMH, lee los avisos por ti y te recuerda cada cosa a tiempo.</p>
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
    <p class="foot">App no oficial, sin relación con la Universidad Miguel Hernández. Al conectar, el servidor de Plazo guarda tu acceso cifrado para leer los avisos con IA y enviarte recordatorios; puedes desactivarlo en Ajustes y revocar el acceso en el campus, en Preferencias → Claves de seguridad. <button data-act="demo">Ver una demostración</button></p>
  </main>`;
}

/* ───────────── hojas ───────────── */
function openSheet(html) {
  $('#sheet-root').innerHTML = `<div class="sheet-back" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  document.body.style.overflow = 'hidden';
}
function closeSheet() { $('#sheet-root').innerHTML = ''; document.body.style.overflow = ''; }
const sheetTop = (title, kicker, cls = '') => `<div class="sheet-top"><div><h2>${esc(title)}</h2>${kicker ? `<div class="kicker ${cls ? 'dot ' + cls : ''}">${esc(kicker)}</div>` : ''}</div><button class="icon-btn" data-act="close-sheet" data-force="1" aria-label="Cerrar">${I.close}</button></div>`;

function sheetItem(key) {
  const it = byKey(key);
  if (!it) return toast('Eso ya no está en tu agenda');
  const t = it.task, now = sec();
  const ch = t ? dueChange(t.id) : null;
  const origin = { tarea: 'Tarea del campus', calendario: 'Calendario del campus', aviso: `Leído en un aviso (${it.source === 'ia' ? 'IA' : 'reglas'})`, manual: 'Añadido por ti' }[it.src];
  let status = '';
  if (it.hidden) status = it.info ? 'No requiere acción' : 'Oculta';
  else if (it.type === 'entrega') status = { pending: it.ts && it.ts < now ? 'Fuera de plazo, sin entregar' : 'Pendiente', done: it.userDone ? 'Hecha (marcada por ti)' : 'Entregada', nodate: 'Sin fecha de entrega', old: 'Cerrada' }[it.state] || '';
  const typeNow = it.hidden ? 'info' : it.type;
  const canRetype = it.src !== 'manual';
  const auto = it.auto ? `<p class="note">${it.info ? 'Plazo cree que esto lo publica el profesor y que no tienes que hacer nada' : `Plazo ha clasificado esta tarea del campus como ${it.type}`} (${it.auto === 'ia' ? 'IA' : 'por su nombre'}). Si no es así, cámbialo abajo.</p>` : '';
  const actions = [];
  if (!it.hidden && it.type === 'entrega' && it.state === 'pending') actions.push(`<button class="btn" data-act="done" data-key="${esc(key)}">Marcar como hecha</button>`);
  if (it.userDone) actions.push(`<button class="btn ghost" data-act="undone" data-key="${esc(key)}">Volver a pendientes</button>`);
  if (t) actions.push(`<a class="btn ghost" href="${MOODLE}/mod/assign/view.php?id=${t.cmid}" target="_blank" rel="noopener">Abrir en el campus</a>`);
  if (it.src === 'aviso') actions.push(it.noticeId && S.data.notices.some((n) => n.id === it.noticeId) ? `<button class="btn ghost" data-act="notice" data-id="${it.noticeId}">Ver el aviso original</button>` : it.url ? `<a class="btn ghost" href="${esc(it.url)}" target="_blank" rel="noopener">Abrir el aviso en el campus</a>` : '');
  if (it.src === 'aviso') actions.push(`<button class="btn danger" data-act="dismiss-event" data-id="${esc(key)}">Quitar de mi agenda</button>`);
  if (it.src === 'manual') actions.push(`<button class="btn ghost" data-act="edit" data-key="${esc(key)}">Editar</button>`, `<button class="btn danger" data-act="delete" data-key="${esc(key)}">Eliminar</button>`);
  openSheet(`${sheetTop(it.title, [T[it.type].one, courseName(it)].filter(Boolean).join(' · '), T[it.type].cls)}
    <dl class="facts">
      <dt>${it.type === 'entrega' ? 'Entrega' : 'Cuándo'}</dt><dd>${it.ts ? `${esc(fullDate(it.ts, !it.allDay))}${!it.allDay && it.end > it.ts ? '–' + hm(D(it.end)) : ''} (${esc(rel(it.ts))})` : 'Sin fecha'}${ch && ch.from ? `<br><s>${esc(fullDate(ch.from))}</s>` : ''}</dd>
      ${status ? `<dt>Estado</dt><dd>${status}</dd>` : ''}
      ${it.place ? `<dt>Dónde</dt><dd>${esc(it.place)}</dd>` : ''}
      ${t && t.opens > now ? `<dt>Se abre</dt><dd>${esc(fullDate(t.opens))}</dd>` : ''}
      ${t && t.cutoff ? `<dt>Límite final</dt><dd>${esc(fullDate(t.cutoff))}</dd>` : ''}
      <dt>Origen</dt><dd>${origin}</dd>
    </dl>
    ${it.src === 'aviso' ? '<p class="note">La fecha se ha extraído automáticamente del texto de un aviso y puede estar equivocada. Compruébala en el aviso original.</p>' : ''}${auto}
    ${t && t.intro ? `<div class="rich">${sanitize(t.intro)}</div>` : ''}${it.note ? `<div class="rich"><p>${esc(it.note)}</p></div>` : ''}
    ${canRetype ? `<div class="section-title"><span>Esto es…</span></div>
      <div class="seg four" role="group" aria-label="Tipo">${[['entrega', 'Entrega'], ['examen', 'Examen'], ['actividad', 'Actividad'], ['info', 'Nada que hacer']].map(([k, l]) => `<button data-act="retype" data-key="${esc(key)}" data-type="${k}" aria-pressed="${typeNow === k}">${l}</button>`).join('')}</div>` : ''}
    <div class="actions">${actions.join('')}</div>`);
}
function sheetNotice(id) {
  const n = S.data.notices.find((x) => x.id === +id);
  if (!n) return toast('Ese aviso ya no está disponible');
  const found = visible().filter((i) => i.src === 'aviso' && i.noticeId === n.id);
  openSheet(`${sheetTop(n.subject, [course(n.course).name, n.author, fullDate(n.created)].filter(Boolean).join(' · '))}
    ${found.length ? `<div class="section-title"><span>Añadido a tu agenda desde este aviso</span></div>${group(found.map((i) => row(i, true)))}<p class="note">Comprueba las fechas en el texto. Abre cada elemento para corregirlo o quitarlo.</p>` : ''}
    <div class="rich">${sanitize(n.html)}</div>
    <div class="actions"><button class="btn ghost" data-act="add" data-course="${n.course}">Añadir algo de este aviso a mano</button>
      <a class="btn ghost" href="${MOODLE}/mod/forum/discuss.php?d=${n.id}" target="_blank" rel="noopener">Abrir en el campus</a></div>`);
}
function sheetEdit(key, preset = {}) {
  const it = key ? byKey(key) : null, m = it?.manual;
  const type = m?.type || preset.type || (TYPES.includes(S.agendaType) && S.view === 'agenda' ? S.agendaType : 'entrega');
  const d = m ? D(m.ts) : null;
  const date = d ? dkey(d) : preset.day || '';
  const time = d && !m.allDay ? hm(d) : '';
  const courses = Object.entries(S.data.courses).filter(([, c]) => c.name).sort((a, b) => a[1].name.localeCompare(b[1].name, 'es'));
  const sel = m?.course || +preset.course || 0;
  openSheet(`${sheetTop(m ? 'Editar' : 'Añadir a mano', m ? '' : 'Para lo que no está en el campus o la app no ha detectado')}
    <div class="form" data-key="${esc(key || '')}">
      <div class="seg" role="group" aria-label="Tipo">${TYPES.map((t) => `<button data-act="form-type" data-type="${t}" aria-pressed="${type === t}">${T[t].one}</button>`).join('')}</div>
      <label>Título<input id="f-title" type="text" maxlength="120" value="${esc(m?.title || '')}" placeholder="Por ejemplo: Parcial de los temas 4 a 6" autocomplete="off"></label>
      <label>Asignatura<select id="f-course"><option value="0">Sin asignatura</option>${courses.map(([id, c]) => `<option value="${id}" ${+id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <div class="two"><label>Fecha<input id="f-date" type="date" value="${date}"></label><label>Hora (opcional)<input id="f-time" type="time" value="${time}"></label></div>
      <label>Lugar (opcional)<input id="f-place" type="text" maxlength="80" value="${esc(m?.place || '')}" autocomplete="off"></label>
      <label>Notas (opcional)<textarea id="f-note" rows="3" maxlength="500">${esc(m?.note || '')}</textarea></label>
      <p class="error" id="f-error" role="alert"></p>
      <button class="btn" data-act="save-item">${m ? 'Guardar cambios' : 'Añadir a mi agenda'}</button>
    </div>`);
}
function saveItem() {
  const form = $('.form'), key = form.dataset.key;
  const type = $('.form .seg [aria-pressed="true"]').dataset.type;
  const title = $('#f-title').value.trim(), date = $('#f-date').value, time = $('#f-time').value;
  if (!title) return ($('#f-error').textContent = 'Escribe un título.');
  if (!date) return ($('#f-error').textContent = 'Elige una fecha.');
  const [y, mo, d] = date.split('-').map(Number), [hh, mm] = (time || (type === 'entrega' ? '23:59' : '00:00')).split(':').map(Number);
  const item = { id: key ? key.slice(2) : Math.random().toString(36).slice(2, 10), type, title, course: +$('#f-course').value || 0, ts: Math.floor(new Date(y, mo - 1, d, hh, mm).getTime() / 1000), allDay: !time && type !== 'entrega' ? 1 : 0, place: $('#f-place').value.trim(), note: $('#f-note').value.trim() };
  S.ustate.manual = [...(S.ustate.manual || []).filter((x) => x.id !== item.id), item];
  S.ustate.rev = Date.now(); save('ustate'); dirty(); syncSoon();
  closeSheet(); S.agendaType = type; render(); toast(key ? 'Cambios guardados' : `${T[type].one} ${type === 'examen' ? 'añadido' : 'añadida'}`);
}

const OFFSETS = [[604800, '1 sem'], [259200, '3 días'], [172800, '2 días'], [86400, '1 día'], [43200, '12 h'], [10800, '3 h'], [3600, '1 h']];
const prefsNow = () => ({ notice: S.server.prefs?.notice !== false, feedback: S.server.prefs?.feedback !== false, rem: { ...DEFAULT_REM, ...(S.server.prefs?.rem || {}) } });
function sheetSettings() {
  const prefs = prefsNow(), srv = S.server, linked = !!S.account.auth;
  const calUrl = S.account.calToken ? `webcal://campus.umh.es/calendar/export_execute.php?userid=${S.account.userid}&authtoken=${S.account.calToken}&preset_what=all&preset_time=recentupcoming` : '';
  const feedUrl = S.account.feedPath ? `webcal://${location.host}${S.account.feedPath}` : '';
  const aiText = !linked ? '' : !srv.ai?.on ? 'Sin IA: se usan reglas' : srv.ai.err && srv.ai.err.at > (srv.ai.ok || 0) ? `Con fallos: ${srv.ai.err.msg}` : srv.ai.ok ? `Activa · última lectura hace ${ago(srv.ai.ok)}` : 'Activa · aún sin lecturas';
  const reminders = TYPES.map((t) => `<div class="rem ${T[t].cls}"><div class="rem-h"><i class="mk ${T[t].cls}"></i>${T[t].many}</div>
    <div class="offs" role="group" aria-label="Recordar ${T[t].many}">${OFFSETS.map(([v, l]) => `<button data-act="rem" data-type="${t}" data-off="${v}" aria-pressed="${prefs.rem[t].includes(v)}">${l}</button>`).join('')}</div></div>`).join('');
  openSheet(`${sheetTop('Ajustes', S.account.name || '')}
    <div class="section-title"><span>Notificaciones</span></div>
    <div class="group">
      <button class="switch-row" role="switch" aria-checked="${S.push}" data-act="toggle-push"><span class="lbl">Avisarme en este dispositivo<small>${S.push ? 'Activas, también con la app cerrada' : 'Recordatorios, novedades y avisos'}</small></span><span class="switch"></span></button>
      ${S.push ? `<button class="link-row" data-act="test-push"><span>Enviar una notificación de prueba</span><span>›</span></button>` : ''}
    </div>
    ${linked ? `<div class="section-title"><span>Recordarme antes de…</span></div>
    <div class="group rems">${reminders}</div>
    <p class="note">Elige con cuánta antelación quieres cada recordatorio. Puedes marcar varios o ninguno. Las entregas que ya constan como hechas no se recuerdan.</p>
    <div class="section-title"><span>Avisos</span></div>
    <div class="group">
      <button class="switch-row" role="switch" aria-checked="${prefs.notice}" data-act="toggle-pref" data-pref="notice"><span class="lbl">Avisos de profesores</span><span class="switch"></span></button>
      <button class="switch-row" role="switch" aria-checked="${prefs.feedback}" data-act="toggle-pref" data-pref="feedback"><span class="lbl">Calificaciones y retroalimentación</span><span class="switch"></span></button>
      <div class="switch-row"><span class="lbl">Novedades y cambios de fecha<small>Entregas, exámenes o actividades nuevas, y fechas que cambian</small></span><span class="always">Siempre</span></div>
    </div>` : ''}
    <div class="section-title"><span>Servidor de Plazo</span></div>
    <div class="group">
      ${linked ? `<div class="link-row"><span>Estado</span><span>${srv.status === 'relogin' ? 'Esperando que vuelvas a conectar' : `Revisa el campus cada ${srv.cadenceMinutes || 10} min`}</span></div>
      <div class="link-row"><span>Última revisión</span><span>${srv.lastOk ? 'hace ' + ago(srv.lastOk) : 'pendiente, en unos minutos'}</span></div>
      <div class="link-row"><span>Lectura con IA</span><span>${esc(aiText)}</span></div>
      <button class="link-row red" data-act="local-only"><span>Usar solo este dispositivo</span><span>›</span></button>`
    : `<div class="empty">${S.settings.localOnly ? 'Desactivado: sin IA, recordatorios ni notificaciones.' : esc(S.serverIssue || 'Conectando…')}</div><button class="link-row" data-act="link-server"><span>Conectar con el servidor</span><span>›</span></button>`}
    </div>
    <p class="note">El servidor guarda tu acceso al campus cifrado y consulta por ti tareas, avisos y notificaciones. Lee con IA los avisos y los nombres de las tareas para clasificarlos. «Usar solo este dispositivo» borra tus datos del servidor.</p>
    <div class="section-title"><span>Calendario del iPhone</span></div>
    <div class="group">
      ${calUrl ? `<a class="link-row" href="${esc(calUrl)}"><span>Suscribirme al calendario del campus</span><span>›</span></a>` : ''}
      ${feedUrl ? `<a class="link-row" href="${esc(feedUrl)}"><span>Suscribirme a lo detectado y lo añadido a mano</span><span>›</span></a>` : ''}
      ${!calUrl && !feedUrl ? '<div class="empty">Disponible cuando termine la primera carga.</div>' : ''}
    </div>
    <div class="section-title"><span>Aspecto</span></div>
    <div class="seg" role="group" aria-label="Tema">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, l]) => `<button data-act="theme" data-theme="${k}" aria-pressed="${S.settings.theme === k}">${l}</button>`).join('')}</div>
    <div class="section-title"><span>Cuenta y datos</span></div>
    <div class="group">
      <a class="link-row" href="${MOODLE}/user/managetoken.php" target="_blank" rel="noopener"><span>Revocar el acceso desde el campus</span><span>›</span></a>
      <button class="link-row red" data-act="disconnect"><span>Desconectar y borrar mis datos</span><span>›</span></button>
    </div>
    <p class="note">Plazo ${VERSION}${srv.version && srv.version !== VERSION ? ` (servidor ${esc(srv.version)})` : ''}. App no oficial hecha por estudiantes; no pertenece a la Universidad Miguel Hernández. ${S.data?.fetchedAt ? `Última lectura del campus: hace ${esc(ago(S.data.fetchedAt))}.` : ''}</p>`);
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
    if (S.settings.localOnly) { S.settings.localOnly = false; save('settings'); }
    if (!(await ensureServer(true))) throw new Error('No se pudo conectar con el servidor de Plazo: ' + (S.serverIssue || 'inténtalo más tarde'));
    const cfg = await api('/api/config');
    const reg = await navigator.serviceWorker.ready;
    const key = b64uBytes(cfg.vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))) !== btoa(String.fromCharCode(...key))) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    S.push = true;
    try { S.server = await api('/api/feed'); save('server'); dirty(); } catch { /* se cargará en la próxima actualización */ }
    syncSoon();
    toast('Notificaciones activadas');
  } catch (e) { toast(e.message || 'No se pudieron activar las notificaciones'); }
  render(); sheetSettings();
}
async function disablePush() {
  const sub = await currentSub();
  try { if (sub) { await api('/api/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); } } catch { /* ya no existía */ }
  S.push = false; render(); sheetSettings(); toast('Notificaciones desactivadas en este dispositivo');
}
async function savePrefs(prefs) {
  S.server.prefs = prefs; save('server'); sheetSettings();
  try { await api('/api/prefs', { method: 'POST', body: { prefs } }); } catch (e) { toast(e.message); }
}
async function disconnect() {
  if (FORCED_DEMO) return toast('No disponible en la demostración');
  if (!confirm('Se borrarán tus datos de este dispositivo y del servidor de Plazo, incluido lo que has añadido a mano. ¿Continuar?')) return;
  if (!DEMO) {
    const sub = await currentSub();
    try { if (sub) await sub.unsubscribe(); } catch { /* nada */ }
    if (S.account?.auth) await api('/api/account', { method: 'DELETE' }).catch(() => {});
  }
  store.clear();
  location.href = location.pathname;
}
async function localOnly() {
  if (!confirm('Se borrarán tus datos del servidor de Plazo. Dejarás de tener lectura de avisos con IA, recordatorios y notificaciones. ¿Continuar?')) return;
  const sub = await currentSub();
  try { if (sub) await sub.unsubscribe(); } catch { /* nada */ }
  await api('/api/account', { method: 'DELETE' }).catch(() => {});
  delete S.account.auth; delete S.account.feedPath; save('account');
  S.settings.localOnly = true; save('settings'); S.push = false;
  S.server = { events: [], changes: [], cls: {} }; save('server'); dirty();
  render(); sheetSettings(); toast('Ahora Plazo funciona solo en este dispositivo');
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
    save('account'); S.expired = false; S.view = 'hoy'; S.serverTried = false;
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
  return `<nav class="tabs" aria-label="Secciones"><div class="tabs-in">${[['hoy', 'Hoy'], ['agenda', 'Agenda'], ['calendario', 'Calendario'], ['avisos', 'Avisos']].map(([k, l]) => `<button class="tab" data-act="tab" data-view="${k}" ${S.view === k ? 'aria-current="page"' : ''}>${I[k]}<span>${l}</span>${k === 'avisos' && n && S.view !== 'avisos' ? `<span class="badge">${n > 9 ? '9+' : n}</span>` : ''}</button>`).join('')}</div></nav>`;
}
function render() {
  const app = $('#app');
  if (!S.account || S.view === 'conectar') { app.innerHTML = viewWelcome(); return; }
  if (!S.data) { app.innerHTML = `<div class="screen">${header('Hoy')}${banners()}<div class="calm"><b>${S.error ? 'No se ha podido leer el campus' : 'Leyendo tu campus…'}</b><span>${S.error ? esc(S.error) : 'La primera carga tarda unos segundos.'}</span></div></div>`; return; }
  const view = { hoy: viewHoy, agenda: viewAgenda, calendario: viewCalendario, avisos: viewAvisos }[S.view] || viewHoy;
  app.innerHTML = `<div class="screen">${view()}</div>${tabs()}`;
}
function keepScroll(fn) { const top = window.scrollY; fn(); window.scrollTo(0, top); }
function go(view) {
  if (S.view === 'avisos' && view !== 'avisos') { S.local.seenAt = sec(); save('local'); }
  S.view = view; render(); window.scrollTo(0, 0);
}

const actions = {
  tab: (d) => go(d.view),
  agenda: (d) => { S.agendaType = d.type; if (S.view === 'agenda') keepScroll(render); else go('agenda'); },
  refresh: () => refresh(true),
  settings: () => sheetSettings(),
  item: (d) => sheetItem(d.key),
  notice: (d) => sheetNotice(d.id),
  add: (d) => sheetEdit(null, { day: d.day, course: d.course }),
  edit: (d) => sheetEdit(d.key),
  'form-type': (d, ev, el) => { for (const b of el.parentNode.children) b.setAttribute('aria-pressed', String(b === el)); },
  'save-item': saveItem,
  delete: (d) => {
    if (!confirm('¿Eliminar esto de tu agenda?')) return;
    S.ustate.manual = (S.ustate.manual || []).filter((x) => 'u:' + x.id !== d.key); delete S.ustate.marks[d.key];
    S.ustate.rev = Date.now(); save('ustate'); dirty(); syncSoon(); closeSheet(); render(); toast('Eliminado');
  },
  done: (d) => { setMark(d.key, { done: 1 }); closeSheet(); keepScroll(render); toast('Marcada como hecha'); },
  undone: (d) => { setMark(d.key, { done: 0 }); closeSheet(); keepScroll(render); toast('De nuevo en pendientes'); },
  retype: (d) => {
    const it = byKey(d.key); if (!it) return;
    if (d.type === 'info') setMark(d.key, { hide: 1, type: it.task ? 'info' : 0 });
    else setMark(d.key, { hide: 0, type: d.type });
    keepScroll(render); sheetItem(d.key);
    toast(d.type === 'info' ? 'Ya no cuenta como pendiente' : `Ahora es ${d.type === 'examen' ? 'un examen' : 'una ' + d.type}`);
  },
  open: (d) => { if (/^https:\/\//.test(d.url)) window.open(d.url, '_blank', 'noopener'); },
  'close-sheet': (d, ev, el) => { if (d.force || ev.target === el) closeSheet(); },
  filter: (d) => { S.filter = d.filter; keepScroll(render); },
  'feed-filter': (d) => { S.feedFilter = d.filter; render(); },
  show: (d) => { S.settings.show[d.type] = !S.settings.show[d.type]; save('settings'); keepScroll(render); },
  'goto-day': (d) => { const [y, m] = d.day.split('-').map(Number); S.calMonth = [y, m - 1]; S.calDay = d.day; go('calendario'); },
  'pick-day': (d) => { const [y, m] = d.day.split('-').map(Number); S.calMonth = [y, m - 1]; S.calDay = d.day; keepScroll(render); },
  'cal-move': (d) => { const dt = new Date(S.calMonth[0], S.calMonth[1] + +d.step, 1); S.calMonth = [dt.getFullYear(), dt.getMonth()]; keepScroll(render); },
  'cal-today': () => { const t = new Date(); S.calMonth = [t.getFullYear(), t.getMonth()]; S.calDay = dkey(t); keepScroll(render); },
  theme: (d) => { S.settings.theme = d.theme; save('settings'); applyTheme(); sheetSettings(); },
  'toggle-push': () => (S.push ? disablePush() : enablePush()),
  'toggle-pref': (d) => { const p = prefsNow(); p[d.pref] = !p[d.pref]; savePrefs(p); },
  rem: (d) => { const p = prefsNow(), v = +d.off, cur = p.rem[d.type]; p.rem = { ...p.rem, [d.type]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v].sort((a, b) => b - a) }; savePrefs(p); },
  'test-push': async () => { if (DEMO) return toast('La demostración no envía notificaciones'); try { await api('/api/test-push', { method: 'POST' }); toast('Enviada. Debería llegar en unos segundos'); } catch (e) { toast(e.message); } },
  'dismiss-event': async (d) => {
    S.server.events = (S.server.events || []).filter((e) => e.id !== d.id); save('server'); dirty(); closeSheet(); render(); toast('Quitado de tu agenda');
    if (!DEMO) await api('/api/events/dismiss', { method: 'POST', body: { id: d.id } }).catch(() => {});
  },
  'local-only': localOnly,
  'link-server': async () => { S.settings.localOnly = false; save('settings'); toast('Conectando…'); const ok = await ensureServer(true); if (ok) await refresh(); sheetSettings(); toast(ok ? 'Servidor conectado' : S.serverIssue || 'No se pudo conectar'); },
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
  $('#list').innerHTML = listBody();
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); if (ev.key === 'Enter' && ev.target.id === 'token') connect(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.account && S.data && sec() - S.data.fetchedAt > 300) refresh(); });

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h || !S.account) return;
  const eq = h.indexOf('='), k = eq < 0 ? h : h.slice(0, eq), v = eq < 0 ? '' : h.slice(eq + 1);
  if (k === 'conectar') S.view = 'conectar';
  else if (k === 'calendario') S.view = 'calendario';
  else if (k === 'avisos' || k === 'novedades' || k === 'aviso') S.view = 'avisos';
  render();
  if (S.data && k === 'item') sheetItem(v);
  if (S.data && k === 'tarea') sheetItem('a:' + v);
  if (S.data && k === 'aviso') sheetNotice(v);
  history.replaceState(null, '', location.pathname + location.search);
}
window.addEventListener('hashchange', route);

async function start() {
  applyTheme();
  if (DEMO) { const d = demoData(); S.account = d.account; S.data = d.data; S.server = d.server; S.local = d.local; S.ustate = d.ustate; }
  render(); route();
  if ('serviceWorker' in navigator && !DEMO) {
    const hadWorker = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Cuando llega una versión nueva de la app, se recarga sola una vez
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadWorker && !start.reloaded) { start.reloaded = true; location.reload(); } });
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open' && e.data.url) { location.hash = e.data.url.split('#')[1] || ''; refresh(); } });
    S.push = !!(await currentSub()) && !!S.account?.auth;
    if (S.account) render();
  }
  if (S.account && !DEMO) refresh();
}
start();

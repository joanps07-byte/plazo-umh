// Plazo — vigilante del Campus Virtual UMH (Cloudflare Worker, sin dependencias).
// - Sirve la API de la app (/api/*) y el calendario de exámenes detectados (/cal/*).
// - Cada minuto (cron) revisa el campus de UN usuario, compara con la foto anterior
//   y envía notificaciones push (Web Push, RFC 8291 + VAPID).
// El Worker solo habla con MOODLE_URL y con los servicios push de los navegadores.

const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSION = '1.0.0';
const TZ = 'Europe/Madrid';

/* ───────────────────────── utilidades ───────────────────────── */

export const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '='));
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  },
};

const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status, error, message) => json({ error, message }, status);
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

const fmtWhen = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const when = (ts) => fmtWhen.format(new Date(ts * 1000)).replace(/,/g, '');
const day = (ts) => fmtDay.format(new Date(ts * 1000)).replace(/,/g, '');

/** Hora local de Madrid → epoch (segundos). Resuelve el cambio de hora con Intl. */
export function madridToEpoch(y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = +p.value, a), {});
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.floor((guess - (shown - guess)) / 1000);
}
const madridYMD = (ts) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
  return p; // YYYY-MM-DD
};

/* ───────────────────────── cifrado y sesiones ───────────────────────── */

async function masterKeys(env) {
  if (!env.MASTER_KEY || String(env.MASTER_KEY).length < 24) throw new SetupError('Falta el secreto MASTER_KEY (mínimo 24 caracteres).');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('plazo:' + env.MASTER_KEY));
  return {
    aes: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
    hmac: await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
}
class SetupError extends Error {}

async function seal(env, text) {
  const { aes } = await masterKeys(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(text)));
  return b64u.enc(concat(iv, ct));
}
async function unseal(env, sealed) {
  const { aes } = await masterKeys(env);
  const raw = b64u.dec(sealed);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, aes, raw.slice(12)));
}
async function sign(env, text) {
  const { hmac } = await masterKeys(env);
  return b64u.enc(await crypto.subtle.sign('HMAC', hmac, enc.encode(text)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const randomId = (n = 18) => b64u.enc(crypto.getRandomValues(new Uint8Array(n)));

/* ───────────────────────── base de datos (D1) ───────────────────────── */

const schemaReady = new WeakSet();
async function ensureSchema(env) {
  if (schemaReady.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT, token_enc TEXT NOT NULL, salt TEXT NOT NULL, feed_secret TEXT NOT NULL,
      subs TEXT NOT NULL DEFAULT '[]', prefs TEXT NOT NULL DEFAULT '{}', snapshot TEXT,
      events TEXT NOT NULL DEFAULT '[]', changes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'ok',
      created_at INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0, last_ok INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS users_poll ON users (status, last_poll)`),
  ]);
  schemaReady.add(env.DB);
}
const getConfig = async (env, k) => (await env.DB.prepare('SELECT v FROM config WHERE k = ?').bind(k).first())?.v ?? null;
const setConfig = (env, k, v) => env.DB.prepare('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();

/* ───────────────────────── Moodle ───────────────────────── */

class MoodleError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
const TOKEN_ERRORS = new Set(['invalidtoken', 'accessexception', 'invalidlogin', 'usernotfullysetup', 'forcepasswordchangenotice', 'sitepolicynotagreed']);

function flatten(obj, prefix, params) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, params);
    else if (v !== undefined) params.append(key, String(v));
  }
}
async function moodle(env, token, fn, args = {}) {
  const base = (env.MOODLE_URL || 'https://campus.umh.es').replace(/\/+$/, '');
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json' });
  flatten(args, '', body);
  let res;
  try {
    res = await fetch(base + '/webservice/rest/server.php', { method: 'POST', body, headers: { 'user-agent': 'Plazo/' + VERSION }, signal: AbortSignal.timeout(20000) });
  } catch (e) { throw new MoodleError('network', 'No se pudo contactar con el campus: ' + e.message); }
  if (!res.ok) throw new MoodleError('http' + res.status, 'El campus respondió ' + res.status);
  let data;
  try { data = await res.json(); } catch { throw new MoodleError('badjson', 'Respuesta no válida del campus'); }
  if (data && data.exception) throw new MoodleError(data.errorcode || 'moodle', data.message);
  return data;
}

/* ───────────────────────── Web Push (RFC 8291 / 8188 / 8292) ───────────────────────── */

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** Cifra `payload` (Uint8Array) para una suscripción push. `test` permite fijar sal y clave efímera. */
export async function encryptPush(sub, payload, test) {
  const uaPublic = b64u.dec(sub.keys.p256dh);
  const authSecret = b64u.dec(sub.keys.auth);
  const local = test?.keyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = test?.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

async function vapid(env) {
  let pub = await getConfig(env, 'vapid_pub');
  let privSealed = await getConfig(env, 'vapid_priv');
  if (!pub || !privSealed) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    pub = b64u.enc(await crypto.subtle.exportKey('raw', pair.publicKey));
    privSealed = await seal(env, JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)));
    await setConfig(env, 'vapid_pub', pub);
    await setConfig(env, 'vapid_priv', privSealed);
  }
  return { pub, privSealed };
}
export async function vapidHeader(env, endpoint, keys, subject) {
  const jwk = JSON.parse(await unseal(env, keys.privSealed));
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec() + 12 * 3600, sub: subject })));
  const sig = b64u.enc(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${sig}, k=${keys.pub}`;
}

const PUSH_HOSTS = /(^|\.)(push\.apple\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname) && b64u.dec(s.keys.p256dh).length === 65 && b64u.dec(s.keys.auth).length === 16;
  } catch { return false; }
}

/** Envía una notificación a todas las suscripciones del usuario. Devuelve las que siguen vivas. */
async function pushAll(env, subs, note) {
  if (!subs.length) return subs;
  const keys = await vapid(env);
  const subject = env.VAPID_SUBJECT || (await getConfig(env, 'origin')) || 'https://plazo.invalid';
  const payload = enc.encode(JSON.stringify(note));
  const alive = [];
  for (const sub of subs) {
    try {
      const body = await encryptPush(sub, payload);
      const res = await fetch(sub.endpoint, {
        method: 'POST', body,
        headers: { authorization: await vapidHeader(env, sub.endpoint, keys, subject), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: note.urgent ? 'high' : 'normal' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404 || res.status === 410) continue; // suscripción caducada: se descarta
      if (!res.ok) console.log('push', res.status, await res.text().catch(() => ''));
      alive.push(sub);
    } catch (e) { console.log('push error', e.message); alive.push(sub); }
  }
  return alive;
}

/* ───────────────────────── lectura de avisos: reglas + IA ───────────────────────── */

const EVAL_WORDS = /\b(ex[aá]men(es)?|parcial(es)?|evaluaci[oó]n|prueba|test|control|convocatoria|defensa|recuperaci[oó]n|exposici[oó]n|presentaci[oó]n oral)\b/i;
const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

/** Extrae fecha y hora por reglas. Devuelve null si no hay una fecha futura razonable. */
export function parseDateEs(text, postedTs) {
  const posted = madridYMD(postedTs).split('-').map(Number);
  const candidates = [];
  const pushDate = (d, m, y, idx) => {
    if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return;
    if (!y) { y = posted[0]; if (m < posted[1] || (m === posted[1] && d < posted[2])) y += 1; }
    if (y < 100) y += 2000;
    candidates.push({ y, m, d, idx });
  };
  let r;
  const long = /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|sep?tiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+)?(\d{4}))?/gi;
  while ((r = long.exec(text))) pushDate(+r[1], MONTHS[r[2].toLowerCase()], r[3] ? +r[3] : 0, r.index);
  const short = /\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/g;
  while ((r = short.exec(text))) pushDate(+r[1], +r[2], r[3] ? +r[3] : 0, r.index);
  const postedDay = madridToEpoch(posted[0], posted[1], posted[2]);
  const ok = candidates
    .map((c) => ({ ...c, ts: madridToEpoch(c.y, c.m, c.d) }))
    .filter((c) => c.ts >= postedDay && c.ts <= postedDay + 300 * 86400)
    .sort((a, b) => a.idx - b.idx)[0];
  if (!ok) return null;
  const near = text.slice(ok.idx, ok.idx + 160);
  const t = /(?:a\s+las?|de|desde\s+las?|,|\()\s*(\d{1,2})(?::|\.|h)(\d{2})?\s*(?:h(?:oras)?)?\b/i.exec(near) || /\b(\d{1,2}):(\d{2})\b/.exec(near);
  let hh = null, mm = 0;
  if (t && +t[1] <= 23) { hh = +t[1]; mm = +(t[2] || 0); }
  return { date: `${ok.y}-${String(ok.m).padStart(2, '0')}-${String(ok.d).padStart(2, '0')}`, time: hh === null ? null : `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

const AI_SCHEMA = {
  type: 'object',
  properties: {
    es_evaluacion: { type: 'boolean' },
    titulo: { type: 'string' },
    fecha: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    hora_inicio: { type: ['string', 'null'], description: 'HH:MM en 24 h' },
    hora_fin: { type: ['string', 'null'] },
    lugar: { type: ['string', 'null'] },
  },
  required: ['es_evaluacion', 'titulo', 'fecha', 'hora_inicio', 'hora_fin', 'lugar'],
};

/** Decide si un aviso anuncia un examen o prueba con fecha. Devuelve un evento o null. */
export async function detectExam(env, notice) {
  const text = clip(`${notice.subject}\n${notice.text}`, 6000);
  if (!EVAL_WORDS.test(text)) return null;
  let found = null, source = 'reglas';
  if (env.AI) {
    try {
      const out = await env.AI.run(env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: 'Eres un asistente que lee avisos de profesores universitarios en español. Decide si el aviso convoca o fija la fecha de un examen, parcial, prueba, control, defensa o cualquier acto de evaluación al que el estudiante debe presentarse. Publicar notas o revisar un examen ya hecho NO es una evaluación. Responde solo con JSON. Si hay varias fechas, da la del acto de evaluación más próximo. No inventes fechas: si el aviso no la da, usa null.' },
          { role: 'user', content: `Fecha de publicación del aviso: ${madridYMD(notice.created)}\nAsignatura: ${notice.course}\n\nAviso:\n${text}` },
        ],
        response_format: { type: 'json_schema', json_schema: AI_SCHEMA },
        max_tokens: 300, temperature: 0,
      });
      let r = out?.response ?? out;
      if (typeof r === 'string') r = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
      if (r && typeof r === 'object') {
        if (!r.es_evaluacion) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(r.fecha || '')) {
          found = { date: r.fecha, time: /^\d{1,2}:\d{2}$/.test(r.hora_inicio || '') ? r.hora_inicio.padStart(5, '0') : null, end: /^\d{1,2}:\d{2}$/.test(r.hora_fin || '') ? r.hora_fin.padStart(5, '0') : null, title: clip(r.titulo, 90), place: r.lugar ? clip(r.lugar, 80) : null };
          source = 'ia';
        }
      }
    } catch (e) { console.log('IA no disponible, se usan reglas:', e.message); }
  }
  if (!found) {
    const p = parseDateEs(text, notice.created);
    if (!p) return null;
    found = { ...p, end: null, title: clip(notice.subject, 90), place: null };
  }
  const [y, m, d] = found.date.split('-').map(Number);
  const [hh, mm] = (found.time || '00:00').split(':').map(Number);
  const start = madridToEpoch(y, m, d, hh, mm);
  if (!(start > notice.created - 86400 && start < notice.created + 300 * 86400)) return null;
  let end = null;
  if (found.time && found.end) { const [eh, em] = found.end.split(':').map(Number); end = madridToEpoch(y, m, d, eh, em); if (end <= start) end = null; }
  return { id: 'd' + notice.id, title: found.title || clip(notice.subject, 90), course: notice.course, courseId: notice.courseId, start, end, allDay: !found.time, place: found.place, source, noticeId: notice.id, url: notice.url, detected: nowSec() };
}

/* ───────────────────────── revisión de un usuario ───────────────────────── */

const DEFAULT_PREFS = { task_new: true, task_due: true, notice: true, feedback: true, exam: true };
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };

export async function pollUser(env, user) {
  const now = nowSec();
  const base = (env.MOODLE_URL || 'https://campus.umh.es').replace(/\/+$/, '');
  const prefs = { ...DEFAULT_PREFS, ...parse(user.prefs, {}) };
  let subs = parse(user.subs, []);
  const old = parse(user.snapshot, null);
  let events = parse(user.events, []);
  let changes = parse(user.changes, []);
  let token;
  try { token = await unseal(env, user.token_enc); } catch (e) { if (e instanceof SetupError) throw e; token = null; }

  let assignData, forums, notifData;
  try {
    if (!token) throw new MoodleError('invalidtoken');
    [assignData, forums, notifData] = await Promise.all([
      moodle(env, token, 'mod_assign_get_assignments'),
      moodle(env, token, 'mod_forum_get_forums_by_courses'),
      moodle(env, token, 'message_popup_get_popup_notifications', { useridto: user.id, newestfirst: 1, limit: 15, offset: 0 }),
    ]);
  } catch (e) {
    if (e instanceof MoodleError && TOKEN_ERRORS.has(e.code)) {
      subs = await pushAll(env, subs, { title: 'Vuelve a conectar Plazo', body: 'El acceso al campus ha caducado. Abre la app e inicia sesión de nuevo para seguir recibiendo avisos.', tag: 'relogin', url: '/#conectar', urgent: true });
      await env.DB.prepare("UPDATE users SET status = 'relogin', last_poll = ?, subs = ? WHERE id = ?").bind(now, JSON.stringify(subs), user.id).run();
      return { status: 'relogin' };
    }
    await env.DB.prepare('UPDATE users SET last_poll = ?, fails = fails + 1 WHERE id = ?').bind(now, user.id).run();
    return { status: 'error', error: e.message };
  }

  const fresh = [];
  const snap = { v: 1, courses: {}, assigns: {}, forums: old?.forums ? { ...old.forums } : {}, seen: old?.seen ? old.seen.slice(-400) : [], notifMax: old?.notifMax || 0 };

  // 1. Tareas: nuevas y cambios de plazo
  for (const c of assignData.courses || []) {
    snap.courses[c.id] = clip(c.fullname, 70);
    for (const a of c.assignments || []) {
      snap.assigns[a.id] = [clip(a.name, 120), c.id, a.duedate || 0, a.cmid];
      if (!old) continue;
      const before = old.assigns[a.id];
      const url = `${base}/mod/assign/view.php?id=${a.cmid}`;
      if (!before) {
        fresh.push({ k: `task_new:${a.id}`, t: 'task_new', ts: now, title: a.name, course: snap.courses[c.id], courseId: c.id, due: a.duedate || 0, ref: a.id, url });
      } else if ((before[2] || 0) !== (a.duedate || 0)) {
        fresh.push({ k: `task_due:${a.id}:${a.duedate || 0}`, t: 'task_due', ts: now, title: a.name, course: snap.courses[c.id], courseId: c.id, from: before[2] || 0, due: a.duedate || 0, ref: a.id, url });
      }
    }
  }

  // 2. Avisos: foros de novedades con debates nuevos (máx. 4 foros por revisión)
  const seen = new Set(snap.seen);
  const pending = (forums || []).filter((f) => f.type === 'news' && (snap.forums[f.id] ?? -1) !== (f.numdiscussions || 0));
  let analysed = 0;
  for (const f of pending.slice(0, 4)) {
    if (!f.numdiscussions) { snap.forums[f.id] = 0; continue; }
    let res;
    try { res = await moodle(env, token, 'mod_forum_get_forum_discussions', { forumid: f.id, sortorder: 3, page: 0, perpage: 5 }); } catch { continue; }
    for (const d of res.discussions || []) {
      const did = d.discussion || d.id;
      if (seen.has(did)) continue;
      seen.add(did); snap.seen.push(did);
      const course = snap.courses[f.course] || '';
      const notice = { id: did, subject: clip(d.subject || d.name, 140), text: htmlToText(d.message), created: d.created || now, course, courseId: f.course, url: `${base}/mod/forum/discuss.php?d=${did}` };
      const silent = notice.created < user.created_at; // anterior al alta: no se notifica
      if (!silent) fresh.push({ k: `notice:${did}`, t: 'notice', ts: notice.created, title: notice.subject, body: clip(notice.text, 220), course, courseId: f.course, ref: did, url: notice.url });
      if ((!silent || notice.created > now - 30 * 86400) && analysed < 2 && !events.some((e) => e.noticeId === did)) {
        analysed++;
        const ev = await detectExam(env, notice);
        if (ev && ev.start > now - 86400) {
          events.push(ev);
          fresh.push({ k: `exam:${did}`, t: 'exam', ts: now, title: ev.title, course, courseId: f.course, due: ev.start, allDay: ev.allDay, ref: ev.id, url: notice.url, silent });
        }
      }
    }
    snap.forums[f.id] = f.numdiscussions || 0;
  }

  // 3. Notificaciones del campus: retroalimentación, notas y demás
  const notifs = notifData.notifications || [];
  for (const n of notifs) {
    if (n.id <= snap.notifMax) continue;
    if (!old) continue;
    let custom = {};
    try { custom = JSON.parse(n.customdata || '{}'); } catch {}
    if (n.component === 'mod_forum') continue; // ya cubierto por los avisos
    if (custom.messagetype === 'submissionreceipt') continue; // confirmación de tu propia entrega
    const isGrade = /grade/i.test(n.eventtype || '') || custom.messagetype === 'feedbackavailable';
    fresh.push({ k: `notif:${n.id}`, t: 'feedback', kind: isGrade ? 'grade' : 'other', ts: n.timecreated || now, title: clip(htmlToText(n.subject), 160), body: clip(htmlToText(n.smallmessage || ''), 200), courseId: custom.courseid ? +custom.courseid : null, course: custom.courseid ? snap.courses[custom.courseid] || '' : '', ref: n.id, url: n.contexturl || base });
  }
  for (const n of notifs) if (n.id > snap.notifMax) snap.notifMax = n.id;

  // 4. Guardar y notificar
  const known = new Set(changes.map((c) => c.k));
  const added = fresh.filter((c) => !known.has(c.k));
  changes = added.concat(changes).sort((a, b) => b.ts - a.ts).slice(0, 80);
  events = events.filter((e) => e.start > now - 30 * 86400).slice(-60);

  const toPush = added.filter((c) => !c.silent && prefs[c.t]);
  if (toPush.length && subs.length) {
    const notes = toPush.length > 3
      ? [{ title: `${toPush.length} novedades en el campus`, body: clip(toPush.map((c) => c.title).join(' · '), 180), tag: 'resumen', url: '/#novedades' }]
      : toPush.map(noteFor);
    for (const note of notes) subs = await pushAll(env, subs, note);
  }
  await env.DB.prepare("UPDATE users SET snapshot = ?, events = ?, changes = ?, subs = ?, last_poll = ?, last_ok = ?, fails = 0, status = 'ok' WHERE id = ?")
    .bind(JSON.stringify(snap), JSON.stringify(events), JSON.stringify(changes), JSON.stringify(subs), now, now, user.id).run();
  return { status: 'ok', added: added.length, pushed: toPush.length };
}

export function noteFor(c) {
  const course = c.course ? ` · ${clip(c.course, 38)}` : '';
  switch (c.t) {
    case 'task_new': return { title: 'Nueva tarea' + course, body: c.due ? `${c.title} — entrega ${when(c.due)}` : c.title, tag: c.k, url: '/#tarea=' + c.ref };
    case 'task_due': return { title: 'Plazo cambiado' + course, body: `${c.title}: ${c.from ? when(c.from) : 'sin fecha'} → ${c.due ? when(c.due) : 'sin fecha'}`, tag: c.k, url: '/#tarea=' + c.ref, urgent: true };
    case 'notice': return { title: 'Aviso' + course, body: c.title, tag: c.k, url: '/#aviso=' + c.ref };
    case 'exam': return { title: 'Examen detectado' + course, body: `${c.title} — ${c.allDay ? day(c.due) : when(c.due)}. Añadido a tu calendario.`, tag: c.k, url: '/#calendario', urgent: true };
    default: return { title: (c.kind === 'grade' ? 'Retroalimentación o nota' : 'Notificación del campus') + course, body: c.title, tag: c.k, url: '/#novedades' };
  }
}

/* ───────────────────────── calendario .ics ───────────────────────── */

const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsFold = (line) => { const out = []; let l = line; while (enc.encode(l).length > 73) { let n = 60; out.push(l.slice(0, n)); l = ' ' + l.slice(n); } out.push(l); return out.join('\r\n'); };
const icsStamp = (ts) => new Date(ts * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export function buildIcs(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Plazo//Campus UMH//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Plazo · exámenes detectados', 'X-WR-TIMEZONE:Europe/Madrid', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@plazo`, `DTSTAMP:${icsStamp(e.detected || nowSec())}`);
    if (e.allDay) {
      const d = madridYMD(e.start).replace(/-/g, '');
      const next = madridYMD(e.start + 26 * 3600).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`);
    } else {
      lines.push(`DTSTART:${icsStamp(e.start)}`, `DTEND:${icsStamp(e.end || e.start + 7200)}`);
    }
    lines.push(icsFold(`SUMMARY:${icsEsc(`${e.title}${e.course ? ' · ' + e.course : ''}`)}`));
    lines.push(icsFold(`DESCRIPTION:${icsEsc(`Detectado por Plazo en un aviso del campus (${e.source === 'ia' ? 'IA' : 'reglas'}). Comprueba la fecha en el aviso original: ${e.url}`)}`));
    if (e.place) lines.push(icsFold(`LOCATION:${icsEsc(e.place)}`));
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Examen', 'TRIGGER:-P1D', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/* ───────────────────────── API HTTP ───────────────────────── */

async function auth(env, request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer (\d+)\.([\w-]+)$/.exec(h);
  if (!m) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(+m[1]).first();
  if (!user) return null;
  return safeEqual(await sign(env, `s:${user.id}:${user.salt}`), m[2]) ? user : null;
}
const readJson = async (request) => { try { const t = await request.text(); return t.length > 20000 ? null : JSON.parse(t); } catch { return null; } };

async function api(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/config' && method === 'GET') {
    let ready = true, reason = null, pub = null;
    try { await masterKeys(env); pub = (await vapid(env)).pub; } catch (e) { ready = false; reason = e.message; }
    if (ready && !(await getConfig(env, 'origin'))) await setConfig(env, 'origin', url.origin);
    return json({ ready, reason, vapidPublicKey: pub, version: VERSION, ai: !!env.AI, pollMinutes: +(env.POLL_MINUTES || 10) });
  }

  if (path === '/api/register' && method === 'POST') {
    const body = await readJson(request);
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    if (!/^[a-f0-9]{32}$/i.test(token)) return fail(400, 'badtoken', 'El token no tiene el formato esperado.');
    let info;
    try { info = await moodle(env, token, 'core_webservice_get_site_info'); }
    catch (e) { return fail(e instanceof MoodleError && TOKEN_ERRORS.has(e.code) ? 401 : 502, e.code || 'moodle', e.message); }
    const base = (env.MOODLE_URL || 'https://campus.umh.es').replace(/\/+$/, '');
    if (!info.userid || String(info.siteurl || '').replace(/\/+$/, '') !== base) return fail(400, 'wrongsite', 'El token no pertenece al Campus Virtual de la UMH.');
    let user = await env.DB.prepare('SELECT id, salt, feed_secret FROM users WHERE id = ?').bind(info.userid).first();
    const tokenEnc = await seal(env, token);
    const now = nowSec();
    if (user) {
      await env.DB.prepare("UPDATE users SET token_enc = ?, name = ?, status = 'ok', fails = 0, last_poll = 0 WHERE id = ?").bind(tokenEnc, clip(info.fullname, 80), user.id).run();
    } else {
      const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
      if (count >= +(env.MAX_USERS || 150)) return fail(503, 'full', 'Este servidor ha alcanzado su límite de usuarios.');
      user = { id: info.userid, salt: randomId(), feed_secret: randomId(24) };
      await env.DB.prepare('INSERT INTO users (id, name, token_enc, salt, feed_secret, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(user.id, clip(info.fullname, 80), tokenEnc, user.salt, user.feed_secret, now).run();
    }
    return json({ auth: `${user.id}.${await sign(env, `s:${user.id}:${user.salt}`)}`, feedPath: `/cal/${user.id}-${user.feed_secret}.ics`, vapidPublicKey: (await vapid(env)).pub });
  }

  const user = await auth(env, request);
  if (!user) return fail(401, 'unauthorized', 'Sesión no válida. Vuelve a conectar la app.');

  if (path === '/api/feed' && method === 'GET') {
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'ok'").first()).n;
    return json({ status: user.status, events: parse(user.events, []), changes: parse(user.changes, []), prefs: { ...DEFAULT_PREFS, ...parse(user.prefs, {}) }, devices: parse(user.subs, []).length, lastOk: user.last_ok, cadenceMinutes: Math.max(+(env.POLL_MINUTES || 10), total), feedPath: `/cal/${user.id}-${user.feed_secret}.ics` });
  }
  if (path === '/api/subscribe' && method === 'POST') {
    const body = await readJson(request);
    const s = body?.subscription;
    if (!s || !validSubscription(s)) return fail(400, 'badsubscription', 'Suscripción push no válida.');
    const subs = parse(user.subs, []).filter((x) => x.endpoint !== s.endpoint).slice(-4);
    subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    await env.DB.prepare('UPDATE users SET subs = ? WHERE id = ?').bind(JSON.stringify(subs), user.id).run();
    return json({ ok: true, devices: subs.length });
  }
  if (path === '/api/unsubscribe' && method === 'POST') {
    const body = await readJson(request);
    const subs = parse(user.subs, []).filter((x) => x.endpoint !== body?.endpoint);
    await env.DB.prepare('UPDATE users SET subs = ? WHERE id = ?').bind(JSON.stringify(subs), user.id).run();
    return json({ ok: true, devices: subs.length });
  }
  if (path === '/api/prefs' && method === 'POST') {
    const body = await readJson(request);
    const prefs = {};
    for (const k of Object.keys(DEFAULT_PREFS)) prefs[k] = body?.prefs?.[k] !== false;
    await env.DB.prepare('UPDATE users SET prefs = ? WHERE id = ?').bind(JSON.stringify(prefs), user.id).run();
    return json({ ok: true, prefs });
  }
  if (path === '/api/events/dismiss' && method === 'POST') {
    const body = await readJson(request);
    const events = parse(user.events, []).filter((e) => e.id !== body?.id);
    await env.DB.prepare('UPDATE users SET events = ? WHERE id = ?').bind(JSON.stringify(events), user.id).run();
    return json({ ok: true });
  }
  if (path === '/api/test-push' && method === 'POST') {
    const before = parse(user.subs, []);
    if (!before.length) return fail(409, 'nodevices', 'Este usuario no tiene ningún dispositivo con notificaciones activadas.');
    const subs = await pushAll(env, before, { title: 'Plazo funciona', body: 'Así te llegarán las tareas nuevas, los cambios de plazo y los avisos.', tag: 'prueba', url: '/' });
    if (subs.length !== before.length) await env.DB.prepare('UPDATE users SET subs = ? WHERE id = ?').bind(JSON.stringify(subs), user.id).run();
    return json({ ok: true, devices: subs.length });
  }
  if (path === '/api/account' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
    return json({ ok: true });
  }
  return fail(404, 'notfound', 'Ruta no encontrada.');
}

async function calendar(env, url) {
  const m = /^\/cal\/(\d+)-([\w-]+)\.ics$/.exec(url.pathname);
  if (!m) return new Response('No encontrado', { status: 404 });
  const user = await env.DB.prepare('SELECT feed_secret, events FROM users WHERE id = ?').bind(+m[1]).first();
  if (!user || !safeEqual(user.feed_secret, m[2])) return new Response('No encontrado', { status: 404 });
  return new Response(buildIcs(parse(user.events, [])), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=900' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cal/')) {
        if (!env.DB) return fail(503, 'setup', 'Falta la base de datos D1 (binding DB).');
        await ensureSchema(env);
        return url.pathname.startsWith('/api/') ? await api(request, env, url) : await calendar(env, url);
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Plazo', { status: 200 });
    } catch (e) {
      if (e instanceof SetupError) return fail(503, 'setup', e.message);
      console.log('error', e.stack || e.message);
      return fail(500, 'server', 'Error interno.');
    }
  },

  // Cada minuto: revisa al usuario que lleva más tiempo sin revisar.
  // Uno por ejecución para no pasar del límite de CPU del plan gratuito.
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    await ensureSchema(env);
    const cutoff = nowSec() - 60 * +(env.POLL_MINUTES || 10) + 20;
    const user = await env.DB.prepare("SELECT * FROM users WHERE status = 'ok' AND last_poll < ? ORDER BY last_poll ASC LIMIT 1").bind(cutoff).first();
    if (!user) return;
    try { console.log('revisión', user.id, JSON.stringify(await pollUser(env, user))); }
    catch (e) { console.log('revisión fallida', user.id, e.message); await env.DB.prepare('UPDATE users SET last_poll = ?, fails = fails + 1 WHERE id = ?').bind(nowSec(), user.id).run().catch(() => {}); }
  },
};

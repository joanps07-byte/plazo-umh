// Plazo — vigilante del Campus Virtual UMH (Cloudflare Worker, sin dependencias).
// - Sirve la API de la app (/api/*) y el calendario de exámenes detectados (/cal/*).
// - Cada minuto (cron) revisa el campus de UN usuario, compara con la foto anterior
//   y envía notificaciones push (Web Push, RFC 8291 + VAPID).
// El Worker solo habla con MOODLE_URL y con los servicios push de los navegadores.

const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSION = '1.2.0';
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

class SetupError extends Error {}
const randomId = (n = 18) => b64u.enc(crypto.getRandomValues(new Uint8Array(n)));
const autoKeys = new WeakMap(); // env.DB → clave automática ya leída
const derived = new Map();      // secreto → claves importadas

/** Secreto de cifrado: MASTER_KEY si está definido; si no, una clave aleatoria guardada en la base de datos. */
async function masterSecret(env) {
  if (env.MASTER_KEY && String(env.MASTER_KEY).length >= 16) return { secret: String(env.MASTER_KEY), source: 'secreto' };
  if (!env.DB) throw new SetupError('Falta la base de datos D1 (binding DB).');
  let secret = autoKeys.get(env.DB);
  if (!secret) {
    secret = await getConfig(env, 'auto_key');
    if (!secret) {
      await env.DB.prepare('INSERT OR IGNORE INTO config (k, v) VALUES (?, ?)').bind('auto_key', randomId(32)).run();
      secret = await getConfig(env, 'auto_key');
    }
    autoKeys.set(env.DB, secret);
  }
  return { secret, source: 'auto' };
}
async function masterKeys(env) {
  const { secret } = await masterSecret(env);
  if (!derived.has(secret)) {
    derived.set(secret, (async () => {
      const raw = await crypto.subtle.digest('SHA-256', enc.encode('plazo:' + secret));
      return {
        aes: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
        hmac: await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      };
    })());
  }
  return derived.get(secret);
}

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

/* ───────────────────────── base de datos (D1) ───────────────────────── */

const SCHEMA = '2';
const schemaReady = new WeakSet();
async function ensureSchema(env) {
  if (schemaReady.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT, token_enc TEXT NOT NULL, salt TEXT NOT NULL, feed_secret TEXT NOT NULL,
      subs TEXT NOT NULL DEFAULT '[]', prefs TEXT NOT NULL DEFAULT '{}', snapshot TEXT,
      events TEXT NOT NULL DEFAULT '[]', changes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'ok',
      created_at INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0, last_ok INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0,
      agenda TEXT NOT NULL DEFAULT '[]', sent TEXT NOT NULL DEFAULT '{}', ustate TEXT NOT NULL DEFAULT '{}')`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS users_poll ON users (status, last_poll)`),
  ]);
  // Actualización desde la versión 1: columnas nuevas (si ya existen, el error se ignora).
  if ((await getConfig(env, 'schema')) !== SCHEMA) {
    for (const col of ["agenda TEXT NOT NULL DEFAULT '[]'", "sent TEXT NOT NULL DEFAULT '{}'", "ustate TEXT NOT NULL DEFAULT '{}'"]) {
      try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch { /* la columna ya existe */ }
    }
    await setConfig(env, 'schema', SCHEMA);
  }
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
  if (pub && privSealed) { try { await unseal(env, privSealed); } catch { pub = null; } } // cambió la clave de cifrado: se generan claves nuevas
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


/* ───────────────────────── clasificación y lectura de avisos: reglas + IA ───────────────────────── */

export const TYPES = ['entrega', 'examen', 'actividad'];
const TYPE_LABEL = { entrega: 'Entrega', examen: 'Examen', actividad: 'Actividad' };
const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

// Estas reglas están repetidas en app/app.js (la app las usa cuando no hay servidor).
const RX_INFO = /^\s*(calificaci|notas?\b|resultados?\b|soluci[oó]n|soluciones|revisi[oó]n\b|listado|lista de|actas?\b|gu[ií]a\b|material|plantilla|enunciado|documentaci[oó]n|anexo|r[uú]brica)|\b(calificaciones|notas (del?|de la|finales|provisionales|definitivas))\b/i;
const RX_EXAM = /\b(ex[aá]men(es)?|parcial(es)?|prueba (escrita|objetiva|final|de evaluaci[oó]n|presencial|te[oó]rica|pr[aá]ctica)|control|test (de evaluaci[oó]n|final)|convocatoria (ordinaria|extraordinaria)|recuperaci[oó]n)\b/i;
const RX_TASK = /\b(entrega|entregable|entregar|tarea|ejercicios?|pr[aá]ctica|laboratorio|trabajo|memoria|informe|actividad|proyecto|cuestionario|subir|subida)\b/i;
const RX_ACT = /\b(seminario|charla|conferencia|taller|visita|jornadas?|ponencia|mesa redonda|tutor[ií]a|reuni[oó]n|sesi[oó]n|exposici[oó]n|presentaci[oó]n|defensa|revisi[oó]n)\b/i;

/** Tipo de una tarea del campus por su nombre. `sure` indica si la regla basta o conviene preguntar a la IA. */
export function ruleType(name) {
  const s = String(name || '');
  if (RX_INFO.test(s)) return { type: 'info', sure: !RX_TASK.test(s) };
  if (RX_EXAM.test(s)) return { type: 'examen', sure: false };
  if (RX_TASK.test(s)) return { type: 'entrega', sure: true };
  return { type: 'entrega', sure: false };
}

/* Proveedores de IA, por orden: Groq (si hay GROQ_API_KEY) → Cloudflare Workers AI → reglas.
   Si uno agota su cupo, se pausa un rato y se pasa al siguiente. */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const list = (v, d) => String(v || d).split(',').map((x) => x.trim()).filter(Boolean);
export function aiProviders(env) {
  const out = [];
  if (env.GROQ_API_KEY) for (const m of list(env.GROQ_MODELS, 'openai/gpt-oss-120b,llama-3.3-70b-versatile,openai/gpt-oss-20b')) out.push({ kind: 'groq', model: m, id: 'groq:' + m });
  if (env.AI) for (const m of list(env.CF_AI_MODELS || env.AI_MODEL, '@cf/openai/gpt-oss-120b,@cf/meta/llama-3.3-70b-instruct-fp8-fast')) out.push({ kind: 'cf', model: m, id: 'cf:' + m });
  return out;
}
const hasAI = (env) => !!(env.GROQ_API_KEY || env.AI);
class AiError extends Error { constructor(msg, wait = 0) { super(msg); this.wait = wait; } }
const toMidnightUTC = () => 86400 - (nowSec() % 86400) + 60;

function looseJson(r) {
  if (r && typeof r === 'object') return r;
  const t = String(r ?? ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new AiError('la IA no devolvió JSON');
  return JSON.parse(t.slice(a, b + 1));
}
function cfText(out) {
  if (out?.response !== undefined && out?.response !== null) return out.response;
  const c = out?.choices?.[0]?.message?.content;
  if (c) return c;
  for (const o of Array.isArray(out?.output) ? out.output : []) for (const part of o?.content || []) if (part?.text) return part.text;
  return out?.output_text ?? out;
}
async function callGroq(env, p, system, user, maxTokens) {
  const oss = /gpt-oss/.test(p.model);
  const body = { model: p.model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_completion_tokens: maxTokens + (oss ? 2500 : 0), response_format: { type: 'json_object' } };
  if (oss) { body.reasoning_effort = 'medium'; body.include_reasoning = false; }
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try { res = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: 'Bearer ' + env.GROQ_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) }); }
    catch (e) { throw new AiError('Groq no responde: ' + e.message, 60); }
    const text = await res.text();
    if (res.status === 429) {
      const ra = +res.headers.get('retry-after');
      throw new AiError(`Groq: cupo de ${p.model} agotado de momento`, ra > 0 ? Math.min(ra + 5, 86400) : /per day|\b(TPD|RPD)\b/i.test(text) ? 3600 : 120);
    }
    if (res.status === 401 || res.status === 403) throw new AiError('Groq: la clave GROQ_API_KEY no es válida', 3600);
    if (res.status === 404) throw new AiError(`Groq: el modelo ${p.model} no existe`, 86400);
    if (res.status === 400 && attempt === 0 && /json|response_format|validate/i.test(text)) { delete body.response_format; continue; }
    if (!res.ok) throw new AiError(`Groq respondió ${res.status}: ${clip(text, 120)}`, res.status >= 500 ? 60 : 0);
    return looseJson(JSON.parse(text).choices?.[0]?.message?.content);
  }
  throw new AiError('Groq no devolvió JSON');
}
async function callCf(env, p, system, user, schema, maxTokens) {
  const base = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens + (/gpt-oss/.test(p.model) ? 2500 : 0), temperature: 0 };
  let out;
  try { out = await env.AI.run(p.model, { ...base, response_format: { type: 'json_schema', json_schema: schema } }); }
  catch (e) {
    if (/neuron|quota|daily|\b429\b|limit exceeded/i.test(e.message)) throw new AiError('Cloudflare AI: cupo diario agotado', toMidnightUTC());
    try { out = await env.AI.run(p.model, base); } catch (e2) { throw new AiError(`Cloudflare AI (${p.model}): ${clip(e2.message, 100)}`, /not found|no such model/i.test(e2.message) ? 86400 : 0); }
  }
  return looseJson(cfText(out));
}

/** Pregunta a la primera IA disponible. Devuelve { data, by } o lanza un error si ninguna responde. */
async function aiJson(env, system, user, schema, maxTokens) {
  const providers = aiProviders(env);
  if (!providers.length) throw new AiError('no hay ninguna IA configurada');
  const now = nowSec();
  const blocks = env.DB ? parse(await getConfig(env, 'ai_block').catch(() => null), {}) : {};
  const sys = `${system}\nResponde solo con un objeto JSON válido que siga este esquema: ${JSON.stringify(schema.schema || schema)}`;
  let lastErr = null, changed = false;
  for (const p of providers) {
    if ((blocks[p.id] || 0) > now) continue;
    try {
      const data = p.kind === 'groq' ? await callGroq(env, p, sys, user, maxTokens) : await callCf(env, p, sys, user, schema, maxTokens);
      if (!data || typeof data !== 'object') throw new AiError('respuesta vacía');
      if (changed) await setConfig(env, 'ai_block', JSON.stringify(blocks)).catch(() => {});
      if (env.DB) await setConfig(env, 'ai_ok', JSON.stringify({ at: now, by: p.id })).catch(() => {});
      return { data, by: p.id };
    } catch (e) {
      lastErr = e;
      console.log('IA', p.id, e.message);
      if (e.wait > 0 && env.DB) { blocks[p.id] = now + e.wait; changed = true; }
    }
  }
  if (env.DB) {
    if (changed) await setConfig(env, 'ai_block', JSON.stringify(blocks)).catch(() => {});
    await setConfig(env, 'ai_err', JSON.stringify({ at: now, msg: clip(lastErr?.message || 'todas las IA están en pausa por cupo', 160) })).catch(() => {});
  }
  throw lastErr || new AiError('todas las IA están en pausa por cupo');
}

const CLASS_SCHEMA = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, tipo: { type: 'string', enum: ['entrega', 'examen', 'actividad', 'informativo'] } }, required: ['id', 'tipo'] } } }, required: ['items'] };
const CLASS_PROMPT = `Clasificas elementos creados con la herramienta «Tarea» del campus virtual de una universidad española. Los profesores la usan para cosas distintas. Para cada elemento elige un tipo:
- "entrega": el estudiante debe hacer y subir o entregar algo antes de una fecha (práctica, ejercicios, trabajo, memoria, informe).
- "examen": es un examen, parcial, prueba, control o test de evaluación (presencial u online) que el profesor ha creado como tarea para que aparezca en el calendario, o para subir el examen resuelto.
- "actividad": un acto al que hay que asistir sin entregar nada (seminario, charla, visita, exposición, tutoría).
- "informativo": el estudiante NO tiene que hacer nada: calificaciones, notas, resultados, soluciones, revisiones, listados, material o documentación que publica el profesor.
Responde solo con JSON: {"items":[{"id":número,"tipo":"..."}]} con todos los elementos recibidos.`;

/** Clasifica con IA una lista de tareas [{id, name, intro, course}]. Devuelve {id: tipo}. Lanza error si la IA falla. */
export async function classifyAssignments(env, list) {
  const user = list.map((a) => `id ${a.id} | asignatura: ${clip(a.course, 60)} | nombre: ${clip(a.name, 140)}${a.intro ? ` | descripción: ${clip(a.intro, 240)}` : ''}`).join('\n');
  const { data: r } = await aiJson(env, CLASS_PROMPT, user, CLASS_SCHEMA, 80 + list.length * 24);
  const out = {};
  const ids = new Set(list.map((a) => a.id));
  for (const it of Array.isArray(r.items) ? r.items : []) {
    const id = +it.id, tipo = it.tipo === 'informativo' ? 'info' : it.tipo;
    if (ids.has(id) && (TYPES.includes(tipo) || tipo === 'info')) out[id] = tipo;
  }
  return out;
}

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

const DATEISH = /\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|sep?tiembre|octubre|noviembre|diciembre)|\b\d{1,2}[\/\-.]\d{1,2}\b|\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|mañana|pr[oó]xim[oa])\b/i;
const NOTICE_WORDS = /\b(ex[aá]men(es)?|parcial(es)?|prueba|control|test|evaluaci[oó]n|entrega[rs]?|plazo|fecha l[ií]mite|seminario|charla|conferencia|taller|visita|jornadas?|sesi[oó]n|pr[aá]cticas?|clase|tutor[ií]as?|exposici[oó]n|presentaci[oó]n|defensa|recuperaci[oó]n|reuni[oó]n|convocatoria|revisi[oó]n)\b/i;
const NOTICE_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    tipo: { type: 'string', enum: ['examen', 'entrega', 'actividad'] }, titulo: { type: 'string' },
    fecha: { type: 'string', description: 'YYYY-MM-DD' }, hora_inicio: { type: 'string', description: 'HH:MM en 24 h, o cadena vacía' },
    hora_fin: { type: 'string', description: 'HH:MM en 24 h, o cadena vacía' }, lugar: { type: 'string', description: 'lugar, o cadena vacía' },
  }, required: ['tipo', 'titulo', 'fecha', 'hora_inicio', 'hora_fin', 'lugar'] } } },
  required: ['items'],
};
const NOTICE_PROMPT = `Lees avisos que los profesores publican en el campus virtual de una universidad española. Extrae SOLO lo que el estudiante tiene que hacer o a lo que tiene que asistir y que tenga una fecha concreta. Tipos:
- "examen": examen, parcial, prueba, control, test, defensa o recuperación al que hay que presentarse.
- "entrega": algo que el estudiante debe entregar o subir; la fecha es la fecha límite.
- "actividad": seminario, charla, taller, visita, exposición, tutoría grupal, revisión de examen, clase extraordinaria o cambio de fecha de una sesión.
No incluyas: publicación de notas, calificaciones o material; hechos ya pasados; nada que no tenga fecha. No inventes fechas ni horas: si el aviso no da la hora o el lugar, deja ese campo como cadena vacía. Resuelve expresiones como «mañana» o «el próximo jueves» a partir de la fecha de publicación. Si el aviso cambia la fecha de algo anunciado antes, da solo la fecha nueva. Si un mismo acto tiene varias fechas (por grupos o turnos), incluye cada una con su grupo en el título. Títulos cortos y concretos (máximo 8 palabras), sin el nombre de la asignatura. Como máximo 6 elementos. Si no hay nada que extraer, devuelve {"items":[]}. Responde solo con JSON.`;

/** Lee un aviso y devuelve los exámenes, entregas y actividades con fecha que anuncia. */
export async function extractFromNotice(env, notice) {
  const text = clip(`${notice.subject}\n${notice.text}`, 12000);
  if (!NOTICE_WORDS.test(text) || !DATEISH.test(text)) return { items: [], source: 'filtro' };
  let raw = null, source = 'reglas', by = null;
  if (hasAI(env)) {
    try {
      const weekday = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'long' }).format(new Date(notice.created * 1000));
      const res = await aiJson(env, NOTICE_PROMPT, `Fecha de publicación: ${madridYMD(notice.created)} (${weekday})\nAsignatura: ${notice.course}\n\nAviso:\n${text}`, NOTICE_SCHEMA, 700);
      const r = res.data; by = res.by;
      raw = (Array.isArray(r.items) ? r.items : []).slice(0, 6).map((it) => ({
        type: it.tipo, title: clip(it.titulo || notice.subject, 90), date: it.fecha,
        time: /^\d{1,2}:\d{2}$/.test(it.hora_inicio || '') ? it.hora_inicio.padStart(5, '0') : null,
        end: /^\d{1,2}:\d{2}$/.test(it.hora_fin || '') ? it.hora_fin.padStart(5, '0') : null,
        place: it.lugar ? clip(it.lugar, 80) : null,
      }));
      source = 'ia';
    } catch (e) { console.log('IA no disponible, se usan reglas:', e.message); }
  }
  if (!raw) {
    const p = parseDateEs(text, notice.created);
    const type = RX_EXAM.test(text) ? 'examen' : /\b(entrega[rs]?|entregable|plazo|fecha l[ií]mite|subir)\b/i.test(text) ? 'entrega' : RX_ACT.test(text) ? 'actividad' : null;
    raw = p && type ? [{ type, title: clip(notice.subject, 90), date: p.date, time: p.time, end: null, place: null }] : [];
  }
  const items = [];
  for (const it of raw) {
    if (!TYPES.includes(it.type) || !/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) continue;
    const [y, m, d] = it.date.split('-').map(Number);
    const [hh, mm] = (it.time || '00:00').split(':').map(Number);
    const start = madridToEpoch(y, m, d, hh, mm);
    if (!(start > notice.created - 86400 && start < notice.created + 300 * 86400)) continue;
    let end = null;
    if (it.time && it.end) { const [eh, em] = it.end.split(':').map(Number); end = madridToEpoch(y, m, d, eh, em); if (end <= start) end = null; }
    items.push({ type: it.type, title: it.title, start, end, allDay: !it.time, place: it.place });
  }
  return { items, source, ...(by ? { by } : {}) };
}

async function cacheGet(env, keys, since = 0) {
  const out = {};
  if (!keys.length) return out;
  const r = await env.DB.prepare(`SELECT k, v, at FROM ai_cache WHERE k IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
  for (const row of r.results || []) if (row.at >= since) out[row.k] = row.v;
  return out;
}
const cachePut = (env, k, v) => env.DB.prepare('INSERT INTO ai_cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at').bind(k, v, nowSec()).run();

/* ───────────────────────── preferencias, agenda y estado del usuario ───────────────────────── */

export const OFFSETS = [604800, 259200, 172800, 86400, 43200, 10800, 3600];
const OFFSET_LABEL = { 604800: 'en 1 semana', 259200: 'en 3 días', 172800: 'en 2 días', 86400: 'en 1 día', 43200: 'en 12 horas', 10800: 'en 3 horas', 3600: 'en 1 hora' };
const DEFAULT_REM = { examen: [604800, 86400], entrega: [86400, 10800], actividad: [86400, 3600] };
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };

export function cleanPrefs(p) {
  const out = { notice: p?.notice !== false, feedback: p?.feedback !== false, rem: {} };
  for (const t of TYPES) {
    const v = Array.isArray(p?.rem?.[t]) ? p.rem[t] : DEFAULT_REM[t];
    out.rem[t] = [...new Set(v.map(Number).filter((x) => OFFSETS.includes(x)))].sort((a, b) => b - a);
  }
  return out;
}
function cleanAgenda(list) {
  const out = [], seen = new Set();
  for (const i of Array.isArray(list) ? list.slice(0, 300) : []) {
    const k = String(i?.k || '').slice(0, 60), ts = Math.floor(+i?.ts || 0);
    if (!k || seen.has(k) || !TYPES.includes(i.t) || !(ts > 0)) continue;
    seen.add(k);
    const o = { k, t: i.t, title: clip(i.title, 120), course: clip(i.course || '', 70), ts };
    if (i.allDay) o.allDay = 1;
    if (Number.isInteger(i.a)) o.a = i.a;
    if (Number.isInteger(i.c)) o.c = i.c;
    out.push(o);
  }
  return out;
}
function cleanUstate(u) {
  const manual = [], marks = {};
  for (const m of Array.isArray(u?.manual) ? u.manual.slice(0, 120) : []) {
    if (!m || !TYPES.includes(m.type) || !(+m.ts > 0)) continue;
    manual.push({ id: String(m.id || '').slice(0, 24), type: m.type, title: clip(m.title, 120), course: Number.isInteger(m.course) ? m.course : 0, ts: Math.floor(+m.ts), allDay: m.allDay ? 1 : 0, place: clip(m.place || '', 80), note: clip(m.note || '', 500) });
  }
  let n = 0;
  for (const [k, v] of Object.entries(u?.marks || {})) {
    if (n++ >= 600) break;
    const o = {};
    if (v?.done) o.done = 1;
    if (v?.hide) o.hide = 1;
    if (TYPES.includes(v?.type) || v?.type === 'info') o.type = v.type;
    if (Object.keys(o).length) marks[String(k).slice(0, 60)] = o;
  }
  return { rev: Math.floor(+u?.rev || 0), manual, marks };
}
const sameDay = (a, b) => madridYMD(a) === madridYMD(b);
/** «MODELOS LINEALES (2345_Grado en ... 2026/2027)» → «Modelos Lineales». Solo para mostrar: la identidad es siempre el número de asignatura. */
export function tidyCourse(full) {
  let s = String(full || '').replace(/\s*\([^()]*\)\s*$/, '').trim() || String(full || '');
  if (s.length > 3 && s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/(\s)(De|Del|La|Las|El|Los|Y|E|En|A|Con|Para|Por)(?=\s)/g, (m, sp, w) => sp + w.toLowerCase());
  }
  return s;
}
const WINDOW = 150 * 86400; // avisos que se analizan: los de los últimos 5 meses

/* ───────────────────────── revisión de un usuario ───────────────────────── */

export async function pollUser(env, user) {
  const now = nowSec();
  const base = (env.MOODLE_URL || 'https://campus.umh.es').replace(/\/+$/, '');
  const prefs = cleanPrefs(parse(user.prefs, {}));
  let subs = parse(user.subs, []);
  const old = parse(user.snapshot, null);
  let events = parse(user.events, []);
  let changes = parse(user.changes, []);
  let agenda = parse(user.agenda, []);
  const sent = parse(user.sent, {});
  const marks = parse(user.ustate, {}).marks || {};
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
  const snap = { v: 3, courses: {}, assigns: {}, cls: old?.cls ? { ...old.cls } : {}, forums: old?.forums ? { ...old.forums } : {}, seen: old?.seen ? old.seen.slice(-400) : [], nst: old?.nst ? { ...old.nst } : {}, notifMax: old?.notifMax || 0, rereadAt: old?.rereadAt || 0, reseen: old?.reseen || [] };
  let aiCalls = 0;
  const AI_PER_POLL = Math.max(1, +(env.AI_PER_POLL || 4));
  const reseen = new Set(snap.reseen);

  // 1. Tareas del campus: se clasifican (entrega, examen, actividad o informativa) antes de comparar
  const all = [];
  for (const c of assignData.courses || []) {
    snap.courses[c.id] = clip(tidyCourse(c.fullname), 70);
    for (const a of c.assignments || []) { all.push({ a, c }); snap.assigns[a.id] = [clip(a.name, 120), c.id, a.duedate || 0, a.cmid]; }
  }
  const live = new Set(all.map((x) => String(x.a.id)));
  for (const id of Object.keys(snap.cls)) if (!live.has(id)) delete snap.cls[id];
  const doubt = [];
  for (const { a, c } of all) {
    if (snap.cls[a.id] || (a.duedate && a.duedate < now - 14 * 86400)) continue;
    const r = ruleType(a.name);
    if (r.sure) snap.cls[a.id] = r.type; else doubt.push({ id: a.id, name: a.name, intro: htmlToText(a.intro).slice(0, 300), course: snap.courses[c.id] });
  }
  if (doubt.length) {
    const hits = await cacheGet(env, doubt.slice(0, 40).map((d) => 'a:' + d.id), snap.rereadAt);
    const ask = [];
    for (const d of doubt.slice(0, 40)) { if (hits['a:' + d.id]) snap.cls[d.id] = hits['a:' + d.id]; else ask.push(d); }
    if (ask.length && hasAI(env)) {
      aiCalls++;
      try {
        const res = await classifyAssignments(env, ask.slice(0, 12));
        for (const [id, type] of Object.entries(res)) { snap.cls[id] = type; await cachePut(env, 'a:' + id, type); }
      } catch (e) { console.log('clasificación con IA fallida:', e.message); }
    }
  }
  const typeOf = (a) => marks['a:' + a.id]?.type || snap.cls[a.id] || ruleType(a.name).type;
  const byKey = new Map(agenda.map((i) => [i.k, i]));
  for (const { a, c } of all) {
    const type = typeOf(a), key = 'a:' + a.id, due = a.duedate || 0;
    const hidden = type === 'info' || marks[key]?.hide;
    const inAgenda = byKey.get(key);
    if (inAgenda && (hidden || marks[key]?.done || !due)) { byKey.delete(key); continue; }
    if (inAgenda && due) { inAgenda.ts = due; inAgenda.t = type; inAgenda.title = clip(a.name, 120); }
    if (!old || hidden) continue;
    const before = old.assigns[a.id];
    const url = `${base}/mod/assign/view.php?id=${a.cmid}`;
    const common = { ts: now, kind: type, title: a.name, course: snap.courses[c.id], courseId: c.id, due, ref: a.id, url };
    if (!before) {
      fresh.push({ k: `task_new:${a.id}`, t: 'task_new', ...common });
      if (due > now && !inAgenda) byKey.set(key, { k: key, t: type, title: clip(a.name, 120), course: snap.courses[c.id], ts: due, a: a.id, c: c.id });
    } else if ((before[2] || 0) !== due) {
      fresh.push({ k: `task_due:${a.id}:${due}`, t: 'task_due', from: before[2] || 0, ...common });
      if (due > now && !inAgenda && !marks[key]?.done) byKey.set(key, { k: key, t: type, title: clip(a.name, 120), course: snap.courses[c.id], ts: due, a: a.id, c: c.id });
    }
  }

  // 2. Avisos: foros de novedades con debates nuevos (máx. 4 foros y AI_PER_POLL lecturas con IA por revisión)
  const seen = new Set(snap.seen);
  const pending = (forums || []).filter((f) => f.type === 'news' && (snap.forums[f.id] ?? -1) !== (f.numdiscussions || 0));
  for (const f of pending.slice(0, 4)) {
    if (!f.numdiscussions) { snap.forums[f.id] = 0; continue; }
    let res;
    try { res = await moodle(env, token, 'mod_forum_get_forum_discussions', { forumid: f.id, sortorder: 3, page: 0, perpage: 15 }); } catch { continue; }
    let complete = true;
    for (const d of res.discussions || []) {
      const did = d.discussion || d.id;
      if (seen.has(did)) continue;
      const course = snap.courses[f.course] || '';
      const notice = { id: did, subject: clip(d.subject || d.name, 140), text: htmlToText(d.message), created: d.created || now, course, courseId: f.course, url: `${base}/mod/forum/discuss.php?d=${did}` };
      // anterior al alta o ya visto antes de «volver a leer»: se lee, pero no se notifica
      const silent = notice.created < user.created_at || reseen.has(did);
      let found = null;
      if (notice.created > now - WINDOW) {
        const hit = (await cacheGet(env, ['n:' + did], snap.rereadAt))['n:' + did];
        if (hit) found = parse(hit, { items: [], source: 'ia' });
        else if (aiCalls >= AI_PER_POLL && hasAI(env)) { complete = false; break; } // el resto, en la próxima revisión
        else {
          found = await extractFromNotice(env, notice);
          if (found.source !== 'filtro' && hasAI(env)) aiCalls++;
          if (found.source === 'ia') await cachePut(env, 'n:' + did, JSON.stringify(found));
        }
        snap.nst[did] = found.source === 'filtro' ? 'filtro' : `${found.source}:${found.items.length}`;
      } else snap.nst[did] = 'antiguo';
      seen.add(did); snap.seen.push(did);
      if (!silent) fresh.push({ k: `notice:${did}`, t: 'notice', ts: notice.created, title: notice.subject, body: clip(notice.text, 220), course, courseId: f.course, ref: did, url: notice.url });
      (found?.items || []).forEach((it, n) => {
        if (it.start < now - 86400) return;
        const evId = n ? `d${did}_${n}` : 'd' + did;
        if (marks[evId]?.hide || events.some((e) => e.id === evId)) return;
        const dup = [...byKey.values()].some((x) => x.t === it.type && x.c === f.course && sameDay(x.ts, it.start)) || events.some((e) => (e.type || 'examen') === it.type && e.courseId === f.course && sameDay(e.start, it.start));
        if (dup) return;
        const ev = { id: evId, by: found.by, type: it.type, title: it.title, course, courseId: f.course, start: it.start, end: it.end, allDay: it.allDay, place: it.place, source: found.source, noticeId: did, url: notice.url, detected: now };
        events.push(ev);
        if (it.start > now) byKey.set(ev.id, { k: ev.id, t: it.type, title: it.title, course, ts: it.start, c: f.course, ...(it.allDay ? { allDay: 1 } : {}) });
        fresh.push({ k: `det:${ev.id}`, t: 'detected', kind: it.type, ts: now, title: it.title, course, courseId: f.course, due: it.start, allDay: it.allDay, ref: ev.id, url: notice.url, silent });
      });
    }
    if (complete) snap.forums[f.id] = f.numdiscussions || 0;
  }

  const keepSeen = new Set(snap.seen.map(String));
  for (const k of Object.keys(snap.nst)) if (!keepSeen.has(k)) delete snap.nst[k];

  // 3. Notificaciones del campus: calificaciones, retroalimentación y demás
  const notifs = notifData.notifications || [];
  for (const n of notifs) {
    if (n.id <= snap.notifMax || !old) continue;
    let custom = {};
    try { custom = JSON.parse(n.customdata || '{}'); } catch { /* sin datos extra */ }
    if (n.component === 'mod_forum') continue; // ya cubierto por los avisos
    if (custom.messagetype === 'submissionreceipt') continue; // confirmación de tu propia entrega
    const isGrade = /grade/i.test(n.eventtype || '') || custom.messagetype === 'feedbackavailable';
    fresh.push({ k: `notif:${n.id}`, t: 'feedback', kind: isGrade ? 'grade' : 'other', ts: n.timecreated || now, title: clip(htmlToText(n.subject), 160), body: clip(htmlToText(n.smallmessage || ''), 200), courseId: custom.courseid ? +custom.courseid : null, course: custom.courseid ? snap.courses[custom.courseid] || '' : '', ref: n.id, url: n.contexturl || base });
  }
  for (const n of notifs) if (n.id > snap.notifMax) snap.notifMax = n.id;

  // 4. Recordatorios: cada elemento de la agenda avisa con la antelación elegida para su tipo
  const reminders = [];
  agenda = [...byKey.values()].filter((i) => i.ts > now);
  const liveKeys = new Set(agenda.map((i) => i.k));
  for (const k of Object.keys(sent)) if (!liveKeys.has(k.slice(0, k.lastIndexOf(':')))) delete sent[k];
  for (const item of agenda) {
    let best = null;
    for (const off of prefs.rem[item.t] || []) {
      const fire = item.ts - off, key = `${item.k}:${off}`;
      if (fire > now || sent[key]) continue;
      sent[key] = now;
      if (now - fire <= 5400 && (!best || off < best)) best = off; // con más de 90 min de retraso ya no se envía
    }
    if (best) reminders.push({ item, off: best });
  }
  const notes = [];
  let checks = 0;
  for (const { item, off } of reminders.slice(0, 6)) {
    if (item.t === 'entrega' && item.a && checks < 3) {
      checks++;
      try {
        const st = await moodle(env, token, 'mod_assign_get_submission_status', { assignid: item.a });
        const sub = st.lastattempt?.teamsubmission || st.lastattempt?.submission;
        if (sub?.status === 'submitted') { agenda = agenda.filter((i) => i.k !== item.k); continue; } // ya entregada
      } catch { /* si no se puede comprobar, se recuerda igualmente */ }
    }
    notes.push({ title: `${TYPE_LABEL[item.t]} ${OFFSET_LABEL[off]}${item.course ? ' · ' + clip(item.course, 34) : ''}`, body: `${item.title} — ${item.allDay ? day(item.ts) : when(item.ts)}`, tag: `rem:${item.k}`, url: '/#item=' + encodeURIComponent(item.k), urgent: off <= 10800 });
  }

  // 5. Guardar y notificar. Novedades y cambios de fecha se avisan siempre; avisos y calificaciones, según preferencias.
  const known = new Set(changes.map((c) => c.k));
  const added = fresh.filter((c) => !known.has(c.k));
  changes = added.concat(changes).sort((a, b) => b.ts - a.ts).slice(0, 80);
  events = events.filter((e) => e.start > now - 30 * 86400).slice(-80);
  const toPush = added.filter((c) => !c.silent && (c.t === 'notice' ? prefs.notice : c.t === 'feedback' ? prefs.feedback : true));
  if (subs.length) {
    if (toPush.length > 3) notes.unshift({ title: `${toPush.length} novedades en el campus`, body: clip(toPush.map((c) => c.title).join(' · '), 180), tag: 'resumen', url: '/#avisos' });
    else notes.unshift(...toPush.map(noteFor));
    for (const note of notes) subs = await pushAll(env, subs, note);
  }
  await env.DB.prepare("UPDATE users SET snapshot = ?, events = ?, changes = ?, subs = ?, agenda = ?, sent = ?, last_poll = ?, last_ok = ?, fails = 0, status = 'ok' WHERE id = ?")
    .bind(JSON.stringify(snap), JSON.stringify(events), JSON.stringify(changes), JSON.stringify(subs), JSON.stringify(agenda), JSON.stringify(sent), now, now, user.id).run();
  return { status: 'ok', added: added.length, pushed: subs.length ? notes.length : 0, reminders: reminders.length, ai: aiCalls };
}

export function noteFor(c) {
  const course = c.course ? ` · ${clip(c.course, 38)}` : '';
  const kind = TYPES.includes(c.kind) ? c.kind : 'entrega';
  const fem = kind !== 'examen';
  const link = '/#item=' + encodeURIComponent(c.t === 'detected' ? c.ref : 'a:' + c.ref);
  switch (c.t) {
    case 'task_new': return { title: `${fem ? 'Nueva' : 'Nuevo'} ${kind}${course}`, body: c.due ? `${c.title} — ${when(c.due)}` : c.title, tag: c.k, url: link };
    case 'task_due': return { title: 'Fecha cambiada' + course, body: `${c.title}: ${c.from ? when(c.from) : 'sin fecha'} → ${c.due ? when(c.due) : 'sin fecha'}`, tag: c.k, url: link, urgent: true };
    case 'notice': return { title: 'Aviso' + course, body: c.title, tag: c.k, url: '/#aviso=' + c.ref };
    case 'detected': return { title: `${TYPE_LABEL[kind]} en un aviso${course}`, body: `${c.title} — ${c.allDay ? day(c.due) : when(c.due)}. ${fem ? 'Añadida' : 'Añadido'} a tu agenda.`, tag: c.k, url: link, urgent: kind === 'examen' };
    default: return { title: (c.kind === 'grade' ? 'Calificación o retroalimentación' : 'Notificación del campus') + course, body: c.title, tag: c.k, url: '/#avisos' };
  }
}

/* ───────────────────────── calendario .ics ───────────────────────── */

const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsFold = (line) => { const out = []; let l = line; while (enc.encode(l).length > 73) { out.push(l.slice(0, 60)); l = ' ' + l.slice(60); } out.push(l); return out.join('\r\n'); };
const icsStamp = (ts) => new Date(ts * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Calendario con lo detectado en avisos y lo añadido a mano. */
export function buildIcs(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Plazo//Campus UMH//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Plazo', 'X-WR-TIMEZONE:Europe/Madrid', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    const label = TYPE_LABEL[e.type || 'examen'];
    lines.push('BEGIN:VEVENT', `UID:${e.id}@plazo`, `DTSTAMP:${icsStamp(e.detected || nowSec())}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${madridYMD(e.start).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${madridYMD(e.start + 26 * 3600).replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART:${icsStamp(e.start)}`, `DTEND:${icsStamp(e.end || e.start + (e.type === 'entrega' ? 900 : 7200))}`);
    }
    lines.push(icsFold(`SUMMARY:${icsEsc(`${label}: ${e.title}${e.course ? ' · ' + e.course : ''}`)}`));
    lines.push(icsFold(`DESCRIPTION:${icsEsc(e.manual ? (e.note || 'Añadido a mano en Plazo.') : `Detectado por Plazo en un aviso del campus (${e.source === 'ia' ? 'IA' : 'reglas'}). Comprueba la fecha en el aviso original: ${e.url}`)}`));
    if (e.place) lines.push(icsFold(`LOCATION:${icsEsc(e.place)}`));
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${label}`, 'TRIGGER:-P1D', 'END:VALARM', 'END:VEVENT');
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
const readJson = async (request, max = 20000) => { try { const t = await request.text(); return t.length > max ? null : JSON.parse(t); } catch { return null; } };

async function api(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/config' && method === 'GET') {
    let ready = true, reason = null, pub = null, keySource = null;
    try { keySource = (await masterSecret(env)).source; pub = (await vapid(env)).pub; } catch (e) { ready = false; reason = e.message; }
    if (ready && !(await getConfig(env, 'origin'))) await setConfig(env, 'origin', url.origin);
    return json({ ready, reason, vapidPublicKey: pub, version: VERSION, ai: !!env.AI, pollMinutes: +(env.POLL_MINUTES || 10), keySource });
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
    const now = nowSec();
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'ok'").first()).n;
    const cfg = {};
    for (const row of (await env.DB.prepare("SELECT k, v FROM config WHERE k IN ('ai_ok', 'ai_err', 'ai_block')").all()).results || []) cfg[row.k] = row.v;
    let ok = parse(cfg.ai_ok, null);
    if (typeof ok === 'number') ok = { at: ok, by: null }; // formato de la versión 1.1
    const snap = parse(user.snapshot, {}) || {};
    const pollers = env.SELF ? Math.max(1, +(env.POLLERS || 6)) : 1;
    return json({
      status: user.status, events: parse(user.events, []), changes: parse(user.changes, []), cls: snap.cls || {}, nst: snap.nst || {}, rereadAt: snap.rereadAt || 0,
      prefs: cleanPrefs(parse(user.prefs, {})), ustate: cleanUstate(parse(user.ustate, {})), devices: parse(user.subs, []).length,
      lastOk: user.last_ok, cadenceMinutes: Math.max(+(env.POLL_MINUTES || 10), Math.ceil(total / pollers)), feedPath: `/cal/${user.id}-${user.feed_secret}.ics`,
      ai: { on: hasAI(env), providers: aiProviders(env).map((p) => p.id), ok: ok?.at || 0, by: ok?.by || null, err: parse(cfg.ai_err, null), paused: Object.entries(parse(cfg.ai_block, {})).filter(([, u]) => u > now).map(([k]) => k) },
      keySource: (await masterSecret(env)).source, version: VERSION,
    });
  }
  if (path === '/api/reread' && method === 'POST') {
    const now = nowSec();
    const snap = parse(user.snapshot, null);
    if (!snap) return fail(409, 'notyet', 'Espera a que termine la primera revisión del campus.');
    if (now - (snap.rereadAt || 0) < 3600) return fail(429, 'toosoon', 'Ya pediste volver a leer los avisos hace menos de una hora.');
    snap.reseen = (snap.seen || []).slice(-400);
    snap.forums = {}; snap.seen = []; snap.nst = {}; snap.cls = {}; snap.rereadAt = now;
    const events = parse(user.events, []).filter((e) => !e.noticeId);
    const agenda = parse(user.agenda, []).filter((i) => !/^d\d/.test(i.k));
    await env.DB.prepare('UPDATE users SET snapshot = ?, events = ?, agenda = ?, last_poll = 0 WHERE id = ?').bind(JSON.stringify(snap), JSON.stringify(events), JSON.stringify(agenda), user.id).run();
    return json({ ok: true });
  }
  if (path === '/api/sync' && method === 'POST') {
    const body = await readJson(request, 200000);
    if (!body) return fail(400, 'badbody', 'Datos no válidos.');
    const stored = cleanUstate(parse(user.ustate, {}));
    const incoming = body.ustate ? cleanUstate(body.ustate) : null;
    const ustate = incoming && incoming.rev >= stored.rev ? incoming : stored;
    const agenda = Array.isArray(body.agenda) ? cleanAgenda(body.agenda) : parse(user.agenda, []);
    await env.DB.prepare('UPDATE users SET ustate = ?, agenda = ? WHERE id = ?').bind(JSON.stringify(ustate), JSON.stringify(agenda), user.id).run();
    return json({ ok: true, rev: ustate.rev, agenda: agenda.length });
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
    const prefs = cleanPrefs(body?.prefs || {});
    await env.DB.prepare('UPDATE users SET prefs = ? WHERE id = ?').bind(JSON.stringify(prefs), user.id).run();
    return json({ ok: true, prefs });
  }
  if (path === '/api/events/dismiss' && method === 'POST') {
    const body = await readJson(request);
    const events = parse(user.events, []).filter((e) => e.id !== body?.id);
    const agenda = parse(user.agenda, []).filter((i) => i.k !== body?.id);
    await env.DB.prepare('UPDATE users SET events = ?, agenda = ? WHERE id = ?').bind(JSON.stringify(events), JSON.stringify(agenda), user.id).run();
    return json({ ok: true });
  }
  if (path === '/api/test-push' && method === 'POST') {
    const before = parse(user.subs, []);
    if (!before.length) return fail(409, 'nodevices', 'Este usuario no tiene ningún dispositivo con notificaciones activadas.');
    const subs = await pushAll(env, before, { title: 'Plazo funciona', body: 'Así te llegarán los recordatorios, las novedades y los avisos.', tag: 'prueba', url: '/' });
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
  const user = await env.DB.prepare('SELECT feed_secret, events, ustate FROM users WHERE id = ?').bind(+m[1]).first();
  if (!user || !safeEqual(user.feed_secret, m[2])) return new Response('No encontrado', { status: 404 });
  const st = cleanUstate(parse(user.ustate, {}));
  const manual = st.manual.filter((x) => !st.marks['u:' + x.id]?.hide).map((x) => ({ id: 'u' + x.id, type: x.type, title: x.title, start: x.ts, allDay: x.allDay, place: x.place, note: x.note, manual: true }));
  return new Response(buildIcs([...parse(user.events, []), ...manual]), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=900' } });
}

/* ───────────────────────── vigilante ───────────────────────── */

/** Reserva de forma atómica al usuario que más tiempo lleva sin revisar (varias revisiones a la vez no se pisan). */
async function claimNext(env) {
  const now = nowSec(), cutoff = now - 60 * +(env.POLL_MINUTES || 10) + 20;
  return env.DB.prepare("UPDATE users SET last_poll = ? WHERE id = (SELECT id FROM users WHERE status = 'ok' AND last_poll < ? ORDER BY last_poll ASC LIMIT 1) RETURNING *").bind(now, cutoff).first();
}
async function pollNext(env) {
  const user = await claimNext(env);
  if (!user) return { status: 'nada' };
  try { const r = await pollUser(env, user); console.log('revisión', user.id, JSON.stringify(r)); return { id: user.id, ...r }; }
  catch (e) {
    console.log('revisión fallida', user.id, e.message);
    await env.DB.prepare('UPDATE users SET fails = fails + 1 WHERE id = ?').bind(user.id).run().catch(() => {});
    return { id: user.id, status: 'error' };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // Revisión interna: la lanza el propio Worker (binding SELF) para revisar a varias personas a la vez,
      // cada una en su propia ejecución y con su propio límite de CPU.
      if (url.pathname === '/__poll') {
        if (request.method !== 'POST' || !env.DB) return new Response('No encontrado', { status: 404 });
        await ensureSchema(env);
        if (!safeEqual(request.headers.get('x-plazo-poll') || '', await sign(env, 'poll-internal'))) return new Response('No encontrado', { status: 404 });
        return json(await pollNext(env));
      }
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

  // Cada minuto: revisa a las personas que más tiempo llevan sin revisar.
  // Con el binding SELF, hasta POLLERS revisiones en paralelo (cada una con su propio límite de CPU); sin él, una.
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    await ensureSchema(env);
    const cutoff = nowSec() - 60 * +(env.POLL_MINUTES || 10) + 20;
    const due = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'ok' AND last_poll < ?").bind(cutoff).first()).n;
    if (!due) return;
    const n = Math.min(due, Math.max(1, Math.min(20, +(env.POLLERS || 6))));
    if (env.SELF && n > 1) {
      const key = await sign(env, 'poll-internal');
      const res = await Promise.allSettled(Array.from({ length: n }, () => env.SELF.fetch('https://plazo.internal/__poll', { method: 'POST', headers: { 'x-plazo-poll': key } }).then((r) => r.json())));
      const failed = res.filter((r) => r.status === 'rejected');
      console.log('revisiones en paralelo:', n, failed.length ? `· ${failed.length} fallidas: ${failed[0].reason?.message}` : '');
      if (failed.length === n) await pollNext(env); // el binding no funciona: al menos una revisión normal
    } else {
      await pollNext(env);
    }
  },
};

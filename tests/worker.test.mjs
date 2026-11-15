// Pruebas del Worker: node --experimental-sqlite tests/worker.test.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import nodeCrypto from 'node:crypto';
import worker, { b64u, encryptPush, parseDateEs, madridToEpoch, buildIcs, extractFromNotice, classifyAssignments, ruleType, cleanPrefs, htmlToText } from '../worker/index.js';

const enc = new TextEncoder();
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.log('FALLA ' + name + '\n', e); process.exitCode = 1; } };
const realLog = console.log;
const quiet = (on) => { console.log = on ? (...a) => { if (!/^(revisión|IA no|clasificación|push)/.test(String(a[0]))) realLog(...a); } : realLog; };
quiet(true);

/* ── D1 simulado con SQLite ── */
function mockD1(db = new DatabaseSync(':memory:')) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); }, _db: db };
}

/* ── Receptor push: descifra como lo haría el navegador (implementación independiente con node:crypto) ── */
function makeReceiver() {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return {
    sub: { endpoint: 'https://web.push.apple.com/abc123', keys: { p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(auth) } },
    decrypt(body) {
      const buf = Buffer.from(body);
      const salt = buf.subarray(0, 16), idlen = buf[20], asPub = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPub);
      const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPub]), 32));
      const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(plain[plain.length - 1], 2, 'delimitador de último registro');
      return plain.subarray(0, plain.length - 1).toString('utf8');
    },
  };
}

await test('Web Push: vector del RFC 8291 (apéndice A)', async () => {
  const d = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
  const pub = b64u.dec('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const jwk = { kty: 'EC', crv: 'P-256', d, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33)) };
  const keyPair = {
    privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
  const sub = { keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
  const body = await encryptPush(sub, enc.encode('When I grow up, I want to be a watermelon'), { salt: b64u.dec('DGv6ra1nlYgDCS1FRnbzlw'), keyPair });
  assert.equal(b64u.enc(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

await test('Web Push: un receptor independiente descifra el mensaje', async () => {
  const r = makeReceiver();
  const text = JSON.stringify({ title: 'Fecha cambiada · Álgebra', body: 'Práctica 3: mié 18 nov → vie 20 nov' });
  assert.equal(r.decrypt(await encryptPush(r.sub, enc.encode(text))), text);
});

await test('Fechas: hora de Madrid en invierno y en verano', () => {
  assert.equal(madridToEpoch(2026, 11, 18, 23, 59), Date.UTC(2026, 10, 18, 22, 59) / 1000);
  assert.equal(madridToEpoch(2026, 7, 9, 10, 0), Date.UTC(2026, 6, 9, 8, 0) / 1000);
});

await test('Fechas: extracción por reglas en español', () => {
  const posted = Date.UTC(2026, 10, 14, 10) / 1000;
  assert.deepEqual(parseDateEs('El examen parcial será el 12 de diciembre a las 10:30 en el aula 2.1', posted), { date: '2026-12-12', time: '10:30' });
  assert.deepEqual(parseDateEs('Convocatoria: día 20/01/2027 (16:00h), Altabix', posted), { date: '2027-01-20', time: '16:00' });
  assert.deepEqual(parseDateEs('La prueba se realizará el 15 de enero.', posted), { date: '2027-01-15', time: null });
  assert.equal(parseDateEs('Ya están publicadas las notas del examen.', posted), null);
  assert.equal(parseDateEs('Revisión del examen del 3 de noviembre', posted), null, 'fecha anterior a la publicación');
});

await test('Clasificación por reglas: entregas, exámenes e informativas', () => {
  assert.deepEqual(ruleType('Calificaciones examen parcial 1'), { type: 'info', sure: true });
  assert.deepEqual(ruleType('NOTAS FINALES DEFINITIVAS'), { type: 'info', sure: true });
  assert.equal(ruleType('Soluciones de la práctica 2').type, 'info');
  assert.deepEqual(ruleType('EXAMEN PARCIAL TEMAS 1-3'), { type: 'examen', sure: false });
  assert.deepEqual(ruleType('Entrega: Tema 4 - Sesión 2'), { type: 'entrega', sure: true });
  assert.deepEqual(ruleType('LABORATORIO Intervalos de Confianza 1 (0.5 puntos)'), { type: 'entrega', sure: true });
  assert.deepEqual(ruleType('Tema 6'), { type: 'entrega', sure: false });
});

await test('Clasificación con IA: respeta los tipos y descarta respuestas inválidas', async () => {
  const AI = { run: async () => ({ response: { items: [{ id: 1, tipo: 'examen' }, { id: 2, tipo: 'informativo' }, { id: 3, tipo: 'inventado' }, { id: 99, tipo: 'entrega' }] } }) };
  assert.deepEqual(await classifyAssignments({ AI }, [{ id: 1, name: 'Parcial' }, { id: 2, name: 'Notas' }, { id: 3, name: 'X' }]), { 1: 'examen', 2: 'info' });
});

await test('Avisos: la IA extrae varios elementos; sin IA se usan reglas', async () => {
  const posted = Date.UTC(2026, 10, 14, 10) / 1000;
  const notice = { id: 7, subject: 'Parcial y entrega del trabajo', text: 'El parcial será el 12 de diciembre a las 10:30. El trabajo se entrega el 18/12.', created: posted, course: 'Álgebra', courseId: 3, url: 'https://campus.umh.es/mod/forum/discuss.php?d=7' };
  const AI = { run: async () => ({ response: { items: [
    { tipo: 'examen', titulo: 'Parcial', fecha: '2026-12-12', hora_inicio: '10:30', hora_fin: '12:30', lugar: 'Aula 2.1' },
    { tipo: 'entrega', titulo: 'Trabajo final', fecha: '2026-12-18', hora_inicio: null, hora_fin: null, lugar: null },
    { tipo: 'actividad', titulo: 'Ya pasó', fecha: '2026-10-01', hora_inicio: null, hora_fin: null, lugar: null },
    { tipo: 'fiesta', titulo: 'Tipo inválido', fecha: '2026-12-20', hora_inicio: null, hora_fin: null, lugar: null }] } }) };
  const byAi = await extractFromNotice({ AI }, notice);
  assert.equal(byAi.source, 'ia');
  assert.deepEqual(byAi.items.map((i) => [i.type, i.allDay]), [['examen', false], ['entrega', true]]);
  assert.equal(byAi.items[0].end, madridToEpoch(2026, 12, 12, 12, 30));
  const byRules = await extractFromNotice({}, notice);
  assert.equal(byRules.source, 'reglas');
  assert.deepEqual(byRules.items.map((i) => [i.type, i.start]), [['examen', madridToEpoch(2026, 12, 12, 10, 30)]]);
  const broken = await extractFromNotice({ AI: { run: async () => { throw new Error('sin cuota'); } } }, notice);
  assert.equal(broken.source, 'reglas', 'si la IA falla se usan las reglas');
  assert.equal((await extractFromNotice({ AI }, { ...notice, subject: 'Bienvenida', text: 'Hola a todos.' })).source, 'filtro', 'sin fecha ni palabras clave no se gasta IA');
  const sem = await extractFromNotice({}, { ...notice, subject: 'Seminario de empresa', text: 'El seminario será el 2 de diciembre a las 12:00.' });
  assert.equal(sem.items[0].type, 'actividad');
});

await test('Calendario .ics bien formado', () => {
  const ics = buildIcs([{ id: 'd7', type: 'examen', title: 'Parcial; tema 1, 2', course: 'Álgebra', start: madridToEpoch(2026, 12, 12, 10, 30), end: null, allDay: false, source: 'ia', url: 'https://x', detected: 1 }, { id: 'u1', type: 'actividad', title: 'Seminario', start: madridToEpoch(2027, 1, 15), allDay: 1, manual: true, note: 'Llevar portátil' }]);
  assert.match(ics, /DTSTART:20261212T093000Z/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270115\r\nDTEND;VALUE=DATE:20270116/);
  assert.match(ics, /SUMMARY:Examen: Parcial\\; tema 1\\, 2 · Álgebra/);
  assert.match(ics, /SUMMARY:Actividad: Seminario/);
  assert.ok(ics.split('\r\n').every((l) => enc.encode(l).length <= 75), 'líneas plegadas');
});

await test('Preferencias: solo se aceptan antelaciones conocidas', () => {
  assert.deepEqual(cleanPrefs({ notice: false, rem: { examen: [86400, 5, 604800, 86400], entrega: [] } }), { notice: false, feedback: true, rem: { examen: [604800, 86400], entrega: [], actividad: [86400, 3600] } });
  assert.deepEqual(cleanPrefs({ task_new: true, exam: true }).rem.entrega, [86400, 10800], 'preferencias de la versión 1');
});

await test('htmlToText', () => assert.equal(htmlToText('<p>Hola&nbsp;<b>mundo</b></p><p>2 &lt; 3</p>'), 'Hola mundo\n2 < 3'));

/* ── Flujo completo con un campus simulado ── */
const TOKEN = 'a'.repeat(32);
const NOW = () => Math.floor(Date.now() / 1000);
const campus = {
  assignments: [
    { id: 1, cmid: 101, name: 'Práctica 1', duedate: NOW() + 4 * 86400 },
    { id: 2, cmid: 102, name: 'Laboratorio 2', duedate: NOW() + 11 * 86400 },
    { id: 3, cmid: 103, name: 'Calificaciones examen parcial', duedate: NOW() + 2 * 86400 },
    { id: 4, cmid: 104, name: 'Tema 6', duedate: NOW() + 6 * 86400, intro: '<p>Parcial presencial en el aula 1.</p>' },
  ],
  forums: [{ id: 50, course: 3, type: 'news', numdiscussions: 1 }],
  discussions: [{ discussion: 900, subject: 'Bienvenida', message: '<p>Hola</p>', created: 1000 }],
  notifications: [{ id: 10, component: 'mod_assign', eventtype: 'assign_notification', subject: 'Usted ha realizado su entrega', customdata: '{"messagetype":"submissionreceipt"}', timecreated: 1000 }],
  submitted: new Set(), tokenValid: true,
};
const pushes = [];
const aiLog = [];
const receiver = makeReceiver();
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url === 'https://campus.umh.es/webservice/rest/server.php') {
    const p = init.body;
    const reply = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    if (p.get('wstoken') !== TOKEN || !campus.tokenValid) return reply({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Token no válido' });
    switch (p.get('wsfunction')) {
      case 'core_webservice_get_site_info': return reply({ userid: 4242, fullname: 'Estudiante Demo', siteurl: 'https://campus.umh.es' });
      case 'mod_assign_get_assignments': return reply({ courses: [{ id: 3, fullname: 'Álgebra Matricial', assignments: campus.assignments }] });
      case 'mod_forum_get_forums_by_courses': return reply(campus.forums);
      case 'mod_forum_get_forum_discussions': return reply({ discussions: campus.discussions });
      case 'message_popup_get_popup_notifications': return reply({ notifications: campus.notifications });
      case 'mod_assign_get_submission_status': return reply({ lastattempt: { submission: { status: campus.submitted.has(+p.get('assignid')) ? 'submitted' : 'new' } } });
    }
    return reply({ exception: 'x', errorcode: 'unknownfunction', message: p.get('wsfunction') });
  }
  if (url.startsWith('https://web.push.apple.com/')) {
    assert.match(init.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(init.headers['content-encoding'], 'aes128gcm');
    if (url.endsWith('/gone')) return new Response('', { status: 410 });
    pushes.push(JSON.parse(receiver.decrypt(init.body)));
    return new Response('', { status: 201 });
  }
  throw new Error('fetch inesperado: ' + url);
};
// IA simulada: clasifica por la descripción y lee los avisos de forma determinista
const AI = { run: async (model, input) => {
  const sys = input.messages[0].content, usr = input.messages[1].content;
  aiLog.push(sys.startsWith('Clasificas') ? 'clasificar' : 'aviso');
  if (sys.startsWith('Clasificas')) return { response: { items: usr.split('\n').map((l) => ({ id: +/^id (\d+)/.exec(l)[1], tipo: /parcial|examen/i.test(l) ? 'examen' : 'entrega' })) } };
  const m = /EXAMEN:(\d{4}-\d{2}-\d{2})/.exec(usr), e = /ENTREGA:(\d{4}-\d{2}-\d{2})/.exec(usr);
  return { response: { items: [m && { tipo: 'examen', titulo: 'Segundo parcial', fecha: m[1], hora_inicio: '10:30', hora_fin: null, lugar: 'Aula 2.1' }, e && { tipo: 'entrega', titulo: 'Memoria del proyecto', fecha: e[1], hora_inicio: null, hora_fin: null, lugar: null }].filter(Boolean) } };
} };

const env = { DB: mockD1(), AI, MOODLE_URL: 'https://campus.umh.es', POLL_MINUTES: '10' };
const call = (path, { method = 'GET', body, auth } = {}) => worker.fetch(new Request('https://plazo.test' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: auth ? { authorization: 'Bearer ' + auth } : {} }), env);
const tick = () => worker.scheduled({}, env, {});
const rewind = () => env.DB._db.exec('UPDATE users SET last_poll = 0');
const feedOf = async () => (await call('/api/feed', { auth: session })).json();
const ymd = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(ts * 1000));
let session;

await test('API: funciona sin MASTER_KEY (clave automática) y también con ella', async () => {
  const cfg = await (await call('/api/config')).json();
  assert.equal(cfg.ready, true);
  assert.equal(cfg.keySource, 'auto');
  assert.equal(b64u.dec(cfg.vapidPublicKey).length, 65);
  const again = await (await call('/api/config')).json();
  assert.equal(again.vapidPublicKey, cfg.vapidPublicKey, 'las claves se conservan');
  const other = await (await worker.fetch(new Request('https://plazo.test/api/config'), { DB: mockD1(), MASTER_KEY: 'clave-maestra-de-prueba-0123456789' })).json();
  assert.equal(other.keySource, 'secreto');
});

await test('API: una base de datos de la versión 1 se actualiza sola', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, token_enc TEXT NOT NULL, salt TEXT NOT NULL, feed_secret TEXT NOT NULL, subs TEXT NOT NULL DEFAULT '[]', prefs TEXT NOT NULL DEFAULT '{}', snapshot TEXT, events TEXT NOT NULL DEFAULT '[]', changes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'ok', created_at INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0, last_ok INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0); CREATE TABLE config (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const r = await worker.fetch(new Request('https://plazo.test/api/config'), { DB: mockD1(db) });
  assert.equal((await r.json()).ready, true);
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(['agenda', 'sent', 'ustate'].every((c) => cols.includes(c)), cols.join());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_cache'").get());
});

await test('API: registro, token cifrado en reposo y sesión', async () => {
  assert.equal((await call('/api/register', { method: 'POST', body: { token: 'nope' } })).status, 400);
  assert.equal((await call('/api/register', { method: 'POST', body: { token: 'b'.repeat(32) } })).status, 401);
  const r = await call('/api/register', { method: 'POST', body: { token: TOKEN } });
  assert.equal(r.status, 200);
  session = (await r.json()).auth;
  const row = env.DB._db.prepare('SELECT * FROM users').get();
  assert.equal(row.id, 4242);
  assert.ok(!JSON.stringify(row).includes(TOKEN), 'el token no se guarda en claro');
  assert.equal((await call('/api/feed', { auth: '4242.falso' })).status, 401);
  assert.equal((await call('/api/feed')).status, 401);
  const again = await (await call('/api/register', { method: 'POST', body: { token: TOKEN } })).json();
  assert.equal(again.auth, session, 'un segundo dispositivo conserva la misma sesión');
});

await test('API: suscripción push validada', async () => {
  assert.equal((await call('/api/subscribe', { method: 'POST', auth: session, body: { subscription: { endpoint: 'https://evil.example/x', keys: receiver.sub.keys } } })).status, 400);
  assert.equal((await call('/api/subscribe', { method: 'POST', auth: session, body: { subscription: receiver.sub } })).status, 200);
  await call('/api/subscribe', { method: 'POST', auth: session, body: { subscription: { ...receiver.sub, endpoint: 'https://web.push.apple.com/gone' } } });
  const t = await (await call('/api/test-push', { method: 'POST', auth: session })).json();
  assert.equal(t.devices, 1, 'la suscripción caducada (410) se elimina');
  assert.equal(pushes.pop().title, 'Plazo funciona');
});

await test('Vigilante: la primera revisión clasifica las tareas y no notifica nada', async () => {
  await tick();
  assert.equal(pushes.length, 0);
  const feed = await feedOf();
  assert.equal(feed.changes.length, 0);
  assert.deepEqual(feed.cls, { 1: 'entrega', 2: 'entrega', 3: 'info', 4: 'examen' });
  assert.deepEqual(aiLog, ['clasificar'], 'una sola llamada a la IA, solo para la tarea dudosa');
  assert.equal(env.DB._db.prepare("SELECT v FROM ai_cache WHERE k = 'a:4'").get().v, 'examen', 'la clasificación se comparte entre compañeros');
  assert.ok(feed.ai.on && feed.ai.ok > 0);
});

await test('Vigilante: respeta el intervalo entre revisiones', async () => {
  campus.assignments.push({ id: 5, cmid: 105, name: 'Entrega tema 5', duedate: NOW() + 9 * 86400 });
  await tick();
  assert.equal(pushes.length, 0, 'aún no toca revisar');
});

await test('Vigilante: novedades por tipo; lo informativo no se añade ni se notifica', async () => {
  campus.assignments.push({ id: 6, cmid: 106, name: 'NOTAS PROVISIONALES PRÁCTICAS', duedate: NOW() + 3 * 86400 });
  campus.assignments.push({ id: 7, cmid: 107, name: 'Examen parcial temas 4-6', duedate: NOW() + 20 * 86400 });
  rewind(); await tick();
  const feed = await feedOf();
  assert.deepEqual(feed.changes.map((c) => [c.t, c.kind, c.ref]).sort(), [['task_new', 'entrega', 5], ['task_new', 'examen', 7]]);
  assert.equal(feed.cls[6], 'info');
  assert.deepEqual(pushes.map((p) => p.title).sort(), ['Nueva entrega · Álgebra Matricial', 'Nuevo examen · Álgebra Matricial']);
  assert.equal(pushes.find((p) => /examen/.test(p.title)).url, '/#item=a%3A7');
  pushes.length = 0;
  rewind(); await tick();
  assert.equal(pushes.length, 0, 'sin cambios no hay notificaciones repetidas');
});

await test('Vigilante: cambio de fecha, aviso leído por la IA y calificación', async () => {
  const exam = NOW() + 20 * 86400 + 86400 * 3, due = NOW() + 30 * 86400, posted = NOW() + 5;
  campus.assignments[0].duedate = NOW() + 5 * 86400;
  campus.forums[0].numdiscussions = 2;
  campus.discussions.unshift({ discussion: 901, subject: 'Fechas del segundo parcial y de la memoria', message: `<p>El examen será pronto. EXAMEN:${ymd(exam)} ENTREGA:${ymd(due)} mañana os digo más.</p>`, created: posted });
  campus.notifications.unshift({ id: 11, component: 'mod_assign', eventtype: 'assign_notification', subject: 'Usted ha realizado su entrega en Práctica 1', customdata: '{"messagetype":"submissionreceipt"}', timecreated: posted });
  campus.notifications.unshift({ id: 12, component: 'mod_assign', eventtype: 'assign_notification', subject: 'El profesor ha calificado tu entrega de Práctica 1', customdata: '{"messagetype":"feedbackavailable","courseid":3}', timecreated: posted, contexturl: 'https://campus.umh.es/mod/assign/view.php?id=101' });
  aiLog.length = 0;
  rewind(); await tick();
  const feed = await feedOf();
  assert.deepEqual(feed.changes.slice(0, 5).map((c) => c.t).sort(), ['detected', 'detected', 'feedback', 'notice', 'task_due']);
  assert.deepEqual(feed.events.map((e) => [e.type, e.id, e.allDay]), [['examen', 'd901', false], ['entrega', 'd901_1', true]]);
  assert.deepEqual(aiLog, ['aviso']);
  assert.equal(pushes.length, 1, 'más de 3 novedades se agrupan en un resumen');
  assert.match(pushes[0].title, /5 novedades/);
  pushes.length = 0;
});

await test('Vigilante: preferencias de avisos; los cambios de fecha se notifican siempre', async () => {
  const p = await (await call('/api/prefs', { method: 'POST', auth: session, body: { prefs: { notice: false, feedback: false, rem: { examen: [86400], entrega: [86400, 3600], actividad: [] } } } })).json();
  assert.deepEqual(p.prefs.rem.entrega, [86400, 3600]);
  campus.forums[0].numdiscussions = 3;
  campus.discussions.unshift({ discussion: 902, subject: 'Cambio de aula', message: '<p>Sin fecha.</p>', created: NOW() + 6 });
  campus.assignments[1].duedate = madridToEpoch(2027, 11, 27, 12, 0);
  const from = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date((NOW() + 11 * 86400) * 1000)).replace(/,/g, '');
  rewind(); await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'Fecha cambiada · Álgebra Matricial');
  assert.ok(pushes[0].body.startsWith('Laboratorio 2: ') && pushes[0].body.endsWith('→ sáb 27 nov 12:00'), pushes[0].body);
  pushes.length = 0;
});

await test('Recordatorios: avisan una vez, con la antelación elegida, y no si ya está entregada', async () => {
  const soon = NOW() + 86400 - 120; // el recordatorio de «1 día antes» venció hace 2 minutos
  const agenda = [
    { k: 'a:1', t: 'entrega', title: 'Práctica 1', course: 'Álgebra Matricial', ts: soon, a: 1, c: 3 },
    { k: 'a:2', t: 'entrega', title: 'Laboratorio 2', course: 'Álgebra Matricial', ts: soon + 30, a: 2, c: 3 },
    { k: 'u:x1', t: 'examen', title: 'Parcial de recuperación', course: '', ts: soon + 60 },
    { k: 'm:77', t: 'actividad', title: 'Seminario', course: '', ts: soon + 90 },
    { k: 'u:tarde', t: 'examen', title: 'Aviso demasiado tardío', course: '', ts: NOW() + 86400 - 3 * 3600 },
    { k: 'malo', t: 'fiesta', title: 'Tipo inválido', ts: soon },
  ];
  const s = await (await call('/api/sync', { method: 'POST', auth: session, body: { agenda, ustate: { rev: 5, manual: [{ id: 'x1', type: 'examen', title: 'Parcial de recuperación', ts: soon + 60 }], marks: { 'a:9': { done: 1 }, 'a:8': { type: 'nada' } } } } })).json();
  assert.equal(s.agenda, 5);
  campus.assignments[0].duedate = soon; campus.assignments[1].duedate = soon + 30;
  campus.submitted.add(2);
  env.DB._db.exec("UPDATE users SET snapshot = json_set(snapshot, '$.assigns.1[2]', " + soon + ", '$.assigns.2[2]', " + (soon + 30) + ')');
  rewind(); await tick();
  assert.deepEqual(pushes.map((p) => p.title).sort(), ['Entrega en 1 día · Álgebra Matricial', 'Examen en 1 día']);
  assert.equal(pushes.find((p) => /Entrega/.test(p.title)).url, '/#item=a%3A1');
  const row = env.DB._db.prepare('SELECT agenda, ustate FROM users').get();
  assert.ok(!JSON.parse(row.agenda).some((i) => i.k === 'a:2'), 'la entregada sale de la agenda');
  assert.deepEqual(JSON.parse(row.ustate).marks, { 'a:9': { done: 1 } });
  pushes.length = 0;
  rewind(); await tick();
  assert.equal(pushes.length, 0, 'no se repite');
  const older = await (await call('/api/sync', { method: 'POST', auth: session, body: { ustate: { rev: 2, manual: [], marks: {} } } })).json();
  assert.equal(older.rev, 5, 'un estado más antiguo no pisa el nuevo');
});

await test('Calendario: el enlace secreto incluye lo detectado y lo añadido a mano', async () => {
  const feed = await feedOf();
  const ok = await call(feed.feedPath);
  assert.equal(ok.status, 200);
  const ics = await ok.text();
  assert.match(ics, /SUMMARY:Examen: Segundo parcial/);
  assert.match(ics, /SUMMARY:Entrega: Memoria del proyecto/);
  assert.match(ics, /SUMMARY:Examen: Parcial de recuperación/);
  assert.equal((await call('/cal/4242-falso.ics')).status, 404);
  await call('/api/events/dismiss', { method: 'POST', auth: session, body: { id: 'd901' } });
  assert.deepEqual((await feedOf()).events.map((e) => e.id), ['d901_1']);
});

await test('Vigilante: token caducado → aviso único para reconectar', async () => {
  campus.tokenValid = false;
  rewind(); await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].tag, 'relogin');
  rewind(); await tick();
  assert.equal(pushes.length, 1, 'no insiste');
  campus.tokenValid = true;
  await call('/api/register', { method: 'POST', body: { token: TOKEN } });
  assert.equal((await feedOf()).status, 'ok');
});

await test('API: eliminar la cuenta borra todos los datos', async () => {
  assert.equal((await call('/api/account', { method: 'DELETE', auth: session })).status, 200);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal((await call('/api/feed', { auth: session })).status, 401);
});

quiet(false);
console.log(`\n${passed} pruebas correctas${process.exitCode ? ' — HAY FALLOS' : ''}`);

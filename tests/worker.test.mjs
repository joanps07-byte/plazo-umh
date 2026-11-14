// Pruebas del Worker: node --experimental-sqlite tests/worker.test.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import nodeCrypto from 'node:crypto';
import worker, { b64u, encryptPush, parseDateEs, madridToEpoch, buildIcs, detectExam, htmlToText } from '../worker/index.js';

const enc = new TextEncoder();
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.log('FALLA ' + name + '\n', e); process.exitCode = 1; } };

/* ── D1 simulado con SQLite ── */
function mockD1() {
  const db = new DatabaseSync(':memory:');
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
  const text = JSON.stringify({ title: 'Plazo cambiado · Álgebra', body: 'Práctica 3: mié 18 nov → vie 20 nov' });
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

await test('Avisos: detección con IA, con reglas y descartes', async () => {
  const posted = Date.UTC(2026, 10, 14, 10) / 1000;
  const notice = { id: 7, subject: 'Examen parcial', text: 'El parcial será el 12 de diciembre a las 10:30.', created: posted, course: 'Álgebra', courseId: 3, url: 'https://campus.umh.es/mod/forum/discuss.php?d=7' };
  const byRules = await detectExam({}, notice);
  assert.equal(byRules.source, 'reglas');
  assert.equal(byRules.start, madridToEpoch(2026, 12, 12, 10, 30));
  const ai = { run: async () => ({ response: { es_evaluacion: true, titulo: 'Parcial de Álgebra', fecha: '2026-12-12', hora_inicio: '10:30', hora_fin: '12:30', lugar: 'Aula 2.1' } }) };
  const byAi = await detectExam({ AI: ai }, notice);
  assert.equal(byAi.source, 'ia');
  assert.equal(byAi.end, madridToEpoch(2026, 12, 12, 12, 30));
  assert.equal(byAi.place, 'Aula 2.1');
  assert.equal(await detectExam({ AI: { run: async () => ({ response: '{"es_evaluacion": false, "titulo": "", "fecha": null, "hora_inicio": null, "hora_fin": null, "lugar": null}' }) } }, notice), null, 'la IA lo descarta');
  assert.equal(await detectExam({}, { ...notice, subject: 'Cambio de aula', text: 'Mañana la clase es en el aula 3.' }), null, 'sin palabras de evaluación');
  const broken = await detectExam({ AI: { run: async () => { throw new Error('sin cuota'); } } }, notice);
  assert.equal(broken.source, 'reglas', 'si la IA falla se usan las reglas');
});

await test('Calendario .ics bien formado', () => {
  const ics = buildIcs([{ id: 'd7', title: 'Parcial; tema 1, 2', course: 'Álgebra', start: madridToEpoch(2026, 12, 12, 10, 30), end: null, allDay: false, source: 'ia', url: 'https://x', detected: 1 }, { id: 'd8', title: 'Defensa', course: '', start: madridToEpoch(2027, 1, 15), allDay: true, source: 'reglas', url: 'https://y', detected: 1 }]);
  assert.match(ics, /DTSTART:20261212T093000Z/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270115\r\nDTEND;VALUE=DATE:20270116/);
  assert.match(ics, /SUMMARY:Parcial\\; tema 1\\, 2 · Álgebra/);
  assert.ok(ics.split('\r\n').every((l) => enc.encode(l).length <= 75), 'líneas plegadas');
});

await test('htmlToText', () => assert.equal(htmlToText('<p>Hola&nbsp;<b>mundo</b></p><p>2 &lt; 3</p>'), 'Hola mundo\n2 < 3'));

/* ── Flujo completo con un campus simulado ── */
const TOKEN = 'a'.repeat(32);
const campus = {
  assignments: [{ id: 1, cmid: 101, name: 'Práctica 1', duedate: madridToEpoch(2026, 11, 18, 23, 59) }, { id: 2, cmid: 102, name: 'Laboratorio 2', duedate: madridToEpoch(2026, 11, 25, 23, 59) }],
  forums: [{ id: 50, course: 3, type: 'news', numdiscussions: 1 }],
  discussions: [{ discussion: 900, subject: 'Bienvenida', message: '<p>Hola</p>', created: 1000 }],
  notifications: [{ id: 10, component: 'mod_assign', eventtype: 'assign_notification', subject: 'Usted ha realizado su entrega', customdata: '{"messagetype":"submissionreceipt"}', timecreated: 1000 }],
  tokenValid: true,
};
const pushes = [];
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

const env = { DB: mockD1(), MASTER_KEY: 'clave-maestra-de-prueba-0123456789', MOODLE_URL: 'https://campus.umh.es', POLL_MINUTES: '10' };
const call = (path, { method = 'GET', body, auth } = {}) => worker.fetch(new Request('https://plazo.test' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: auth ? { authorization: 'Bearer ' + auth } : {} }), env);
const tick = () => worker.scheduled({}, env, {});
const rewind = () => env.DB._db.exec('UPDATE users SET last_poll = 0');
let session;

await test('API: sin MASTER_KEY avisa de la configuración', async () => {
  const r = await worker.fetch(new Request('https://plazo.test/api/config'), { DB: mockD1() });
  const j = await r.json();
  assert.equal(j.ready, false);
  assert.match(j.reason, /MASTER_KEY/);
});

await test('API: registro, token cifrado en reposo y sesión', async () => {
  const cfg = await (await call('/api/config')).json();
  assert.equal(cfg.ready, true);
  assert.equal(b64u.dec(cfg.vapidPublicKey).length, 65);
  assert.equal((await call('/api/register', { method: 'POST', body: { token: 'nope' } })).status, 400);
  assert.equal((await call('/api/register', { method: 'POST', body: { token: 'b'.repeat(32) } })).status, 401);
  const r = await call('/api/register', { method: 'POST', body: { token: TOKEN } });
  assert.equal(r.status, 200);
  const j = await r.json();
  session = j.auth;
  const row = env.DB._db.prepare('SELECT * FROM users').get();
  assert.equal(row.id, 4242);
  assert.ok(!JSON.stringify(row).includes(TOKEN), 'el token no se guarda en claro');
  assert.equal((await call('/api/feed', { auth: '4242.falso' })).status, 401);
  assert.equal((await call('/api/feed')).status, 401);
  assert.equal((await call('/api/feed', { auth: session })).status, 200);
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

await test('Vigilante: la primera revisión no notifica nada', async () => {
  await tick();
  assert.equal(pushes.length, 0);
  const feed = await (await call('/api/feed', { auth: session })).json();
  assert.equal(feed.changes.length, 0);
  assert.ok(feed.lastOk > 0);
});

await test('Vigilante: respeta el intervalo entre revisiones', async () => {
  campus.assignments.push({ id: 3, cmid: 103, name: 'Entrega tema 5', duedate: madridToEpoch(2026, 12, 2, 23, 59) });
  await tick();
  assert.equal(pushes.length, 0, 'aún no toca revisar');
});

await test('Vigilante: tarea nueva, plazo cambiado, aviso con examen y retroalimentación', async () => {
  campus.assignments[0].duedate = madridToEpoch(2026, 11, 20, 23, 59);
  campus.forums[0].numdiscussions = 2;
  const posted = Math.floor(Date.now() / 1000) + 5;
  const exam = new Date(Date.now() + 20 * 86400000);
  campus.discussions.unshift({ discussion: 901, subject: 'Fecha del examen parcial', message: `<p>El parcial será el ${exam.getUTCDate()}/${exam.getUTCMonth() + 1}/${exam.getUTCFullYear()} a las 10:30 en el aula 2.1</p>`, created: posted });
  campus.notifications.unshift({ id: 11, component: 'mod_assign', eventtype: 'assign_notification', subject: 'Usted ha realizado su entrega en Práctica 1', customdata: '{"messagetype":"submissionreceipt"}', timecreated: posted });
  campus.notifications.unshift({ id: 12, component: 'mod_assign', eventtype: 'assign_notification', subject: 'El profesor ha comentado tu entrega de Práctica 1', customdata: '{"messagetype":"feedbackavailable","courseid":3}', timecreated: posted, contexturl: 'https://campus.umh.es/mod/assign/view.php?id=101' });
  rewind(); await tick();
  const feed = await (await call('/api/feed', { auth: session })).json();
  const types = feed.changes.map((c) => c.t).sort();
  assert.deepEqual(types, ['exam', 'feedback', 'notice', 'task_due', 'task_new']);
  assert.equal(feed.events.length, 1);
  assert.equal(feed.events[0].allDay, false);
  assert.equal(pushes.length, 1, 'más de 3 novedades se agrupan en un resumen');
  assert.match(pushes[0].title, /5 novedades/);
  pushes.length = 0;
  rewind(); await tick();
  assert.equal(pushes.length, 0, 'sin cambios no hay notificaciones repetidas');
});

await test('Vigilante: notificaciones individuales y preferencias', async () => {
  await call('/api/prefs', { method: 'POST', auth: session, body: { prefs: { task_new: false } } });
  campus.assignments.push({ id: 4, cmid: 104, name: 'Silenciada', duedate: 0 });
  campus.assignments[1].duedate = madridToEpoch(2026, 11, 27, 12, 0);
  rewind(); await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'Plazo cambiado · Álgebra Matricial');
  assert.match(pushes[0].body, /^Laboratorio 2: mié 25 nov 23:59 → vie 27 nov 12:00$/);
  assert.equal(pushes[0].url, '/#tarea=2');
  pushes.length = 0;
});

await test('Calendario: el enlace secreto sirve el .ics y uno falso no', async () => {
  const feed = await (await call('/api/feed', { auth: session })).json();
  const ok = await call(feed.feedPath);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /SUMMARY:.*examen parcial/i);
  assert.equal((await call('/cal/4242-falso.ics')).status, 404);
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
  assert.equal((await (await call('/api/feed', { auth: session })).json()).status, 'ok');
});

await test('API: eliminar la cuenta borra todos los datos', async () => {
  assert.equal((await call('/api/account', { method: 'DELETE', auth: session })).status, 200);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal((await call('/api/feed', { auth: session })).status, 401);
});

console.log(`\n${passed} pruebas correctas${process.exitCode ? ' — HAY FALLOS' : ''}`);

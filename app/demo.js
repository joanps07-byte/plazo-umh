// Datos inventados para la demostración (?demo). No se conecta a ningún sitio.
export function demoData() {
  const now = Math.floor(Date.now() / 1000);
  const at = (days, h = 23, m = 59) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return Math.floor(d / 1000); };
  const courses = {
    1: { name: 'Álgebra Matricial' }, 2: { name: 'Fundamentos de Bases de Datos' }, 3: { name: 'Modelos Lineales' },
    4: { name: 'Optimización Continua' }, 5: { name: 'Técnicas de Visualización' }, 6: { name: 'Estadística Matemática' },
  };
  const T = (id, course, name, due, state, intro = '') => ({ id, cmid: 700 + id, course, name, due, opens: 0, cutoff: 0, modified: now - 86400, intro, state });
  const tasks = [
    T(1, 2, 'Práctica 3: consultas con JOIN', at(-1), 'pending'),
    T(2, 3, 'Entrega tema 4, sesión 4', at(0, 23, 59), 'pending', '<p>Sube un único PDF con los ejercicios 1 a 6 resueltos.</p><ul><li>Incluye el código en R.</li><li>Máximo 8 páginas.</li></ul>'),
    T(3, 6, 'Laboratorio: intervalos de confianza 1 (0,5 puntos)', at(2), 'pending'),
    T(4, 5, 'Entregable práctica 4: panel interactivo', at(4, 14, 0), 'pending', '<p>Entrega el enlace al panel y una memoria de dos páginas.</p>'),
    T(5, 1, 'Ejercicios de la unidad 5', at(4), 'done'),
    T(6, 4, 'Práctica del tema 5: método del gradiente', at(6), 'pending'),
    T(7, 2, 'Diseño del modelo entidad-relación', at(9), 'pending'),
    T(8, 6, 'Laboratorio: intervalos de confianza 2 (0,5 puntos)', at(11), 'pending'),
    T(9, 3, 'Trabajo final: regresión múltiple', at(24, 12, 0), 'pending'),
    T(10, 5, 'Entregable práctica 3', at(-3), 'done'),
    T(11, 1, 'Ejercicios de la unidad 4 (parte 1)', at(-6), 'done'),
    T(12, 4, 'Práctica del tema 3', at(-12), 'done'),
    T(13, 6, 'Cuaderno de prácticas', 0, 'nodate'),
    T(14, 1, 'Tema 6', at(8, 9, 0), 'pending', '<p>Parcial presencial de los temas 4 a 6 en el aula 1.3. Traed calculadora.</p>'),
    T(15, 2, 'Calificaciones examen parcial 1', at(3), 'pending', '<p>Notas del primer parcial.</p>'),
  ];
  const E = (id, kind, name, course, days, h, dur) => ({ id: 'm' + id, kind, name, course, start: at(days, h, 0), end: at(days, h, 0) + dur * 3600 });
  const events = [
    E(1, 'examen', 'Examen: Optimización Continua', 4, 13, 9, 2), E(2, 'examen', 'Examen: Fundamentos de Bases de Datos', 2, 27, 16, 2),
    E(9, 'actividad', 'Seminario: ciencia de datos en la empresa', 5, 5, 12, 1.5),
    E(3, 'clase', 'Teoría: Álgebra Matricial (1)', 1, 0, 9, 2), E(4, 'clase', 'Práctica: Modelos Lineales (G2)', 3, 0, 11, 2),
    E(5, 'clase', 'Teoría: Estadística Matemática (1)', 6, 1, 9, 2), E(6, 'clase', 'Práctica: Técnicas de Visualización (G1)', 5, 2, 15, 2),
    E(7, 'clase', 'Teoría: Optimización Continua (1)', 4, 3, 11, 2), E(8, 'clase', 'Práctica: Fundamentos de Bases de Datos (G2)', 2, 4, 9, 2),
  ];
  const N = (id, course, subject, hoursAgo, author, html) => ({ id, course, subject, html, author, created: now - hoursAgo * 3600 });
  const d = new Date(); d.setDate(d.getDate() + 18);
  const d2 = new Date(); d2.setDate(d2.getDate() + 15);
  const notices = [
    N(901, 3, 'Fecha del segundo parcial y entrega del cuaderno', 3, 'Prof. Demo', `<p>Buenas tardes:</p><p>El segundo parcial será el <b>${d.getDate()}/${d.getMonth() + 1} a las 10:30</b> en el aula 2.1 del edificio Torretamarit. Entran los temas 4 a 6.</p><p>El cuaderno de ejercicios se entrega en mano el ${d2.getDate()}/${d2.getMonth() + 1} en clase.</p>`),
    N(902, 5, 'Cambio de aula para la práctica del jueves', 20, 'Prof. Demo', '<p>La práctica del jueves se hará en el laboratorio 0.3 en lugar del 1.2.</p>'),
    N(903, 2, 'Publicadas las soluciones de la práctica 2', 52, 'Prof. Demo', '<p>Ya tenéis las soluciones en la sección de materiales.</p>'),
    N(904, 1, 'Tutorías de la próxima semana', 98, 'Prof. Demo', '<p>La semana que viene las tutorías serán el martes de 12:00 a 14:00.</p>'),
  ];
  const examStart = at(18, 10, 30), handIn = at(15, 0, 0);
  return {
    account: { token: 'demo', userid: 1, name: 'Estudiante Demo', auth: 'demo' },
    data: {
      v: 2, courses, tasks, events, notices, forumCache: {}, fetchedAt: now,
      notifs: [{ id: 1, component: 'mod_assign', type: 'feedbackavailable', subject: 'Tu entrega «Entregable práctica 3» ha sido calificada', text: '', url: '', ts: now - 7 * 3600, course: 5 }],
    },
    server: {
      status: 'ok', cadenceMinutes: 10, lastOk: now - 240, version: '1.2.0', keySource: 'secreto',
      ai: { on: true, ok: now - 3 * 3600, by: 'groq:openai/gpt-oss-120b', err: null, providers: ['groq:openai/gpt-oss-120b', 'groq:llama-3.3-70b-versatile', 'cf:@cf/openai/gpt-oss-120b'], paused: [] },
      nst: { 901: 'ia:2', 902: 'ia:0', 903: 'filtro', 904: 'filtro' },
      prefs: { notice: true, feedback: true, rem: { examen: [604800, 86400], entrega: [86400, 10800], actividad: [86400, 3600] } },
      cls: { 14: 'examen', 15: 'info' },
      events: [
        { id: 'd901', type: 'examen', title: 'Segundo parcial', course: 'Modelos Lineales', courseId: 3, start: examStart, end: examStart + 7200, allDay: false, place: 'Aula 2.1, Torretamarit', source: 'ia', noticeId: 901, url: '' },
        { id: 'd901_1', type: 'entrega', title: 'Cuaderno de ejercicios (en mano)', course: 'Modelos Lineales', courseId: 3, start: handIn, end: null, allDay: true, place: '', source: 'ia', noticeId: 901, url: '' },
      ],
      changes: [
        { k: 'det:d901', t: 'detected', kind: 'examen', ts: now - 3 * 3600 + 60, title: 'Segundo parcial', courseId: 3, due: examStart, allDay: false, ref: 'd901' },
        { k: 'det:d901_1', t: 'detected', kind: 'entrega', ts: now - 3 * 3600 + 50, title: 'Cuaderno de ejercicios (en mano)', courseId: 3, due: handIn, allDay: true, ref: 'd901_1' },
        { k: 'task_due:4', t: 'task_due', kind: 'entrega', ts: now - 5 * 3600, title: 'Entregable práctica 4: panel interactivo', courseId: 5, from: at(2, 23, 59), due: at(4, 14, 0), ref: 4 },
        { k: 'task_new:14', t: 'task_new', kind: 'examen', ts: now - 26 * 3600, title: 'Tema 6', courseId: 1, due: at(8, 9, 0), ref: 14 },
        { k: 'task_new:7', t: 'task_new', kind: 'entrega', ts: now - 28 * 3600, title: 'Diseño del modelo entidad-relación', courseId: 2, due: at(9), ref: 7 },
      ],
    },
    local: { changes: [], seenAt: now - 6 * 3600, pushAsked: true },
    ustate: { rev: 1, marks: {}, manual: [{ id: 'demo1', type: 'actividad', title: 'Reunión del grupo de prácticas', course: 5, ts: at(1, 17, 0), allDay: 0, place: 'Biblioteca', note: 'Repartir las partes del panel.' }] },
  };
}

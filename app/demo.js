// Datos inventados para la demostración (?demo). No se conecta a ningún sitio.
export function demoData() {
  const now = Math.floor(Date.now() / 1000);
  const at = (days, h = 23, m = 59) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return Math.floor(d / 1000); };
  const courses = {
    1: { name: 'Álgebra Matricial', color: 0 }, 2: { name: 'Fundamentos de Bases de Datos', color: 1 }, 3: { name: 'Modelos Lineales', color: 2 },
    4: { name: 'Optimización Continua', color: 3 }, 5: { name: 'Técnicas de Visualización', color: 4 }, 6: { name: 'Estadística Matemática', color: 5 },
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
  ];
  const E = (id, kind, name, course, days, h, dur) => ({ id: 'm' + id, kind, name, course, start: at(days, h, 0), end: at(days, h, 0) + dur * 3600, place: '' });
  const events = [
    E(1, 'exam', 'Examen: Optimización Continua', 4, 13, 9, 2), E(2, 'exam', 'Examen: Fundamentos de Bases de Datos', 2, 27, 16, 2),
    E(3, 'class', 'Teoría: Álgebra Matricial (1)', 1, 0, 9, 2), E(4, 'class', 'Práctica: Modelos Lineales (G2)', 3, 0, 11, 2),
    E(5, 'class', 'Teoría: Estadística Matemática (1)', 6, 1, 9, 2), E(6, 'class', 'Práctica: Técnicas de Visualización (G1)', 5, 2, 15, 2),
    E(7, 'class', 'Teoría: Optimización Continua (1)', 4, 3, 11, 2), E(8, 'class', 'Práctica: Fundamentos de Bases de Datos (G2)', 2, 4, 9, 2),
  ];
  const N = (id, course, subject, hoursAgo, author, html) => ({ id, course, subject, html, author, created: now - hoursAgo * 3600 });
  const d = new Date(); d.setDate(d.getDate() + 18);
  const examDay = `${d.getDate()}/${d.getMonth() + 1}`;
  const notices = [
    N(901, 3, 'Fecha del segundo parcial', 3, 'Prof. Demo', `<p>Buenas tardes:</p><p>El segundo parcial será el <b>${examDay} a las 10:30</b> en el aula 2.1 del edificio Torretamarit. Entran los temas 4 a 6.</p><p>Traed calculadora.</p>`),
    N(902, 5, 'Cambio de aula para la práctica del jueves', 20, 'Prof. Demo', '<p>La práctica del jueves se hará en el laboratorio 0.3 en lugar del 1.2.</p>'),
    N(903, 2, 'Publicadas las soluciones de la práctica 2', 52, 'Prof. Demo', '<p>Ya tenéis las soluciones en la sección de materiales.</p>'),
    N(904, 1, 'Tutorías de la próxima semana', 98, 'Prof. Demo', '<p>La semana que viene las tutorías serán el martes de 12:00 a 14:00.</p>'),
  ];
  const examStart = at(18, 10, 30);
  return {
    account: { token: 'demo', userid: 1, name: 'Estudiante Demo' },
    data: {
      courses, tasks, events, notices, forumCache: {}, fetchedAt: now,
      notifs: [{ id: 1, component: 'mod_assign', type: 'feedbackavailable', subject: 'Tienes retroalimentación en Entregable práctica 3', text: '', url: '', ts: now - 7 * 3600, course: 5 }],
    },
    server: {
      status: 'ok', cadenceMinutes: 10, prefs: { task_new: true, task_due: true, notice: true, feedback: true, exam: true },
      events: [{ id: 'd901', title: 'Segundo parcial', course: 'Modelos Lineales', courseId: 3, start: examStart, end: examStart + 7200, allDay: false, place: 'Aula 2.1, Torretamarit', source: 'ia', noticeId: 901, url: '' }],
      changes: [
        { k: 'exam:901', t: 'exam', ts: now - 3 * 3600 + 60, title: 'Segundo parcial', courseId: 3, due: examStart, allDay: false, ref: 'd901' },
        { k: 'task_due:4', t: 'task_due', ts: now - 5 * 3600, title: 'Entregable práctica 4: panel interactivo', courseId: 5, from: at(2, 23, 59), due: at(4, 14, 0), ref: 4 },
        { k: 'task_new:7', t: 'task_new', ts: now - 28 * 3600, title: 'Diseño del modelo entidad-relación', courseId: 2, due: at(9), ref: 7 },
      ],
    },
    local: { changes: [], seenAt: now - 6 * 3600, pushAsked: true },
  };
}

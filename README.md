# Plazo 1.1

Tus entregas, exámenes y actividades del Campus Virtual UMH en una app instalable en el iPhone. Lee los avisos por ti, clasifica lo que publica cada profesor y te recuerda cada cosa con la antelación que elijas. App **no oficial**: no pertenece a la Universidad Miguel Hernández.

Todo funciona con servicios gratuitos: GitHub para guardar el código y Cloudflare para alojar la app, la base de datos, el vigilante y la IA.

## Qué hace

| Necesidad | Cómo lo resuelve |
|---|---|
| Separar lo que tengo que hacer | Tres secciones con color y lugar propios: **entregas** (verde), **exámenes** (rojo) y **actividades** (azul). En «Hoy», la próxima entrega y el próximo examen van en tarjetas distintas |
| Calendario conjunto | Un solo calendario con todo y filtros para elegir qué se ve: entregas, exámenes, actividades y clases |
| Leer los avisos | La IA lee cada aviso nuevo de cada asignatura y añade a la agenda los exámenes, entregas y actividades con fecha que anuncia. Cada elemento enlaza al aviso original |
| Exámenes creados como tarea | La IA mira el nombre y la descripción de cada tarea del campus. Si es un examen, pasa a Exámenes y deja de contar como entrega |
| «Calificaciones examen…» y similares | Lo que el profesor publica sin que tengas que hacer nada se clasifica como informativo: no aparece en pendientes ni se notifica |
| Corregir a la app | En cualquier elemento: «Esto es… Entrega / Examen / Actividad / Nada que hacer» |
| Añadir a mano | Botón **+** en Agenda y Calendario: entrega, examen o actividad con fecha, hora, lugar y notas |
| Atrasadas | Un toque en el círculo de la fila la marca como hecha y sale de pendientes. Se puede deshacer |
| Recordatorios | Por tipo, eliges con cuánta antelación: 1 semana, 3 días, 2 días, 1 día, 12 h, 3 h, 1 h. Varios a la vez o ninguno |
| Novedades | Entrega, examen o actividad nueva y cambio de fecha: se notifican siempre, con la fecha anterior y la nueva |
| Calificaciones | La calificación o retroalimentación de una entrega llega como notificación y queda en Avisos → Notas |
| No pedir el código cada vez | Inicias sesión una vez en la web oficial y la app guarda un acceso (token) del campus |
| Calendario del iPhone | Dos suscripciones desde Ajustes: el calendario del campus, y lo detectado en avisos más lo añadido a mano |

## Cómo está hecho

```
iPhone (app instalada)  ──lee directamente──▶  campus.umh.es (API móvil de Moodle)
        │
        └─ agenda, marcas y preferencias ──▶  Worker de Cloudflare
                                               · guarda tu acceso cifrado (D1)
                                               · cada ~10 min revisa el campus por ti
                                               · IA: clasifica tareas y lee avisos
                                               · envía recordatorios y novedades (push)
```

- `app/`: la app (HTML, CSS y JavaScript sin dependencias ni compilación).
- `worker/index.js`: la API, el vigilante, la IA y los recordatorios.
- `tests/`: pruebas del Worker y de la interfaz.
- `wrangler.toml`: configuración de Cloudflare.

Cómo decide la app el tipo de cada cosa, por orden: lo que tú hayas corregido a mano; la clasificación de la IA; reglas sobre el nombre (por ejemplo, «Calificaciones…» es informativo y «Examen parcial…» es un examen). La IA clasifica cada tarea y lee cada aviso una sola vez para todos los compañeros de la asignatura, así el cupo gratuito rinde mucho más.

## Actualizar desde la versión 1.0

Sustituye en tu repositorio de GitHub estos archivos por los nuevos. **No toques `wrangler.toml`**: el tuyo contiene el identificador de tu base de datos.

| Archivo | Qué cambia |
|---|---|
| `app/app.js` | Toda la app: tipos, agenda, añadir a mano, marcar como hecha, recordatorios |
| `app/app.css` | Estilos de lo anterior |
| `app/demo.js` | Demostración actualizada |
| `app/sw.js` | Fuerza la descarga de la versión nueva en cada dispositivo |
| `worker/index.js` | IA, recordatorios, clave automática y actualización de la base de datos |
| `tests/…`, `README.md` | Opcionales |

En GitHub: **Add file → Upload files**, arrastra las carpetas `app`, `worker` y `tests` de la actualización y pulsa **Commit changes**. Cloudflare despliega solo en un par de minutos. La base de datos se actualiza sola en la primera petición.

En el iPhone: abre Plazo, ciérrala del todo y vuelve a abrirla. En Ajustes debe aparecer «Plazo 1.1.0».

## Puesta en marcha desde cero (unos 20 minutos, sin instalar nada)

1. **GitHub.** Crea una cuenta, pulsa **New repository** (`plazo-umh`, puede ser privado), elige **uploading an existing file** y arrastra el contenido de esta carpeta.
2. **Base de datos.** En dash.cloudflare.com (plan gratuito): **Storage & Databases → D1 SQL Database → Create**, nombre `plazo-umh`. Copia el **Database ID** y pégalo en `wrangler.toml` (lápiz en GitHub) en lugar de `PEGA-AQUI-EL-ID-DE-TU-BASE-DE-DATOS`.
3. **Despliegue.** **Workers & Pages → Create → Import a repository**, conecta GitHub solo con ese repositorio. El proyecto debe llamarse `plazo-umh`, igual que en `wrangler.toml`. Comando de despliegue: `npx wrangler deploy`.
4. **Clave de cifrado (recomendado).** En el Worker: **Settings → Variables and Secrets → Add**, tipo **Secret**, nombre `MASTER_KEY`, un texto aleatorio de 16 caracteres o más. Si no la pones, el servidor crea una clave automática y la guarda en la base de datos: funciona igual, pero la clave queda junto a los datos que protege. Ponla antes de que entren usuarios; si la cambias después, todos tendrán que volver a conectar.
5. **iPhone.** Abre la dirección en Safari → **Compartir → Añadir a pantalla de inicio** → abre Plazo desde el icono → sigue los tres pasos → tus iniciales (arriba a la derecha) → **Avisarme en este dispositivo**.

Comprobación: `https://TU-DIRECCION/api/config` debe mostrar `"ready":true`. Para probar sin cuenta, añade `?demo` a la dirección.

## Cómo se conecta al campus

El campus solo permite entrar por el inicio de sesión único de la UMH, con su segundo factor. Plazo no pide ni ve tu contraseña: abre la página oficial que usa la app móvil del campus, y esa página entrega un enlace `moodlemobile://token=…` con un acceso de solo esa cuenta.

- El código de un solo uso se pide solo en ese momento.
- La duración del acceso la decide la UMH. Cuando caduque, la app y una notificación te pedirán repetir los tres pasos.
- Puedes revocarlo en el campus: **Preferencias → Claves de seguridad**.

## Límites que conviene conocer

- **Precisión de unos 10 minutos.** El vigilante revisa a un usuario por minuto y deja al menos 10 minutos entre dos revisiones de la misma persona; con 60 usuarios, cada uno se revisa cada hora. Un recordatorio de «1 hora antes» puede llegar con ese retraso. Es el precio del plan gratuito.
- **La IA se equivoca a veces.** Por eso todo lo detectado indica su origen, enlaza al aviso y se corrige con un toque. Lo que tú corriges manda siempre.
- **Lectura inicial gradual.** Al darte de alta se leen los avisos de los últimos 45 días, tres por revisión, sin notificarlos.
- **Cupo diario de IA.** Si se agota o falla, se usan reglas; Ajustes → Servidor de Plazo muestra el estado.
- **«Entregada» es una deducción.** El campus marca qué tareas requieren acción; las que ya no la requieren se muestran como entregadas. Antes de recordarte una entrega, el servidor comprueba en el campus que no esté ya enviada.
- **Comentarios en una entrega**: llegan cuando el campus genera una notificación. Los hilos que el campus no notifica no se vigilan.

## Privacidad y responsabilidad

Si compartes tu dirección con otros estudiantes, tu cuenta de Cloudflare guarda datos suyos y eres responsable de ellos.

- **Qué se guarda en el servidor**: acceso al campus cifrado, nombre, suscripción push, lista de tareas con sus fechas y tipo, agenda para los recordatorios, lo añadido a mano, lo marcado como hecho u oculto, identificadores de avisos vistos y las últimas novedades.
- **Qué no se guarda**: contraseñas, códigos de un solo uso ni el texto completo de los avisos.
- **Qué se envía a la IA** (Workers AI de Cloudflare): el texto de los avisos que mencionan fechas, y el nombre y principio de la descripción de las tareas dudosas. Sin nombres de estudiantes.
- **Sin servidor**: Ajustes → «Usar solo este dispositivo» borra los datos del servidor. Se pierden la IA, los recordatorios y las notificaciones; la app sigue clasificando por reglas.
- **Borrado total**: Ajustes → «Desconectar y borrar mis datos».
- Antes de difundirla, cuéntaselo a los Servicios Informáticos de la UMH. Usa la misma API que la app oficial, pero la universidad puede tener normas sobre apps de terceros.
- No uses el nombre ni el logotipo de la UMH de forma que parezca una app oficial.

## Qué está probado y qué no

Probado:

- Contra el campus real, con una sesión de estudiante: la API móvil (Moodle 4.5) devuelve tareas, plazos, avisos, notificaciones, calendario y estado de entrega con el formato que usa la app.
- 23 pruebas automáticas del Worker (`npm test`): cifrado Web Push contra el vector del RFC 8291, clave automática, actualización de una base de datos de la versión 1, registro y sesiones, clasificación por reglas y con IA, lectura de avisos, novedades por tipo, recordatorios (una sola vez, con antelación, y no si ya está entregada), preferencias, calendario `.ics`, caducidad del acceso y borrado de cuenta.
- La interfaz en un navegador con tamaño de iPhone, con campus y servidor simulados: conexión, tipos, marcar como hecha, reclasificar, añadir a mano, filtros del calendario, recordatorios y filtrado de HTML peligroso.

Sin probar, porque requiere tu despliegue y un iPhone:

- La IA real de Cloudflare con avisos reales: las pruebas usan una IA simulada. La calidad de la clasificación hay que verla con tus asignaturas.
- La llegada de notificaciones push a un iPhone y el consumo real de CPU en el plan gratuito.

## Si algo falla

| Síntoma | Qué mirar |
|---|---|
| «No se pudo conectar con el servidor de Plazo» | Abre `/api/config`. Si no dice `"ready":true`, el campo `reason` explica qué falta |
| Error 503 «Falta la base de datos» | El `database_id` de `wrangler.toml` no es el de tu D1 |
| Ajustes sigue diciendo 1.0 | Cierra la app del todo y ábrela dos veces. Si no, borra el icono y vuelve a añadirla desde Safari |
| «Lectura con IA: con fallos» | El mensaje indica el motivo (cupo agotado, modelo no disponible). Puedes fijar otro modelo con la variable `AI_MODEL` |
| No aparece el interruptor de notificaciones o da error | La app debe estar instalada en la pantalla de inicio y abierta desde el icono |
| No llegan notificaciones | Worker → **Logs**: cada revisión escribe una línea `revisión …`. Si aparece «Exceeded CPU», sube `POLL_MINUTES` |
| Algo está mal clasificado | Ábrelo y elige el tipo correcto en «Esto es…» |

## Desarrollo

```
npm test                                   # pruebas del Worker (Node 22 o posterior)
cd app && python3 -m http.server 8765      # app en local; abre http://localhost:8765/?demo
python3 tests/ui_demo.py                   # capturas de la interfaz (requiere Playwright)
python3 tests/ui_real.py                   # flujo completo con campus y servidor simulados
```

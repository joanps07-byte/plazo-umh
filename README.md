# Plazo

Tus tareas, exámenes y avisos del Campus Virtual UMH en una app instalable en el iPhone, con notificaciones cuando algo cambia. App **no oficial**: no pertenece a la Universidad Miguel Hernández.

Todo funciona con servicios gratuitos: GitHub para guardar el código y Cloudflare para alojar la app, la base de datos, el vigilante y la IA.

## Qué hace

| Necesidad | Cómo lo resuelve |
|---|---|
| Aviso de tarea nueva | El vigilante compara tus tareas con la revisión anterior y envía una notificación push |
| Aviso de cambio de plazo | Igual, mostrando la fecha anterior y la nueva. La tarea conserva el historial del cambio |
| Avisos, comentarios y retroalimentación | Lee los foros de avisos de cada asignatura y las notificaciones del campus |
| Calendario | Mes con marcas por asignatura, agenda del día y carga de los próximos 14 días. Incluye los exámenes y clases del calendario del campus |
| Exámenes en avisos | La IA lee cada aviso nuevo; si convoca un examen con fecha, lo añade al calendario marcado como «detectado» |
| No pedir el código cada vez | Inicias sesión una vez en la web oficial y la app guarda un acceso (token) del campus |
| Calendario del iPhone | Dos suscripciones desde Ajustes: entregas y clases del campus, y exámenes detectados |

## Cómo está hecho

```
iPhone (app instalada)  ──lee directamente──▶  campus.umh.es (API móvil de Moodle)
        │
        └─ solo si activas notificaciones ─▶  Worker de Cloudflare
                                               · guarda tu acceso cifrado (D1)
                                               · cada ~10 min revisa el campus por ti
                                               · IA lee los avisos nuevos
                                               · envía la notificación push
```

- `app/`: la app (HTML, CSS y JavaScript sin dependencias ni compilación).
- `worker/index.js`: la API y el vigilante.
- `tests/`: pruebas del Worker y de la interfaz.
- `wrangler.toml`: configuración de Cloudflare.

## Puesta en marcha (unos 20 minutos, sin instalar nada)

### 1. Sube el código a GitHub

1. Crea una cuenta en github.com y pulsa **New repository**. Nombre: `plazo-umh`. Puede ser privado.
2. En el repositorio vacío elige **uploading an existing file** y arrastra **el contenido** de esta carpeta (`app`, `worker`, `tests`, `wrangler.toml`, `package.json`, `README.md`, `.gitignore`). Pulsa **Commit changes**.

### 2. Crea la base de datos

1. Crea una cuenta en dash.cloudflare.com (plan gratuito, sin tarjeta).
2. Ve a **Storage & Databases → D1 SQL Database → Create**. Nombre: `plazo-umh`.
3. Copia el **Database ID**.
4. En GitHub abre `wrangler.toml`, pulsa el lápiz, sustituye `PEGA-AQUI-EL-ID-DE-TU-BASE-DE-DATOS` por ese identificador y guarda. Las tablas se crean solas la primera vez.

### 3. Despliega

1. En Cloudflare ve a **Workers & Pages → Create → Import a repository** y conecta tu GitHub, dando acceso solo al repositorio `plazo-umh`.
2. El nombre del proyecto debe ser exactamente `plazo-umh` (el mismo que en `wrangler.toml`). Deja el comando de despliegue por defecto, `npx wrangler deploy`.
3. Pulsa **Save and Deploy**. Al terminar tendrás una dirección del tipo `https://plazo-umh.TU-SUBDOMINIO.workers.dev`.

### 4. Añade la clave maestra

1. En el Worker ve a **Settings → Variables and Secrets → Add**.
2. Tipo **Secret**, nombre `MASTER_KEY`, valor: un texto aleatorio de 24 caracteres o más (usa un generador de contraseñas). Guárdalo en un lugar seguro y no lo cambies: con él se cifran los accesos al campus.
3. Pulsa **Deploy**.

Comprueba que todo está bien abriendo `https://TU-DIRECCION/api/config`: debe aparecer `"ready":true`.

### 5. Instálala en el iPhone

1. Abre tu dirección en **Safari**.
2. Pulsa **Compartir → Añadir a pantalla de inicio**. Las notificaciones solo funcionan con la app instalada así (iOS 16.4 o posterior).
3. Abre Plazo desde el icono y sigue los tres pasos: entrar en el campus, copiar el enlace de acceso y pegarlo.
4. Pulsa tus iniciales (arriba a la derecha) → **Avisarme en este dispositivo** → **Enviar una notificación de prueba**.

Para tus compañeros basta con pasarles la dirección: cada uno conecta su propia cuenta.

Para probar la app sin cuenta, añade `?demo` a la dirección.

## Cómo se conecta al campus

El campus solo permite entrar por el inicio de sesión único de la UMH, con su segundo factor. Plazo no pide ni ve tu contraseña: abre la página oficial que usa la app móvil del campus, y esa página entrega un enlace `moodlemobile://token=…` con un acceso de solo esa cuenta. Al pegarlo, la app lo guarda en el dispositivo.

- El código de un solo uso se pide solo en ese momento. Mientras el acceso sea válido, no vuelve a pedirse.
- La duración del acceso la decide la UMH y no se puede consultar desde fuera. Cuando caduque, la app y una notificación te pedirán repetir los tres pasos.
- Puedes revocarlo cuando quieras en el campus: **Preferencias → Claves de seguridad**.

## Límites que conviene conocer

- **No es instantáneo.** El vigilante revisa a un usuario por minuto y deja al menos 10 minutos entre dos revisiones de la misma persona. Con 10 usuarios, cada uno se revisa cada 10 minutos; con 60, cada hora aproximadamente. Es el precio del plan gratuito, que limita el tiempo de cálculo de cada ejecución.
- **La primera revisión no avisa de nada**: solo toma la foto inicial. A partir de la segunda, notifica los cambios.
- **Los exámenes detectados pueden fallar.** Se extraen del texto de un aviso. La app lo indica y enlaza al aviso original; se pueden quitar con un toque.
- **«Entregada» es una deducción.** El campus marca qué tareas requieren acción; las que ya no la requieren se muestran como entregadas.
- **Comentarios en una entrega**: llegan cuando el campus genera una notificación (por ejemplo, retroalimentación o nota). Los hilos de comentarios que el campus no notifica no se vigilan.
- **IA gratuita con cupo diario.** Si se agota o falla, la detección de exámenes sigue con reglas (fechas escritas en el texto).

## Privacidad y responsabilidad

Si compartes tu dirección con otros estudiantes, tu cuenta de Cloudflare guarda datos suyos. Eres responsable de ellos.

- **Qué se guarda en el servidor** (solo de quien activa las notificaciones): su acceso al campus cifrado con `MASTER_KEY`, su nombre, la suscripción push, la lista de tareas con sus fechas, los identificadores de avisos vistos, los exámenes detectados y las últimas novedades.
- **Qué no se guarda**: contraseñas, códigos de un solo uso ni el texto completo de los avisos.
- **A quién se envía texto de avisos**: a Workers AI de Cloudflare, solo los avisos que mencionan una evaluación.
- **Borrado**: Ajustes → «Desconectar y borrar mis datos» elimina la fila del usuario.
- Antes de difundirla, cuéntaselo a los Servicios Informáticos de la UMH. Usa la misma API que la app oficial, pero la universidad puede tener normas sobre apps de terceros, y te conviene que lo sepan por ti.
- No uses el nombre ni el logotipo de la UMH de forma que parezca una app oficial.

## Qué está probado y qué no

Probado:

- Contra el campus real, con una sesión de estudiante: la API móvil está activa (Moodle 4.5), permite llamadas desde una web, y devuelve tareas, plazos, avisos, notificaciones, calendario y el enlace de acceso con el formato que usa la app.
- 17 pruebas automáticas del Worker (`npm test`): cifrado Web Push contra el vector oficial del RFC 8291, registro, sesiones, detección de cambios, agrupación de notificaciones, exámenes con IA y con reglas, calendario `.ics`, caducidad del acceso y borrado de cuenta.
- La interfaz en un navegador con tamaño de iPhone, en modo claro y oscuro, con un campus simulado, incluido el filtrado de HTML peligroso en avisos.

Sin probar todavía, porque requiere tu despliegue y un iPhone:

- El despliegue en Cloudflare y el consumo real de CPU del vigilante en el plan gratuito.
- La llegada de notificaciones push a un iPhone.
- El paso de «mantener pulsado → Copiar enlace» en Safari de iOS.

## Si algo falla

| Síntoma | Qué mirar |
|---|---|
| `/api/config` dice `"ready":false` | Falta el secreto `MASTER_KEY` o tiene menos de 24 caracteres |
| Error 503 «Falta la base de datos» | El `database_id` de `wrangler.toml` no es el de tu D1 |
| El despliegue falla por el nombre | El proyecto en Cloudflare debe llamarse igual que `name` en `wrangler.toml` |
| No aparece el interruptor de notificaciones o da error | La app debe estar instalada en la pantalla de inicio y abierta desde el icono |
| No llegan notificaciones | Worker → **Logs**: cada revisión escribe una línea `revisión …`. Si aparece «Exceeded CPU», sube `POLL_MINUTES` |
| «El campus ha rechazado el enlace» | El enlace copiado está incompleto o el acceso fue revocado: repite los tres pasos |

## Desarrollo

```
npm test                                   # pruebas del Worker (Node 22 o posterior)
cd app && python3 -m http.server 8765      # app en local; abre http://localhost:8765/?demo
python3 tests/ui_demo.py                   # capturas de la interfaz (requiere Playwright)
python3 tests/ui_real.py                   # flujo completo con un campus simulado
```

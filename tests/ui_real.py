# Flujo real con un campus y un servidor simulados (requiere Playwright y la app servida en localhost:8765).
import asyncio, base64, json, time, urllib.parse
from playwright.async_api import async_playwright
TOKEN = 'ab12' * 8
now = int(time.time())
D = 86400
state = {'valid': True, 'due2': now + 3 * D}
srv = {'sync': [], 'prefs': [], 'registered': 0}
def reply(fn, form):
    if form.get('wstoken') != TOKEN or not state['valid']:
        return {'exception': 'moodle_exception', 'errorcode': 'invalidtoken', 'message': 'Token no válido'}
    A = lambda i, name, due, intro='': {'id': i, 'cmid': 10 + i, 'name': name, 'duedate': due, 'allowsubmissionsfromdate': 0, 'cutoffdate': 0, 'timemodified': now, 'intro': intro}
    if fn == 'core_webservice_get_site_info': return {'userid': 77, 'fullname': 'Ana Prueba García', 'siteurl': 'https://campus.umh.es'}
    if fn == 'mod_assign_get_assignments':
        return {'courses': [{'id': 5, 'fullname': 'MODELOS LINEALES (2345_Grado en Estadística Curso 2026/2027)', 'assignments': [
            A(1, 'Práctica 1', now - 5 * D, '<p>Hecha</p>'),
            A(2, 'Práctica 2 <script>window.__xss=1</script>', state['due2'], '<p onclick="window.__xss=1">Texto <img src=x onerror="window.__xss=1"> <a href="javascript:window.__xss=1">malo</a> <a href="https://umh.es">bueno</a></p><script>window.__xss=1</script><iframe src="https://evil.example"></iframe>'),
            A(3, 'Sin fecha', 0), A(4, 'Tema 6', now + 2 * D, '<p>Parcial presencial</p>'), A(5, 'Publicación del profesor', now + 4 * D),
            A(6, 'Calificaciones examen parcial 1', now + 1 * D), A(7, 'Examen parcial 2', now + 6 * D), A(8, 'Práctica atrasada', now - 2 * D)]},
            {'id': 6, 'fullname': 'Álgebra Matricial (1234_Grado Curso 2026/2027)', 'assignments': []}]}
    if fn == 'core_calendar_get_action_events_by_timesort':
        ev = lambda cm, ts: {'id': 900 + cm, 'modulename': 'assign', 'instance': cm, 'timesort': ts, 'url': f'https://campus.umh.es/mod/assign/view.php?id={cm}'}
        return {'events': [ev(12, state['due2']), ev(14, now + 2 * D), ev(15, now + 4 * D), ev(16, now + D), ev(17, now + 6 * D), ev(18, now - 2 * D)]}
    if fn == 'mod_forum_get_forums_by_courses': return [{'id': 50, 'course': 5, 'type': 'news', 'numdiscussions': 1}, {'id': 51, 'course': 6, 'type': 'news', 'numdiscussions': 0}]
    if fn == 'mod_forum_get_forum_discussions': return {'discussions': [{'discussion': 800, 'subject': 'Aviso de prueba', 'message': '<p>Hola <b>clase</b></p><img src=x onerror="window.__xss=1">', 'userfullname': 'Prof. X', 'created': now - 3600}]}
    if fn == 'message_popup_get_popup_notifications':
        return {'notifications': [{'id': 1, 'component': 'mod_assign', 'eventtype': 'assign_notification', 'subject': 'Usted ha realizado su entrega', 'customdata': '{"messagetype":"submissionreceipt"}', 'timecreated': now - 100},
                                  {'id': 2, 'component': 'mod_assign', 'eventtype': 'assign_notification', 'subject': 'Tu entrega de Práctica 1 ha sido calificada', 'customdata': '{"messagetype":"feedbackavailable","courseid":5}', 'timecreated': now - 50, 'contexturl': 'https://campus.umh.es/mod/assign/view.php?id=11'}]}
    if fn == 'core_calendar_get_calendar_export_token': return {'token': 'c' * 40}
    if fn == 'core_calendar_get_calendar_events':
        E = lambda i, name, ts, mod='': {'id': i, 'name': name, 'courseid': 5, 'modulename': mod, 'eventtype': 'course', 'timestart': ts, 'timeduration': 7200}
        return {'events': [E(1, 'Examen: Modelos Lineales', now + 10 * D), E(2, 'Teoría: Modelos Lineales (1)', now + D), E(3, 'Práctica 2', state['due2'], 'assign'), E(4, 'Seminario: datos abiertos', now + 8 * D)]}
    return {'exception': 'x', 'errorcode': 'unknown', 'message': fn}
async def campus(route):
    form = dict(urllib.parse.parse_qsl(route.request.post_data or ''))
    await route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps(reply(form.get('wsfunction'), form)))
async def server(route):
    path = urllib.parse.urlparse(route.request.url).path
    body = json.loads(route.request.post_data) if route.request.post_data else None
    out = {'ok': True}
    if path == '/api/config': out = {'ready': True, 'vapidPublicKey': 'x', 'version': '1.1.0', 'ai': True, 'keySource': 'auto'}
    elif path == '/api/register': srv['registered'] += 1; out = {'auth': '77.firma', 'feedPath': '/cal/77-secreto.ics'}
    elif path == '/api/feed':
        out = {'status': 'ok', 'changes': [], 'cls': {'4': 'examen', '5': 'info'}, 'devices': 0, 'lastOk': now - 120, 'cadenceMinutes': 10, 'feedPath': '/cal/77-secreto.ics', 'version': '1.1.0', 'keySource': 'auto',
               'ai': {'on': True, 'ok': now - 600, 'err': None}, 'ustate': {'rev': 0, 'manual': [], 'marks': {}}, 'prefs': {'notice': True, 'feedback': True, 'rem': {'examen': [604800, 86400], 'entrega': [86400, 10800], 'actividad': [86400, 3600]}},
               'events': [{'id': 'd800', 'type': 'examen', 'title': 'Parcial sorpresa', 'course': 'Modelos Lineales', 'courseId': 5, 'start': now + 12 * D, 'end': None, 'allDay': True, 'source': 'ia', 'noticeId': 800, 'url': 'https://campus.umh.es/mod/forum/discuss.php?d=800'},
                          {'id': 'd800_1', 'type': 'examen', 'title': 'Duplicado del calendario', 'course': 'Modelos Lineales', 'courseId': 5, 'start': now + 10 * D + 60, 'end': None, 'allDay': False, 'source': 'ia', 'noticeId': 800, 'url': ''}]}
    elif path == '/api/sync': srv['sync'].append(body)
    elif path == '/api/prefs': srv['prefs'].append(body); out = {'ok': True, 'prefs': body['prefs']}
    await route.fulfill(status=200, content_type='application/json', body=json.dumps(out))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='es-ES', timezone_id='Europe/Madrid', service_workers='block')
        page = await ctx.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await page.route('https://campus.umh.es/**', campus)
        await page.route('**/api/**', server)
        txt = lambda sel: page.inner_text(sel)
        await page.goto('http://localhost:8765/'); await page.wait_for_selector('.welcome')
        href = await page.get_attribute('.steps a.btn', 'href'); assert 'launch.php?service=moodle_mobile_app' in href and 'urlscheme=moodlemobile' in href, href
        await page.fill('#token', 'cualquier cosa'); await page.click('#connect-btn'); assert 'no parece' in await txt('#connect-error')
        link = 'moodlemobile://token=' + base64.b64encode(f'{"0"*32}:::{TOKEN}:::{"f"*64}'.encode()).decode()
        await page.fill('#token', link); await page.click('#connect-btn'); await page.wait_for_selector('.tabs', timeout=8000)
        acct = await page.evaluate("JSON.parse(localStorage.getItem('plazo.account'))")
        assert acct['token'] == TOKEN and acct['auth'] == '77.firma' and acct['calToken'] == 'c' * 40 and srv['registered'] == 1, acct
        # Hoy: la próxima entrega y el próximo examen van por separado; la tarea «Tema 6» es un examen según la IA
        e = await txt('.duo .t-entrega'); x = await txt('.duo .t-examen')
        assert 'Próxima entrega' in e and 'Práctica 2' in e and 'Modelos Lineales' in e, e
        assert 'Próximo examen' in x and 'Tema 6' in x and '2' in x, x
        assert 'Fuera de plazo (1)' in await txt('.screen') and await txt('.me') == 'AP'
        # Agenda → Entregas: ni exámenes ni publicaciones del profesor
        await page.click('.tab[data-view="agenda"]'); t = await txt('#list')
        assert 'Práctica 2' in t and 'Práctica atrasada' in t, t
        assert all(s not in t for s in ['Práctica 1', 'Tema 6', 'Calificaciones', 'Publicación', 'Examen parcial 2']), t
        assert (await txt('.types [data-type="entrega"] b')) == '2' and (await txt('.types [data-type="examen"] b')) == '4' and (await txt('.types [data-type="actividad"] b')) == '1'
        # Marcar la atrasada como hecha
        await page.click('.check[data-key="a:8"]'); t = await txt('#list'); assert 'Práctica atrasada' not in t, t
        await page.click('[data-filter="hechas"]'); t = await txt('#list'); assert 'Práctica atrasada' in t and 'Hecha' in t and 'Práctica 1' in t and 'Entregada' in t, t
        await page.click('[data-filter="todas"]'); t = await txt('#list'); assert 'No requieren acción (2)' in t and 'Calificaciones examen parcial 1' in t and 'Sin fecha' in t, t
        # Contenido del campus saneado
        await page.click('.row-main[data-key="a:2"]'); await page.wait_for_selector('.sheet .rich')
        rich = await page.inner_html('.sheet .rich')
        assert all(s not in rich for s in ['onclick', 'onerror', 'javascript:', '<script', '<iframe', '<img']), rich
        assert 'href="https://umh.es"' in rich and 'rel="noopener noreferrer"' in rich, rich
        await page.keyboard.press('Escape')
        # Exámenes: tarea clasificada por IA, por reglas, calendario del campus y aviso; el duplicado del mismo día no aparece
        await page.click('.types [data-type="examen"]'); t = await txt('#list')
        assert all(s in t for s in ['Tema 6', 'Examen parcial 2', 'Examen: Modelos Lineales', 'Parcial sorpresa']) and 'Duplicado' not in t, t
        await page.click('.row-main[data-key="a:4"]'); s = await txt('.sheet'); assert 'clasificado esta tarea del campus como examen (IA)' in s, s
        await page.keyboard.press('Escape')
        # Corregir a mano: «Examen parcial 2» pasa a ser una entrega
        await page.click('.row-main[data-key="a:7"]'); await page.click('.sheet [data-act="retype"][data-type="entrega"]'); await page.keyboard.press('Escape')
        assert 'Examen parcial 2' not in await txt('#list')
        await page.click('.types [data-type="entrega"]'); await page.click('[data-filter="pendientes"]'); assert 'Examen parcial 2' in await txt('#list')
        # Añadir a mano una actividad
        await page.click('.icon-btn.add'); await page.click('.form [data-type="actividad"]')
        await page.click('[data-act="save-item"]'); assert 'título' in await txt('#f-error')
        await page.fill('#f-title', 'Visita al laboratorio'); day = time.strftime('%Y-%m-%d', time.localtime(now + 5 * D))
        await page.fill('#f-date', day); await page.fill('#f-time', '12:30'); await page.select_option('#f-course', '5'); await page.fill('#f-place', 'Edificio Torretamarit')
        await page.click('[data-act="save-item"]'); t = await txt('#list'); assert 'Visita al laboratorio' in t and 'Seminario: datos abiertos' in t and 'Teoría' not in t, t
        await page.click('.row-main[data-key^="u:"]'); s = await txt('.sheet'); assert 'Añadido por ti' in s and 'Torretamarit' in s and '12:30' in s, s
        await page.keyboard.press('Escape')
        # Calendario conjunto con filtros
        await page.click('.tab[data-view="calendario"]')
        n_all = await page.locator('.cal .marks i.t-examen').count(); assert n_all >= 1
        await page.click('.filters [data-type="examen"]'); assert await page.locator('.cal .marks i.t-examen').count() == 0
        await page.click('.filters [data-type="examen"]'); assert await page.locator('.cal .marks i.t-examen').count() == n_all
        # Avisos: aviso del profesor y calificación; el justificante de entrega no
        await page.click('.tab[data-view="avisos"]'); f = await txt('.screen'); assert 'Aviso de prueba' in f and 'ha sido calificada' in f and 'Usted ha realizado' not in f, f
        await page.click('.row-main[data-act="notice"]'); s = await txt('.sheet'); assert 'Añadido a tu agenda desde este aviso' in s and 'Parcial sorpresa' in s, s
        await page.keyboard.press('Escape')
        assert await page.evaluate('window.__xss') is None, 'se ejecutó HTML del campus'
        # Sincronización con el servidor: agenda para recordatorios y estado del usuario
        await page.wait_for_timeout(1600); last = srv['sync'][-1]; keys = {i['k']: i for i in last['agenda']}
        assert keys['a:4']['t'] == 'examen' and keys['a:7']['t'] == 'entrega' and keys['a:2']['a'] == 2 and keys['a:2']['c'] == 5, keys
        assert 'a:8' not in keys and 'a:6' not in keys and 'a:5' not in keys and 'm2' not in keys and 'd800_1' not in keys and 'd800' in keys and 'm4' in keys, list(keys)
        assert last['ustate']['marks']['a:8'] == {'done': 1} and last['ustate']['marks']['a:7'] == {'type': 'entrega'} and last['ustate']['manual'][0]['title'] == 'Visita al laboratorio', last['ustate']
        # Ajustes: recordatorios por tipo
        await page.click('.me'); s = await txt('.sheet'); assert 'Recordarme antes de' in s and 'Revisa el campus cada 10 min' in s and 'Activa · última lectura' in s, s
        assert await page.get_attribute('.rem.t-examen [data-off="604800"]', 'aria-pressed') == 'true'
        await page.click('.rem.t-examen [data-off="10800"]'); await page.click('.rem.t-actividad [data-off="3600"]'); await page.click('[data-pref="notice"]'); await page.wait_for_timeout(200)
        assert srv['prefs'][-1]['prefs'] == {'notice': False, 'feedback': True, 'rem': {'examen': [604800, 86400, 10800], 'entrega': [86400, 10800], 'actividad': [86400]}}, srv['prefs'][-1]
        h = await page.inner_html('.sheet'); assert 'webcal://campus.umh.es/calendar/export_execute.php?userid=77&amp;authtoken=' + 'c' * 40 in h and '/cal/77-secreto.ics' in h
        await page.keyboard.press('Escape')
        # Cambio de fecha detectado en el dispositivo
        state['due2'] = now + 5 * D
        await page.click('#refresh'); await page.wait_for_timeout(900)
        await page.click('.tab[data-view="avisos"]'); await page.click('[data-filter="cambio"]'); f = await txt('.screen'); assert 'Fecha cambiada: Práctica 2' in f, f
        # Token caducado
        state['valid'] = False
        await page.click('#refresh'); await page.wait_for_selector('.banner >> text=ha caducado', timeout=5000)
        await page.click('[data-act="reconnect"]'); await page.wait_for_selector('.welcome')
        state['valid'] = True
        await page.fill('#token', TOKEN); await page.click('#connect-btn'); await page.wait_for_selector('.tabs', timeout=5000)
        assert await page.locator('.banner:not(.info)').count() == 0
        # Lo marcado y lo añadido a mano sigue ahí tras recargar
        await page.reload(); await page.wait_for_selector('.tabs'); await page.click('.tab[data-view="agenda"]'); await page.click('.types [data-type="actividad"]'); assert 'Visita al laboratorio' in await txt('#list')
        print('flujo real OK · errores:', errors)
        await b.close()
asyncio.run(main())

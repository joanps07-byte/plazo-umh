# Flujo real con un campus simulado: pegar enlace → conectar → cargar → vistas → caducidad del token.
import asyncio, base64, json, time, urllib.parse
from playwright.async_api import async_playwright
TOKEN = 'ab12' * 8
now = int(time.time())
state = {'valid': True, 'due2': now + 3 * 86400}
def reply(fn, form):
    if form.get('wstoken') != TOKEN or not state['valid']:
        return {'exception': 'moodle_exception', 'errorcode': 'invalidtoken', 'message': 'Token no válido'}
    if fn == 'core_webservice_get_site_info': return {'userid': 77, 'fullname': 'Ana Prueba García', 'siteurl': 'https://campus.umh.es'}
    if fn == 'mod_assign_get_assignments':
        return {'courses': [{'id': 5, 'fullname': 'MODELOS LINEALES (2345_Grado en Estadística Curso 2026/2027)', 'assignments': [
            {'id': 1, 'cmid': 11, 'name': 'Práctica 1', 'duedate': now - 5 * 86400, 'allowsubmissionsfromdate': 0, 'cutoffdate': 0, 'timemodified': now, 'intro': '<p>Hecha</p>'},
            {'id': 2, 'cmid': 12, 'name': 'Práctica 2 <script>window.__xss=1</script>', 'duedate': state['due2'], 'allowsubmissionsfromdate': 0, 'cutoffdate': 0, 'timemodified': now, 'intro': '<p onclick="window.__xss=1">Texto <img src=x onerror="window.__xss=1"> <a href="javascript:window.__xss=1">malo</a> <a href="https://umh.es">bueno</a></p><script>window.__xss=1</script><iframe src="https://evil.example"></iframe>'},
            {'id': 3, 'cmid': 13, 'name': 'Sin fecha', 'duedate': 0, 'timemodified': now, 'intro': ''}]},
            {'id': 6, 'fullname': 'Álgebra Matricial (1234_Grado Curso 2026/2027)', 'assignments': []}]}
    if fn == 'core_calendar_get_action_events_by_timesort':
        return {'events': [{'id': 900, 'modulename': 'assign', 'instance': 12, 'timesort': state['due2'], 'url': 'https://campus.umh.es/mod/assign/view.php?id=12'}]}
    if fn == 'mod_forum_get_forums_by_courses': return [{'id': 50, 'course': 5, 'type': 'news', 'numdiscussions': 1}, {'id': 51, 'course': 6, 'type': 'news', 'numdiscussions': 0}]
    if fn == 'mod_forum_get_forum_discussions': return {'discussions': [{'discussion': 800, 'subject': 'Aviso de prueba', 'message': '<p>Hola <b>clase</b></p><img src=x onerror="window.__xss=1">', 'userfullname': 'Prof. X', 'created': now - 3600}]}
    if fn == 'message_popup_get_popup_notifications':
        return {'notifications': [{'id': 1, 'component': 'mod_assign', 'eventtype': 'assign_notification', 'subject': 'Usted ha realizado su entrega', 'customdata': '{"messagetype":"submissionreceipt"}', 'timecreated': now - 100},
                                  {'id': 2, 'component': 'mod_assign', 'eventtype': 'assign_notification', 'subject': 'Retroalimentación disponible en Práctica 1', 'customdata': '{"messagetype":"feedbackavailable","courseid":5}', 'timecreated': now - 50, 'contexturl': 'https://campus.umh.es/mod/assign/view.php?id=11'}]}
    if fn == 'core_calendar_get_calendar_export_token': return {'token': 'c' * 40}
    if fn == 'core_calendar_get_calendar_events':
        return {'events': [{'id': 1, 'name': 'Examen: Modelos Lineales', 'courseid': 5, 'modulename': '', 'eventtype': 'course', 'timestart': now + 10 * 86400, 'timeduration': 7200},
                           {'id': 2, 'name': 'Teoría: Modelos Lineales (1)', 'courseid': 5, 'modulename': '', 'eventtype': 'course', 'timestart': now + 86400, 'timeduration': 7200},
                           {'id': 3, 'name': 'Práctica 2', 'courseid': 5, 'modulename': 'assign', 'eventtype': 'due', 'timestart': state['due2'], 'timeduration': 0}]}
    return {'exception': 'x', 'errorcode': 'unknown', 'message': fn}
async def campus(route):
    form = dict(urllib.parse.parse_qsl(route.request.post_data or ''))
    await route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps(reply(form.get('wsfunction'), form)))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='es-ES', timezone_id='Europe/Madrid', service_workers='block')
        page = await ctx.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '/api/' not in m.text and '404' not in m.text else None)
        await page.route('https://campus.umh.es/**', campus)
        await page.goto('http://localhost:8765/'); await page.wait_for_selector('.welcome')
        href = await page.get_attribute('.steps a.btn', 'href'); assert 'launch.php?service=moodle_mobile_app' in href and 'urlscheme=moodlemobile' in href, href
        await page.fill('#token', 'cualquier cosa'); await page.click('#connect-btn'); assert 'no parece' in await page.inner_text('#connect-error')
        link = 'moodlemobile://token=' + base64.b64encode(f'{"0"*32}:::{TOKEN}:::{"f"*64}'.encode()).decode()
        await page.fill('#token', link); await page.click('#connect-btn'); await page.wait_for_selector('.tabs', timeout=8000)
        acct = await page.evaluate("JSON.parse(localStorage.getItem('plazo.account'))")
        assert acct['token'] == TOKEN and acct['userid'] == 77 and acct['calToken'] == 'c' * 40, acct
        hero = await page.inner_text('.next'); assert 'Práctica 2' in hero and '3' in hero and 'Modelos Lineales' in hero, hero
        assert await page.inner_text('.me') == 'AP'
        await page.click('.tab[data-view="tareas"]'); t = await page.inner_text('#task-list'); assert 'Práctica 2' in t and 'Práctica 1' not in t, t
        await page.click('[data-filter="entregadas"]'); t = await page.inner_text('#task-list'); assert 'Práctica 1' in t and 'Entregada' in t, t
        await page.click('[data-filter="todas"]'); assert 'Sin fecha' in await page.inner_text('#task-list')
        await page.click('.row[data-act="task"][data-id="2"]'); await page.wait_for_selector('.sheet .rich')
        rich = await page.inner_html('.sheet .rich')
        assert 'onclick' not in rich and 'onerror' not in rich and 'javascript:' not in rich and '<script' not in rich and '<iframe' not in rich and '<img' not in rich, rich
        assert 'href="https://umh.es"' in rich and 'rel="noopener noreferrer"' in rich, rich
        await page.keyboard.press('Escape')
        await page.click('.tab[data-view="avisos"]'); f = await page.inner_text('.screen'); assert 'Aviso de prueba' in f and 'Retroalimentación disponible' in f and 'Usted ha realizado' not in f, f
        await page.click('.row[data-act="notice"]'); await page.wait_for_selector('.sheet .rich'); await page.keyboard.press('Escape')
        await page.click('.tab[data-view="calendario"]'); assert await page.locator('.cal .marks i.exam').count() >= 1
        assert await page.evaluate('window.__xss') is None, 'se ejecutó HTML del campus'
        # cambio de plazo detectado en el dispositivo
        state['due2'] = now + 5 * 86400
        await page.click('#refresh'); await page.wait_for_timeout(900)
        await page.click('.tab[data-view="avisos"]'); f = await page.inner_text('.screen'); assert 'Plazo cambiado: Práctica 2' in f, f
        await page.click('.me'); s = await page.inner_html('.sheet'); assert 'webcal://campus.umh.es/calendar/export_execute.php?userid=77&amp;authtoken=' + 'c' * 40 in s, s[:600]
        await page.keyboard.press('Escape')
        # token caducado
        state['valid'] = False
        await page.click('#refresh'); await page.wait_for_selector('.banner >> text=ha caducado', timeout=5000)
        assert 'Plazo cambiado' in await page.inner_text('.screen'), 'los datos guardados siguen visibles'
        await page.click('[data-act="reconnect"]'); await page.wait_for_selector('.welcome')
        state['valid'] = True
        await page.fill('#token', TOKEN); await page.click('#connect-btn')
        try:
            await page.wait_for_selector('.tabs', timeout=5000)
        except Exception:
            print('DEBUG', (await page.inner_text('body'))[:500], errors); raise
        assert await page.locator('.banner:not(.info)').count() == 0
        print('flujo real OK · errores:', errors)
        await b.close()

asyncio.run(main())

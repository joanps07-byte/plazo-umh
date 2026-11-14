import asyncio, sys, pathlib
from playwright.async_api import async_playwright
OUT = pathlib.Path('/home/claude/shots'); OUT.mkdir(exist_ok=True)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', args=['--no-sandbox'])
        for scheme in ['light', 'dark']:
            ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True, locale='es-ES', timezone_id='Europe/Madrid')
            page = await ctx.new_page()
            errors = []
            page.on('console', lambda m: errors.append(m.text) if m.type in ('error', 'warning') else None)
            page.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
            await page.goto('http://localhost:8765/?demo'); await page.wait_for_selector('.tabs')
            await page.screenshot(path=str(OUT / f'hoy-{scheme}.png'), full_page=True)
            if scheme == 'light':
                for view in ['calendario', 'tareas', 'avisos']:
                    await page.click(f'.tab[data-view="{view}"]'); await page.wait_for_timeout(150)
                    await page.screenshot(path=str(OUT / f'{view}.png'), full_page=True)
                await page.click('.row[data-act="notice"]'); await page.wait_for_timeout(300); await page.screenshot(path=str(OUT / 'aviso.png'))
                await page.click('[data-act="close-sheet"][data-force]')
                await page.click('.tab[data-view="tareas"]'); await page.click('.row[data-act="task"] >> nth=1'); await page.wait_for_timeout(300); await page.screenshot(path=str(OUT / 'tarea.png'))
                await page.keyboard.press('Escape')
                await page.fill('#q', 'bases'); await page.wait_for_timeout(100); n = await page.locator('#task-list .row').count(); print('búsqueda "bases":', n, 'filas')
                await page.click('.me'); await page.wait_for_timeout(300); await page.screenshot(path=str(OUT / 'ajustes.png'), full_page=False)
            print(scheme, 'errores de consola:', errors)
            await ctx.close()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, locale='es-ES')
        page = await ctx.new_page(); await page.goto('http://localhost:8765/'); await page.wait_for_selector('.welcome')
        await page.screenshot(path=str(OUT / 'bienvenida.png'), full_page=True)
        await b.close()
asyncio.run(main())

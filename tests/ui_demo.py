# Capturas de la interfaz en modo demostración (requiere Playwright y la app servida en localhost:8765).
import asyncio, pathlib
from playwright.async_api import async_playwright
OUT = pathlib.Path('/home/claude/shots'); OUT.mkdir(exist_ok=True)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', args=['--no-sandbox'])
        for scheme in ['light', 'dark']:
            ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True, locale='es-ES', timezone_id='Europe/Madrid')
            page = await ctx.new_page(); errors = []
            page.on('console', lambda m: errors.append(m.text) if m.type in ('error', 'warning') else None)
            page.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
            await page.goto('http://localhost:8765/?demo'); await page.wait_for_selector('.tabs')
            await page.screenshot(path=str(OUT / f'hoy-{scheme}.png'), full_page=True)
            if scheme == 'light':
                await page.click('.tab[data-view="agenda"]'); await page.screenshot(path=str(OUT / 'entregas.png'), full_page=True)
                await page.click('.types [data-type="examen"]'); await page.screenshot(path=str(OUT / 'examenes.png'))
                await page.click('.row-main[data-key="a:14"]'); await page.wait_for_timeout(250); await page.screenshot(path=str(OUT / 'examen-detalle.png'))
                await page.keyboard.press('Escape')
                await page.click('.icon-btn.add'); await page.wait_for_timeout(250); await page.screenshot(path=str(OUT / 'anadir.png')); await page.keyboard.press('Escape')
                await page.click('.tab[data-view="calendario"]'); await page.screenshot(path=str(OUT / 'calendario.png'), full_page=True)
                await page.click('.tab[data-view="avisos"]'); await page.screenshot(path=str(OUT / 'avisos.png'), full_page=True)
                await page.click('.me'); await page.wait_for_timeout(250); await page.screenshot(path=str(OUT / 'ajustes.png'), full_page=True)
                await page.evaluate("document.querySelector('.sheet').scrollTop = 0")
                h = await page.evaluate("document.querySelector('.sheet').scrollHeight")
                await page.set_viewport_size({'width': 390, 'height': min(h + 60, 2400)}); await page.screenshot(path=str(OUT / 'ajustes.png'))
            print(scheme, 'errores de consola:', errors)
            await ctx.close()
        await b.close()
asyncio.run(main())

"""Render chosen moments of the ad as PNG stills and a contact sheet, to review before the full render."""
import os
import subprocess
import sys
import time

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
TIMES = [float(x) for x in sys.argv[1:]] or [0.6, 1.25, 2.1, 3.3, 3.9, 4.6, 5.2, 6.3, 7.3, 7.7, 8.7, 9.9, 10.35, 11.4, 12.2, 13.8, 14.7, 15.8, 16.9, 17.6, 17.92, 18.7, 21.2, 22.15, 22.9, 23.7, 24.3, 24.8, 26.0, 27.2, 28.9]
OUT = os.path.join(HERE, 'stills')
os.makedirs(OUT, exist_ok=True)

srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8811', '--bind', '127.0.0.1', '--directory', HERE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1080, 'height': 1920}, device_scale_factor=1)
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.goto('http://127.0.0.1:8811/ad.html')
        pg.evaluate('window.ready')
        files = []
        t0 = time.time()
        for t in TIMES:
            pg.evaluate(f'window.renderAt({t})')
            f = os.path.join(OUT, f's{t:05.2f}.png')
            pg.locator('#c').screenshot(path=f)
            files.append(f)
        print(f'{len(files)} stills in {time.time() - t0:.1f}s', 'errors:', errs[:5])
        b.close()
finally:
    srv.terminate()

# contact sheet: 6 across, thumbnails 270x480
cols = 6
th_w, th_h = 270, 480
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * th_w, rows * th_h), (0, 0, 0))
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((th_w, th_h), Image.LANCZOS)
    sheet.paste(im, ((i % cols) * th_w, (i // cols) * th_h))
sheet.save(os.path.join(HERE, 'contact.png'))
print('contact sheet', sheet.size)

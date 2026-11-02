"""Render the ad to numbered PNG frames, in parallel browser workers.

python3 render.py bench            time a few frames
python3 render.py [S] [workers]    render all 900 frames (S moments per frame, default 4)
"""
import base64
import multiprocessing as mp
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, 'frames')
FPS, DUR = 30, 30.0
TOTAL = int(FPS * DUR)
PORT = 8812


def worker(idx, frames, S, q):
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--disable-gpu-vsync', '--disable-frame-rate-limit'])
        pg = b.new_page(viewport={'width': 1080, 'height': 1920}, device_scale_factor=1)
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:{PORT}/ad.html')
        pg.evaluate('window.ready')
        cdp = pg.context.new_cdp_session(pg)
        clip = {'x': 0, 'y': 0, 'width': 1080, 'height': 1920, 'scale': 1}
        for f in frames:
            pg.evaluate(f'window.renderFrame({f}, {S}, 0.5)')
            shot = cdp.send('Page.captureScreenshot', {'format': 'png', 'clip': clip, 'optimizeForSpeed': True, 'captureBeyondViewport': False})
            with open(os.path.join(FRAMES, f'f{f:05d}.png'), 'wb') as fh:
                fh.write(base64.b64decode(shot['data']))
            q.put(f)
        if errs:
            q.put(('errors', idx, errs[:5]))
        b.close()


def main():
    bench = len(sys.argv) > 1 and sys.argv[1] == 'bench'
    S = 4 if bench or len(sys.argv) < 2 else int(sys.argv[1])
    n = 2 if len(sys.argv) < 3 else int(sys.argv[2])
    os.makedirs(FRAMES, exist_ok=True)
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', HERE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    try:
        if bench:
            todo = [60, 240, 306, 330, 520, 640, 700, 800]
        elif len(sys.argv) > 4:  # re-render a range of frames, replacing what's there
            todo = list(range(int(sys.argv[3]), int(sys.argv[4])))
        else:
            todo = [f for f in range(TOTAL) if not os.path.exists(os.path.join(FRAMES, f'f{f:05d}.png'))]
        chunks = [todo[i::n] for i in range(n)]
        q = mp.Queue()
        procs = [mp.Process(target=worker, args=(i, chunks[i], S, q)) for i in range(n) if chunks[i]]
        t0 = time.time()
        for pr in procs:
            pr.start()
        done = 0
        while done < len(todo):
            m = q.get()
            if isinstance(m, tuple):
                print('page errors', m, flush=True)
                continue
            done += 1
            if done % 60 == 0 or bench:
                el = time.time() - t0
                print(f'{done}/{len(todo)} frames, {el:.0f}s, eta {el / done * (len(todo) - done):.0f}s', flush=True)
        for pr in procs:
            pr.join()
        while not q.empty():
            m = q.get()
            if isinstance(m, tuple):
                print('page errors', m)
        print(f'done in {time.time() - t0:.0f}s')
    finally:
        srv.terminate()


if __name__ == '__main__':
    main()

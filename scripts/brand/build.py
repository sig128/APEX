"""Builds the Propify wordmark and every image made from it.

    python3 scripts/brand/build.py

Writes frontend/src/brand/wordmark.js (the header logo and the intro's logo), the logo and
link-preview images, the app icons and the favicons. Needs Python 3 with fontTools, Pillow and
numpy, and Inter Display Black Italic (OFL; set PROPIFY_FONT if it isn't at the default path).
"""
import json, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from glyphs import Font, flatten, raster, transform_ops  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
FE = os.path.join(ROOT, 'frontend')
P = json.load(open(os.path.join(HERE, 'params.json')))
NAVY, GOLD = (5, 10, 20), (252, 216, 0)
font = Font()


def build(text):
    """Glyph outlines in wordmark units: y down, tight to the letters, 100 tall."""
    c = font.cap
    per_mille = font.upm / c * 100 / 1000
    glyphs, pen = [], 0.0
    for i, ch in enumerate(text):
        ops, adv = font.glyph(ch)
        glyphs.append(transform_ops(ops, lambda p, pen=pen: (pen + P['sx'] * p[0] / c * 100 + P['k'] * p[1] / c * 100, -p[1] / c * 100)))
        pen += adv / c * 100 * P['sx'] + P['track'] + P['kern'].get(text[i:i + 2], 0) * per_mille * P['sx']
    pts = [pt for g in glyphs for poly in flatten(g, 24) for pt in poly]
    minx, miny = min(x for x, _ in pts), min(y for _, y in pts)
    s = 100 / (max(y for _, y in pts) - miny)
    glyphs = [transform_ops(g, lambda p: ((p[0] - minx) * s, (p[1] - miny) * s)) for g in glyphs]
    return glyphs, (max(x for x, _ in pts) - minx) * s


def path_d(glyphs):
    n = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')
    out = []
    for g in glyphs:
        for op, args in g:
            if op == 'moveTo':
                out.append(f'M{n(args[0][0])} {n(args[0][1])}')
            elif op == 'lineTo':
                out.append(f'L{n(args[0][0])} {n(args[0][1])}')
            elif op == 'curveTo':
                out.append('C' + ' '.join(f'{n(x)} {n(y)}' for x, y in args))
            elif op in ('closePath', 'endPath'):
                out.append('Z')
            else:
                raise SystemExit(f'unexpected outline command {op}')
    return ''.join(out)


def render(text, W, H, frac_w=None, frac_h=None, ss=4):
    glyphs, w = build(text)
    polys = [p for g in glyphs for p in flatten(g, 32)]
    s = min(W * frac_w / w if frac_w else 1e9, H * frac_h / 100 if frac_h else 1e9)
    ox, oy = (W - w * s) / 2, (H - 100 * s) / 2
    m = raster([[(x * s + ox, y * s + oy) for x, y in p] for p in polys], W * ss, H * ss, ss)
    img = Image.new('RGB', (W * ss, H * ss), NAVY)
    img.paste(Image.new('RGB', img.size, GOLD), mask=Image.fromarray((m * 255).astype(np.uint8)))
    return img.resize((W, H), Image.LANCZOS)


def main():
    glyphs, w = build('PROPIFY')
    with open(os.path.join(FE, 'src', 'brand', 'wordmark.js'), 'w') as f:
        f.write(f"""// The Propify wordmark: Inter Display Black Italic, widened 12% and slanted a touch more so it
// keeps the old APEX logo's weight and lean. The viewBox is tight to the letters (100 units
// tall), so an <svg> of it has no side bearings and the intro can land its logo exactly on the
// header's. Regenerate with scripts/brand/build.py rather than editing by hand.
export const WORDMARK = {{
  w: {round(w, 2)},
  h: 100,
  d: '{path_d(glyphs)}',
}}

export const WORDMARK_VIEWBOX = `0 0 ${{WORDMARK.w}} ${{WORDMARK.h}}`
""")
    images = {
        'src/assets/logo.png': ('PROPIFY', 1024, 1024, 0.84, None),
        'public/logo.png': ('PROPIFY', 1024, 1024, 0.84, None),
        'public/og.png': ('PROPIFY', 1200, 630, 0.78, None),
        'public/icon-512.png': ('P', 512, 512, None, 0.56),
        'public/icon-192.png': ('P', 192, 192, None, 0.56),
        'public/apple-touch-icon.png': ('P', 180, 180, None, 0.56),
        'public/icon-maskable-512.png': ('P', 512, 512, None, 0.42),
        'public/favicon-64.png': ('P', 64, 64, None, 0.80),
        'public/favicon-32.png': ('P', 32, 32, None, 0.84),
    }
    for rel, (text, W, H, fw, fh) in images.items():
        render(text, W, H, fw, fh, ss=8 if W <= 64 else 4).save(os.path.join(FE, rel), optimize=True)
        print(rel, f'{W}x{H}')


if __name__ == '__main__':
    main()

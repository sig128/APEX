"""Builds the PropPickz logo data that the site, the intro and the brand images use.

    python3 scripts/brand/build.py        # writes frontend/src/brand/wordmark.js + scripts/brand/brand.json
    node scripts/brand/render.cjs         # then draws the icons, logo.png and og.png from brand.json

The P mark is traced from the brand art (marketing/brand/proppickz-mark.png; the trace lives in
mark.json). The wordmark is Archivo ExtraBold Italic (OFL, in fonts/), widened 12% and slanted
further so PROPPICKZ lines up with the banner (marketing/brand/proppickz-banner.png, 83% overlap).
Needs Python 3 with fontTools, numpy and uharfbuzz (pip install uharfbuzz) for the font's kerning.
"""
import json, os, re, sys

import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen

sys.path.insert(0, os.path.dirname(__file__))
from glyphs import flatten, transform_ops  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
FE = os.path.join(ROOT, 'frontend')
P = json.load(open(os.path.join(HERE, 'params.json')))

# Brand colors, sampled from the brand art: the mark runs lawn green (bottom left) to a pale
# lime (top right); PICKZ runs lime to a lighter lime; PROP is near-white.
COLORS = {
    'black': '#030605',
    'white': '#f2f5ec',
    'lime': '#b8ff1f',
    'limeDeep': '#7cfc00',
    'limeHi': '#e9ff9a',
    'markFrom': '#7cfc00',
    'markMid': '#b4fb26',
    'markTo': '#f0fde0',
    'pickzFrom': '#9ef90f',
    'pickzTo': '#e4ff5c',
}

NUM = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')


def path_d(ops_list):
    out = []
    for g in ops_list:
        for op, args in g:
            if op == 'moveTo':
                out.append(f'M{NUM(args[0][0])} {NUM(args[0][1])}')
            elif op == 'lineTo':
                out.append(f'L{NUM(args[0][0])} {NUM(args[0][1])}')
            elif op == 'curveTo':
                out.append('C' + ' '.join(f'{NUM(x)} {NUM(y)}' for x, y in args))
            elif op == 'qCurveTo':
                # TrueType quadratics: expand implied on-curve points, emit as Q segments
                pts = list(args)
                for i, o in enumerate(pts[:-1]):
                    end = pts[-1] if i == len(pts) - 2 else ((o[0] + pts[i + 1][0]) / 2, (o[1] + pts[i + 1][1]) / 2)
                    out.append(f'Q{NUM(o[0])} {NUM(o[1])} {NUM(end[0])} {NUM(end[1])}')
            elif op in ('closePath', 'endPath'):
                out.append('Z')
            else:
                raise SystemExit(f'unexpected outline command {op}')
    return ''.join(out)


# ---------------------------------------------------------------- the wordmark

def to_sfnt(path):
    out = os.path.join(HERE, 'fonts', '.cache-' + os.path.basename(path).replace('.woff', '.ttf'))
    if not os.path.exists(out):
        f = TTFont(path)
        f.flavor = None
        f.save(out)
    return out


def word(text):
    """Glyph outlines for text, y down, normalized to 100 tall (bbox), one ops list per glyph."""
    path = to_sfnt(os.path.join(HERE, 'fonts', P['font']))
    f = TTFont(path)
    gs, order = f.getGlyphSet(), f.getGlyphOrder()
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hb.Font(hb.Face(hb.Blob.from_file_path(path))), buf, {'kern': True, 'liga': False})
    raw, pen = [], 0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        rp = RecordingPen()
        gs[order[info.codepoint]].draw(rp)
        x0 = pen + pos.x_offset
        raw.append(transform_ops(rp.value, lambda p, x0=x0: (P['sx'] * (x0 + p[0]) + P['k'] * p[1], -p[1])))
        pen += pos.x_advance
    pts = [pt for g in raw for poly in flatten(g, 16) for pt in poly]
    minx, miny = min(x for x, _ in pts), min(y for _, y in pts)
    s = 100 / (max(y for _, y in pts) - miny)
    glyphs = [transform_ops(g, lambda p, i=i: ((p[0] - minx) * s + i * P['track'], (p[1] - miny) * s)) for i, g in enumerate(raw)]
    pts = [pt for g in glyphs for poly in flatten(g, 16) for pt in poly]
    return glyphs, max(x for x, _ in pts)


# ---------------------------------------------------------------- the mark

def parse(d):
    """M/L/C/Z path (absolute) -> RecordingPen-style ops."""
    ops = []
    for cmd, body in re.findall(r'([MLCZ])([^MLCZ]*)', d):
        n = list(map(float, re.findall(r'-?\d+(?:\.\d+)?', body)))
        pts = list(zip(n[0::2], n[1::2]))
        if cmd == 'M':
            ops.append(('moveTo', (pts[0],)))
        elif cmd == 'L':
            for p in pts:
                ops.append(('lineTo', (p,)))
        elif cmd == 'C':
            for i in range(0, len(pts), 3):
                ops.append(('curveTo', tuple(pts[i:i + 3])))
        else:
            ops.append(('closePath', ()))
    return ops


def mark():
    m = json.load(open(os.path.join(HERE, 'mark.json')))
    shapes = [parse(m['p'])] + [parse(d) for d in m['lines']]
    pts = [pt for g in shapes for poly in flatten(g, 16) for pt in poly]
    minx, miny = min(x for x, _ in pts), min(y for _, y in pts)
    s = 100 / (max(y for _, y in pts) - miny)
    shapes = [transform_ops(g, lambda p: ((p[0] - minx) * s, (p[1] - miny) * s)) for g in shapes]
    w = (max(x for x, _ in pts) - minx) * s
    return shapes, w


def main():
    glyphs, ww = word('PROPPICKZ')
    prop, pickz = glyphs[:4], glyphs[4:]
    pickz_x = min(x for g in pickz for poly in flatten(g, 16) for x, _ in poly)
    shapes, mw = mark()
    L = P['lockup']
    mh = L['markH']
    mark_w = mw * mh / 100
    lock = {
        'w': round(mark_w + L['gap'] + ww, 2),
        'top': -(mh - 100) / 2 + L['markDy'],
        'h': mh,
        'mark': {'x': 0, 'y': round(-(mh - 100) / 2 + L['markDy'], 2), 's': mh / 100, 'w': round(mark_w, 2)},
        'word': {'x': round(mark_w + L['gap'], 2), 'y': 0},
    }
    data = {
        'mark': {'w': round(mw, 2), 'h': 100, 'p': path_d(shapes[:1]), 'lines': [path_d([g]) for g in shapes[1:]]},
        'word': {'w': round(ww, 2), 'h': 100, 'prop': path_d(prop), 'pickz': path_d(pickz), 'pickzX': round(pickz_x, 2)},
        'lockup': lock,
        'colors': COLORS,
    }
    json.dump(data, open(os.path.join(HERE, 'brand.json'), 'w'), indent=1)
    js = f"""// The PropPickz logo, generated by scripts/brand/build.py (edit that, not this).
// MARK is the P with its three speed lines, traced from the brand art; WORD is PROPPICKZ in
// Archivo ExtraBold Italic, widened and slanted to match the banner, split so PROP and PICKZ can
// take their own colors. Both are y-down boxes 100 units tall and tight to the shapes, so an <svg>
// of either has no side bearings and the intro can land its logo exactly on the header's.
// LOCKUP places them side by side as on the banner, in word units (the word is 100 tall).
export const MARK = {json.dumps(data['mark'], indent=2)}

export const WORD = {json.dumps(data['word'], indent=2)}

export const LOCKUP = {json.dumps(lock, indent=2)}

export const BRAND = {json.dumps(COLORS, indent=2)}
"""
    with open(os.path.join(FE, 'src', 'brand', 'wordmark.js'), 'w') as f:
        f.write(js)
    print('mark', round(mw, 1), 'x 100; word', round(ww, 1), 'x 100; lockup', lock['w'], 'x', mh)


if __name__ == '__main__':
    main()

# Shared helpers: font outlines -> transformed contours (with curves kept), flattening, rasterizing.
import re, math
import numpy as np
from PIL import Image, ImageDraw, ImageChops
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen

import os
FONT = os.environ.get('PROPIFY_FONT', '/usr/share/fonts/opentype/inter/InterDisplay-BlackItalic.otf')

class Font:
    def __init__(self, path=FONT):
        self.f = TTFont(path)
        self.gs = self.f.getGlyphSet()
        self.cmap = self.f.getBestCmap()
        self.upm = self.f['head'].unitsPerEm
        self.cap = self.f['OS/2'].sCapHeight
        self.hmtx = self.f['hmtx']
    def glyph(self, ch):
        name = self.cmap[ord(ch)]
        pen = RecordingPen()
        self.gs[name].draw(pen)
        return pen.value, self.hmtx[name][0]

def transform_ops(ops, fn):
    out = []
    for op, args in ops:
        out.append((op, tuple(fn(p) for p in args)))
    return out

def flatten(ops, steps=12):
    """RecordingPen ops -> list of polygons (list of (x,y))."""
    polys, cur, start = [], [], None
    last = None
    for op, args in ops:
        if op == 'moveTo':
            if cur: polys.append(cur)
            cur = [args[0]]; last = args[0]
        elif op == 'lineTo':
            cur.append(args[0]); last = args[0]
        elif op == 'curveTo':
            # may be a poly-bezier; fontTools gives exactly 3 points for CFF
            pts = [last] + list(args)
            for i in range(0, len(pts) - 1, 3):
                p0, p1, p2, p3 = pts[i:i + 4]
                for s in range(1, steps + 1):
                    t = s / steps; u = 1 - t
                    x = u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0]
                    y = u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]
                    cur.append((x, y))
                last = p3
        elif op == 'qCurveTo':
            pts = [last] + list(args)
            # implied on-curve points between consecutive off-curve points
            on = pts[0]
            offs = pts[1:-1]; end = pts[-1]
            seq = []
            for i, o in enumerate(offs):
                nxt = end if i == len(offs) - 1 else ((o[0] + offs[i+1][0]) / 2, (o[1] + offs[i+1][1]) / 2)
                seq.append((o, nxt))
            for o, nxt in seq:
                for s in range(1, steps + 1):
                    t = s / steps; u = 1 - t
                    cur.append((u*u*on[0] + 2*u*t*o[0] + t*t*nxt[0], u*u*on[1] + 2*u*t*o[1] + t*t*nxt[1]))
                on = nxt
            last = end
        elif op in ('closePath', 'endPath'):
            if cur: polys.append(cur)
            cur = []
    if cur: polys.append(cur)
    return polys

def raster(polys, W, H, scale=1.0, dx=0, dy=0):
    """Even-odd fill of polygons in a y-down coordinate frame."""
    acc = Image.new('1', (W, H), 0)
    for poly in polys:
        m = Image.new('1', (W, H), 0)
        ImageDraw.Draw(m).polygon([((x + dx) * scale, (y + dy) * scale) for x, y in poly], fill=1)
        acc = ImageChops.logical_xor(acc, m)
    return np.array(acc, dtype=bool)

def parse_svg_polys(d):
    """M/L/Z-only path -> polygons."""
    polys = []
    for sub in re.findall(r'M[^M]*', d):
        nums = list(map(float, re.findall(r'-?\d+(?:\.\d+)?', sub)))
        polys.append(list(zip(nums[0::2], nums[1::2])))
    return polys

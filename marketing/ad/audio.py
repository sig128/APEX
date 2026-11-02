"""The soundtrack for the Propify ad, synthesized from scratch.

30 s, 48 kHz stereo, 120 BPM in F minor. Every hit lands on the same time as the picture
(the IMPACTS, flips, whips and counters in ad.html). Writes audio.wav, mastered to -14 LUFS.
"""
import os
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile
from scipy.ndimage import minimum_filter1d

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 48000
DUR = 30.0
N = int(SR * DUR)
R = np.random.default_rng(20261102)


# ---------------------------------------------------------------- basics
def T(n):
    return np.arange(n) / SR


def nz(n, seed=None):
    return (np.random.default_rng(seed) if seed is not None else R).standard_normal(n)


def _sos(kind, f, o):
    return signal.butter(o, f, kind, fs=SR, output='sos')


def lp(x, f, o=4):
    return signal.sosfilt(_sos('lowpass', min(f, SR * 0.45), o), x, axis=-1)


def hp(x, f, o=4):
    return signal.sosfilt(_sos('highpass', f, o), x, axis=-1)


def bp(x, lo, hi, o=2):
    return signal.sosfilt(_sos('bandpass', [lo, min(hi, SR * 0.45)], o), x, axis=-1)


NOTES = {'C': 0, 'Db': 1, 'D': 2, 'Eb': 3, 'E': 4, 'F': 5, 'Gb': 6, 'G': 7, 'Ab': 8, 'A': 9, 'Bb': 10, 'B': 11}


def hz(name):
    p, o = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((NOTES[p] + 12 * (o + 1) - 69) / 12)


def fade(y, a=0.002, b=0.01):
    n = y.shape[-1]
    ia, ib = min(n, int(a * SR)), min(n, int(b * SR))
    if ia:
        y[..., :ia] *= np.linspace(0, 1, ia)
    if ib:
        y[..., -ib:] *= np.linspace(1, 0, ib)
    return y


def pan2(y, pan=0.0):
    a = (pan + 1) * np.pi / 4
    return np.stack([y * np.cos(a), y * np.sin(a)]) * np.sqrt(2)


class Bus:
    def __init__(self):
        self.x = np.zeros((2, N))

    def add(self, y, t, g=1.0, pan=0.0):
        y = np.asarray(y, dtype=float)
        if y.ndim == 1:
            y = pan2(y, pan)
        i = int(round(t * SR))
        if i < 0:
            y, i = y[:, -i:], 0
        n = min(y.shape[1], N - i)
        if n > 0:
            self.x[:, i:i + n] += g * y[:, :n]


def stft_shape(x, gain):
    """Filter x (mono) with a gain that changes over time: gain(f[:, None], t[None, :])."""
    n = len(x)
    f, tt, Z = signal.stft(x, SR, nperseg=2048, noverlap=1536)
    _, y = signal.istft(Z * gain(f[:, None], tt[None, :]), SR, nperseg=2048, noverlap=1536)
    y = y[:n]
    return np.pad(y, (0, n - len(y))) if len(y) < n else y


def shaped(n, gain, seed=None):
    return stft_shape(nz(n, seed), gain)


def sweep_lp(x, fc, t0=0.0, order=2):
    """Low-pass x (stereo) with a cutoff fc(t) in seconds from the start of x (t0 = x's start in the film)."""
    out = np.empty_like(x)
    for ch in range(x.shape[0]):
        out[ch] = stft_shape(x[ch], lambda f, tt: 1 / np.sqrt(1 + (f / fc(tt + t0)) ** (2 * order)))
    return out


# ---------------------------------------------------------------- instruments
def saw(f, n, ph0=0.0):
    ph = (ph0 + f * np.arange(n) / SR) % 1.0
    return 2 * ph - 1


def kick(f0=160, f1=50, pd=0.03, decay=0.24, click=0.5, dur=0.7, drive=1.7):
    n = int(dur * SR)
    t = T(n)
    f = f1 + (f0 - f1) * np.exp(-t / pd)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / decay)
    body += 0.45 * bp(nz(n), 140, 420) * np.exp(-t / 0.018)  # the knock
    cl = hp(nz(n), 2800) * np.exp(-t / 0.0035) * click
    return fade(np.tanh(drive * (body + cl)) / np.tanh(drive), 0.0005, 0.03)


def snare(pitch=190, dur=0.35, tone=0.6, decay=0.12):
    n = int(dur * SR)
    t = T(n)
    f = pitch * (1 + 0.5 * np.exp(-t / 0.01))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.055) * tone
    sn = bp(nz(n), 1300, 9500) * np.exp(-t / decay)
    return fade(np.tanh(1.4 * (body + sn)), 0.0005, 0.02)


def clap(dur=0.5):
    n = int(dur * SR)
    t = T(n)
    x = bp(nz(n), 900, 3200) + 0.35 * bp(nz(n), 3000, 9000)
    env = np.zeros(n)
    for k, ti in enumerate([0, 0.009, 0.019, 0.031]):
        m = t >= ti
        env[m] += np.exp(-(t[m] - ti) / 0.0035) * (0.8 if k < 3 else 1.0)
    m = t >= 0.031
    env[m] += 0.55 * np.exp(-(t[m] - 0.031) / 0.11)
    return fade(x * env * 1.6, 0.0003, 0.02)


def hat(decay=0.03, dur=0.14):
    n = int(dur * SR)
    t = T(n)
    sq = sum(np.sign(np.sin(2 * np.pi * 330 * r * t + R.uniform(0, 6.28))) for r in [2, 3, 4.16, 5.43, 6.79, 8.21])
    x = hp(bp(sq, 6000, 14000) * 0.6 + nz(n) * 0.5, 7000, 2)
    return fade(x * np.exp(-t / decay), 0.0003, 0.01)


def cymbal(dur=3.0, decay=1.1, seed=0):
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    t = T(n)
    out = np.zeros((2, n))
    for ch in range(2):
        metal = sum(np.sign(np.sin(2 * np.pi * f * t + r.uniform(0, 6.28))) for f in [431, 587, 811, 1137, 1613, 2210])
        x = hp(r.standard_normal(n), 3600, 2) * 0.8 + bp(metal, 3500, 13000) * 0.3
        out[ch] = x * (np.exp(-t / decay) + 0.6 * np.exp(-t / 0.05))
    return fade(out, 0.0004, 0.05)


def rev_cymbal(dur=1.0, seed=0):
    c = cymbal(2.8, 0.8, seed)[:, ::-1]
    y = c[:, -int(dur * SR):].copy()
    y *= np.linspace(0, 1, y.shape[1]) ** 1.4
    return y


def tick(f=2400, dur=0.025, q=0.0025):
    n = int(dur * SR)
    t = T(n)
    y = np.sin(2 * np.pi * f * t) * np.exp(-t / q) + 0.6 * bp(nz(n), 2500, 9000) * np.exp(-t / 0.0012)
    return fade(y, 0.0002, 0.003)


def tock(f=900, dur=0.08):
    n = int(dur * SR)
    t = T(n)
    y = (np.sin(2 * np.pi * f * t) + 0.45 * np.sin(2 * np.pi * f * 2.71 * t)) * np.exp(-t / 0.012)
    y += 0.4 * bp(nz(n), 1800, 6000) * np.exp(-t / 0.0015)
    return fade(y, 0.0002, 0.005)


def blip(f0, f1, dur=0.1):
    n = int(dur * SR)
    t = T(n)
    f = f0 * (f1 / f0) ** np.minimum(1, t / (dur * 0.5))
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = (np.sin(ph) + 0.25 * np.sin(2 * ph)) * np.exp(-t / (dur / 3))
    return fade(y, 0.001, 0.008)


def pluck(f, dur=0.7, decay=0.32, bright=1.0, seed=None):
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    t = T(n)
    y = np.zeros(n)
    for k in range(1, max(1, int(min(36, 11000 / f))) + 1):
        y += np.sin(2 * np.pi * f * k * (1 + 0.00008 * k * k) * t + r.uniform(0, 6.28)) / k ** 1.05 * np.exp(-t * (1 / decay + (k - 1) * 7 / bright))
    return fade(y * 0.6, 0.0015, 0.02)


def bell(f, dur=3.0, ratio=3.5, index=2.5, decay=1.1):
    n = int(dur * SR)
    t = T(n)
    m = index * np.exp(-t / 0.35) * np.sin(2 * np.pi * f * ratio * t)
    y = np.sin(2 * np.pi * f * t + m) * np.exp(-t / decay)
    y += 0.35 * np.sin(2 * np.pi * f * 2.0 * t + 0.5 * m) * np.exp(-t / (decay * 0.45))
    y += 0.15 * np.sin(2 * np.pi * f * 4.07 * t) * np.exp(-t / (decay * 0.2))
    return fade(y * 0.5, 0.0008, 0.05)


def pad(notes, hold, attack=0.6, release=1.4, cutoff=2600, voices=5, cents=16, seed=0):
    r = np.random.default_rng(seed)
    n = int((hold + release) * SR)
    t = T(n)
    L, Rr = np.zeros(n), np.zeros(n)
    for f in notes:
        for v in range(voices):
            u = (v / (voices - 1)) * 2 - 1
            s = saw(f * 2 ** (u * cents / 1200), n, r.uniform())
            a = (u * 0.85 + 1) * np.pi / 4
            L += s * np.cos(a)
            Rr += s * np.sin(a)
    env = np.where(t < attack, np.sin(0.5 * np.pi * np.minimum(1, t / attack)) ** 2, 1.0)
    rel = t > hold
    env[rel] *= np.exp(-(t[rel] - hold) / (release / 4))
    y = lp(np.stack([L, Rr]) * env / (len(notes) * np.sqrt(voices)), cutoff, 2)
    return fade(y, 0.001, 0.05)


def bass(f, dur, drive=1.8, growl=0.5, decay=0.5):
    n = int(dur * SR)
    t = T(n)
    y = np.sin(2 * np.pi * f * t)
    for k in range(2, 10):
        y += growl * np.sin(2 * np.pi * f * k * t) / k * np.exp(-t * k * 4)
    return fade(np.tanh(drive * y) / np.tanh(drive) * np.exp(-t / decay), 0.003, 0.015)


def braam(notes, dur, peak=0.18, fc_lo=260, fc_hi=2400, seed=0):
    """The trailer horn: detuned saws, saturated, its filter opening fast and closing slowly."""
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    t = T(n)
    out = np.zeros((2, n))
    for ch in range(2):
        x = np.zeros(n)
        for f in notes:
            for d in (-11, -4, 3, 9):
                vib = 1 + 0.003 * np.sin(2 * np.pi * r.uniform(4.5, 6) * t)
                x += saw(f * 2 ** (d / 1200), n, r.uniform()) * vib
        x = np.tanh(1.8 * x / len(notes))

        def fc(tt):
            u = np.maximum(tt, 0)
            return fc_lo + (fc_hi - fc_lo) * np.where(u < peak, (u / peak) ** 0.7, np.exp(-(u - peak) / (dur * 0.35)))

        out[ch] = stft_shape(x, lambda f, tt: 1 / np.sqrt(1 + (f / fc(tt)) ** 4))
    env = np.minimum(1, t / 0.012) * np.exp(-t / (dur * 0.45))
    return fade(out * env, 0.001, 0.15)


def impact(size=1.0, seed=0, tone=95):
    r = np.random.default_rng(seed)
    n = int((2.2 + 2.0 * size) * SR)
    t = T(n)
    f = 36 + 74 * np.exp(-t / 0.28)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.4 + 0.55 * size))
    thump = lp(r.standard_normal(n), 320) * np.exp(-t / 0.12) * 2.6
    crack = bp(r.standard_normal(n), 1500, 9000) * np.exp(-t / 0.022) * 1.3
    snap = bp(r.standard_normal(n), 600, 3200) * np.exp(-t / 0.05) * 1.2
    body = bp(r.standard_normal(n), 150, 1500) * np.exp(-t / 0.1) * 1.8
    metal = sum(np.sin(2 * np.pi * tone * k * t + r.uniform(0, 6.28)) * np.exp(-t * (1.2 + 1.1 * k)) / k ** 0.6 for k in [1, 2.13, 3.37, 4.91, 6.84, 9.2]) * 0.45
    return fade(np.tanh(1.25 * (0.8 * sub + thump + crack + snap + body + metal)), 0.0004, 0.2)


def tom(f=95, dur=0.9):
    n = int(dur * SR)
    t = T(n)
    ff = f * (1 + 0.8 * np.exp(-t / 0.03))
    y = np.sin(2 * np.pi * np.cumsum(ff) / SR) * np.exp(-t / 0.28) + 0.5 * lp(nz(n), 900) * np.exp(-t / 0.04)
    return fade(np.tanh(1.5 * y), 0.0005, 0.05)


def whoosh(dur, peak=0.5, f_lo=250, f_hi=4200, f_end=700, bw=0.9, pan0=-0.7, pan1=0.7, seed=0):
    n = int(dur * SR)

    def amp(u):
        return np.where(u < peak, (u / peak) ** 2.4, np.clip((1 - u) / (1 - peak), 0, 1) ** 1.6)

    def fc(u):
        return np.where(u < peak, f_lo * (f_hi / f_lo) ** (u / peak), f_hi * (f_end / f_hi) ** ((u - peak) / (1 - peak)))

    def g(f, tt):
        u = np.clip(tt / dur, 0, 1)
        return np.exp(-0.5 * ((np.log2(np.maximum(f, 20)) - np.log2(fc(u))) / bw) ** 2) * amp(u)

    a, b = shaped(n, g, seed), shaped(n, g, seed + 1)
    u = T(n) / dur
    ang = (pan0 + (pan1 - pan0) * u + 1) * np.pi / 4
    return np.stack([a * np.cos(ang) * 1.2 + 0.35 * b, a * np.sin(ang) * 1.2 - 0.35 * b])


def riser(dur, f0=250, f1=9000, p0=90, p1=1400, seed=0, curve=2.0):
    n = int(dur * SR)
    u = T(n) / dur

    def g(f, tt):
        uu = np.clip(tt / dur, 0, 1)
        return np.exp(-0.5 * ((np.log2(np.maximum(f, 20)) - np.log2(f0 * (f1 / f0) ** uu)) / 1.1) ** 2) * uu ** curve

    a, b = shaped(n, g, seed), shaped(n, g, seed + 7)
    out = np.stack([a, b])
    for ch, det in ((0, 1.0), (1, 1.006)):
        ph = 2 * np.pi * np.cumsum(p0 * det * (p1 / p0) ** (u ** 1.3)) / SR
        tone = sum(np.sin(k * ph) / k for k in range(1, 6))
        out[ch] += tone * u ** 3 * 0.35
    return fade(out, 0.01, 0.004)


def sparkles(dur, count, seed=0, fmin=2500, fmax=9000):
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    out = np.zeros((2, n))
    for _ in range(count):
        t0 = (r.uniform() ** 2) * dur * 0.8
        f = r.uniform(fmin, fmax)
        m = int(r.uniform(0.04, 0.16) * SR)
        tt = T(m)
        p = np.sin(2 * np.pi * f * tt) * np.exp(-tt / (m / SR / 4)) * r.uniform(0.3, 1)
        i = int(t0 * SR)
        k = min(m, n - i)
        out[:, i:i + k] += pan2(p, r.uniform(-0.9, 0.9))[:, :k]
    return out


def crowd(dur, env, seed=0):
    """A stadium: band-limited roar with many voices in it, following env (0..1, one value per sample)."""
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    t = T(n)
    out = np.zeros((2, n))
    for ch in range(2):
        x = bp(r.standard_normal(n), 220, 3000)
        am = 1 + sum(0.16 * np.sin(2 * np.pi * r.uniform(0.3, 3.5) * t + r.uniform(0, 6.28)) for _ in range(7))
        out[ch] = x * am * 0.6  # the bed stays under the voices
    for _ in range(int(dur * 14)):
        t0 = r.uniform(0, dur)
        k = env[min(n - 1, int(t0 * SR))]
        if r.uniform() > k * 1.3:
            continue
        L = r.uniform(0.25, 1.1)
        m = int(L * SR)
        tt = T(m)
        f0 = r.uniform(170, 420) * (1 + 0.12 * tt / L)
        src = np.sin(2 * np.pi * np.cumsum(f0) / SR)
        src = np.sign(src) * np.abs(src) ** 0.3 + 0.4 * r.standard_normal(m)
        F1, F2 = r.uniform(550, 900), r.uniform(1050, 1700)
        v = bp(src, F1 * 0.85, F1 * 1.15) + 0.6 * bp(src, F2 * 0.85, F2 * 1.15)
        v *= np.minimum(1, tt / r.uniform(0.06, 0.2)) * np.exp(-tt / (L * 0.5))
        i = int(t0 * SR)
        kk = min(m, n - i)
        out[:, i:i + kk] += pan2(v * r.uniform(0.4, 1.0) * 1.5, r.uniform(-0.9, 0.9))[:, :kk]
    return out * env[None, :n]


# ---------------------------------------------------------------- space and dynamics
def make_ir(rt=2.6, dur=3.6, seed=11, pre=0.025, bright=1.0):
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    t = T(n)
    out = np.zeros((2, n))
    for ch in range(2):
        x = r.standard_normal(n)
        y = np.zeros(n)
        for lo, hi, k in [(20, 300, 1.15), (300, 1500, 1.0), (1500, 5000, 0.72), (5000, 16000, 0.42 * bright)]:
            y += bp(x, lo, hi) * np.exp(-6.91 * t / (rt * k))
        for d in r.uniform(0.008, 0.08, 12):
            y[int(d * SR)] += r.uniform(-1, 1) * 4
        y *= np.minimum(1, t / 0.012)
        out[ch] = np.concatenate([np.zeros(int(pre * SR)), y])[:n]
    return out / np.sqrt(np.sum(out ** 2) / 2)


def convolve(x, ir):
    return np.stack([signal.fftconvolve(x[ch], ir[ch])[:N] for ch in range(2)])


def duck(times, depth=0.6, rel=0.13, att=0.004):
    g = np.ones(N)
    m = int(0.7 * SR)
    tt = T(m)
    shape = 1 - depth * np.minimum(1, tt / att) * np.exp(-np.maximum(tt - att, 0) / rel)
    for tk in times:
        i = int(tk * SR)
        k = min(m, N - i)
        if k > 0:
            g[i:i + k] = np.minimum(g[i:i + k], shape[:k])
    return g


def kweight(x):
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=-1), axis=-1)


def lufs(x):
    y = kweight(x)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    ms = np.array([np.mean(y[:, i:i + blk] ** 2, axis=1).sum() for i in range(0, y.shape[1] - blk + 1, hop)])
    ld = -0.691 + 10 * np.log10(ms + 1e-12)
    ms = ms[ld > -70]
    lg = -0.691 + 10 * np.log10(np.mean(ms))
    ms = ms[-0.691 + 10 * np.log10(ms) > lg - 10]
    return -0.691 + 10 * np.log10(np.mean(ms))


def true_peak(x):
    return np.abs(signal.resample_poly(x, 4, 1, axis=1)).max()


def limiter(x, ceil_db=-1.3, look=0.003, rel=0.09):
    ceil = 10 ** (ceil_db / 20)
    up = np.abs(signal.resample_poly(x, 4, 1, axis=1)).max(axis=0)
    pk = up[: (len(up) // 4) * 4].reshape(-1, 4).max(axis=1)
    pk = np.pad(pk, (0, x.shape[1] - len(pk)), mode='edge')
    need = np.minimum(1.0, ceil / np.maximum(pk, 1e-9))
    L = int(look * SR)
    g = minimum_filter1d(need, size=2 * L + 1)
    a = np.exp(-1 / (rel * SR))
    out = np.empty_like(g)
    s = 1.0
    for i, v in enumerate(g):  # instant attack (the window looks ahead), smooth release
        s = v if v < s else v + (s - v) * a
        out[i] = s
    win = np.hanning(L * 2 + 1)
    out = np.minimum(out, np.convolve(out, win / win.sum(), mode='same'))
    return x * out[None, :]


# ---------------------------------------------------------------- the score
def build():
    drums, bassb, music, sfx, hits, crowdb, horns = Bus(), Bus(), Bus(), Bus(), Bus(), Bus(), Bus()
    hall, room = Bus(), Bus()  # reverb sends
    kicks = []  # for the sidechain

    def K(t, g=0.9, **kw):
        y = kick(**kw)
        drums.add(y, t, g)
        kicks.append(t)

    def HIT(t, size, seed, braam_notes=None, braam_dur=2.4, g=0.95):
        y = impact(size, seed)
        hits.add(y, t, g * (0.55 + 0.45 * size))
        hall.add(y, t, 0.22 * size)
        kicks.append(t)
        if braam_notes:
            b = braam([hz(n) for n in braam_notes], braam_dur, seed=seed)
            horns.add(b, t, 0.42 * size)
            hall.add(b, t, 0.25)

    # ===== 0 to 1: the line draws; a drone and a reverse swell into the number
    dr = int(4.0 * SR)
    t = T(dr)
    drone = (np.sin(2 * np.pi * hz('F1') * t) + 0.6 * np.sin(2 * np.pi * hz('C2') * t)) * 0.25
    drone += lp(saw(hz('F2'), dr) + saw(hz('F2') * 1.004, dr), 320) * 0.3
    drone += lp(saw(hz('C3'), dr) + saw(hz('F3') * 1.003, dr), 700) * 0.12 * np.clip((t - 1.0) / 2.5, 0, 1)
    drone *= np.minimum(1, t / 0.9) * np.where(t > 3.6, np.clip((4.0 - t) / 0.4, 0, 1), 1)
    music.add(drone, 0.0, 0.55)
    zing = whoosh(0.95, peak=0.12, f_lo=1800, f_hi=9000, f_end=2500, bw=0.6, pan0=0, pan1=0, seed=3)
    sfx.add(zing, 0.1, 0.35)
    sfx.add(rev_cymbal(0.8, seed=1), 0.2, 0.5)
    # ===== 1.0: the number slams on the line
    HIT(1.0, 1.0, 1, ['F1', 'F2', 'C3'], 1.8)
    K(1.0, 0.8)
    sfx.add(sparkles(0.9, 22, seed=4), 1.0, 0.12)
    sfx.add(tick(3200), 1.2, 0.2)
    sfx.add(whoosh(0.45, peak=0.6, f_lo=800, f_hi=5000, f_end=2000, bw=0.7, seed=5), 1.3, 0.18)
    # tension pulse: soft ticks on the 8ths, a sub on the beats
    for i in range(int((3.75 - 1.5) / 0.25) + 1):
        tt = 1.5 + i * 0.25
        sfx.add(tock(1500 if i % 2 else 1150), tt, 0.1 + 0.05 * (i % 2 == 0))
    for tt in (2.0, 2.5, 3.0, 3.5):
        K(tt, 0.55, f0=120, f1=42, decay=0.25, click=0.15)
    # OVER / UNDER, faster and faster
    for tt, side in [(2.0, 'O'), (2.5, 'U'), (3.0, 'O'), (3.25, 'U'), (3.5, 'O'), (3.625, 'U')]:
        y = blip(760, 1520, 0.12) if side == 'O' else blip(1150, 520, 0.12)
        sfx.add(y, tt, 0.32, pan=0.15 if side == 'O' else -0.15)
        music.add(pluck(hz('C6') if side == 'O' else hz('F4'), 0.6, 0.18), tt, 0.16)
        hall.add(pluck(hz('C6') if side == 'O' else hz('F4'), 0.6, 0.18), tt, 0.08)
    sfx.add(rev_cymbal(0.35, seed=2), 3.39, 0.3)
    # glitch beeps (the glitch itself is cut into the mix below)
    rg = np.random.default_rng(9)
    for _ in range(9):
        tt = rg.uniform(3.74, 4.0)
        m = int(rg.uniform(0.01, 0.03) * SR)
        sq = np.sign(np.sin(2 * np.pi * rg.uniform(900, 4200) * T(m))) * 0.5
        sfx.add(fade(sq, 0.0005, 0.002), tt, 0.12, pan=rg.uniform(-0.8, 0.8))

    # ===== 4 to 7.5: thousands of lines; the build
    for i, tt in enumerate(np.arange(4.0, 7.5, 0.5)):
        K(tt, 0.55 + 0.05 * i, f0=140, f1=45, decay=0.28)
    for tt in np.arange(6.0, 7.5, 0.25):
        if abs((tt * 2) - round(tt * 2)) > 1e-6:
            K(tt, 0.5, f0=140, f1=45, decay=0.22)
    for i, tt in enumerate(np.arange(4.0, 7.5, 0.125)):
        drums.add(hat(0.02 + 0.015 * (i % 2 == 0)), tt, 0.06 + 0.04 * (tt - 4) / 3.5, pan=0.25)
    # snare roll, 16ths then 32nds, climbing
    tt = 6.5
    while tt < 7.46:
        step = 0.125 if tt < 7.0 else 0.0625
        u = (tt - 6.5) / 1.0
        s = snare(170 + 120 * u, 0.25, tone=0.4)
        drums.add(s, tt, 0.18 + 0.32 * u)
        room.add(s, tt, 0.12)
        tt += step
    # bass pulsing on F, filter opening
    bl = Bus()
    for tt in np.arange(4.0, 7.5, 0.25):
        bl.add(bass(hz('F2') * (2 if int(round(tt * 4)) % 2 else 1), 0.24, growl=0.6, decay=0.3), tt, 0.5)
    i0, i1 = int(4.0 * SR), int(7.5 * SR)
    bl.x[:, i0:i1] = sweep_lp(bl.x[:, i0:i1], lambda tt: 180 * (2400 / 180) ** np.clip((tt - 4.0) / 3.5, 0, 1), 4.0)
    bassb.x += bl.x
    sfx.add(riser(3.45, f0=300, f1=8000, p0=110, p1=900, seed=11), 4.0, 0.42)
    st = pad([hz(n) for n in ('F3', 'C4', 'Ab4')], 3.5, attack=2.5, release=0.05, cutoff=1600, seed=3)
    music.add(st, 4.0, 0.3)
    # the reel: a tick each time a row crosses the line, faster and faster
    for i in range(1, 40):
        tt = 4.0 + 3.5 * (i / 40) ** (1 / 2.4)
        sfx.add(tick(2100 + 25 * i + rg.uniform(-60, 60), q=0.0022), tt, 0.13 + 0.004 * i, pan=rg.uniform(-0.2, 0.2))
    # the headlines
    for tt, sz, sd, notes in [(4.25, 0.45, 21, ['F2', 'C3']), (4.75, 0.45, 22, ['Ab2', 'Eb3']), (6.0, 0.55, 23, ['F2', 'C3', 'F3'])]:
        HIT(tt, sz, sd, notes, 0.9, g=0.75)
    sfx.add(whoosh(0.4, peak=0.45, f_lo=500, f_hi=6000, f_end=1500, pan0=0.4, pan1=-0.4, seed=24), 5.62, 0.3)

    # ===== 7.5: the freeze. Everything stops on one line; a dark hit rings into silence
    HIT(7.5, 0.6, 31, ['E2', 'F2', 'B2'], 0.8, g=0.85)
    clunk = tom(70, 0.6)
    hits.add(clunk, 7.5, 0.6)
    sfx.add(rev_cymbal(0.42, seed=5), 7.58, 0.55)
    inhale = riser(0.4, f0=600, f1=6000, p0=200, p1=200, seed=33, curve=2.5)
    sfx.add(inhale, 7.6, 0.25)

    # ===== 8 to 17.2: the read. The beat drops.
    HIT(8.0, 1.25, 41, ['F1', 'F2', 'C3', 'F3'], 2.6)
    cr = cymbal(3.0, 1.2, seed=6)
    drums.add(cr, 8.0, 0.22)
    hall.add(cr, 8.0, 0.08)
    chords = [(8.0, ['F3', 'C4', 'G4', 'Ab4'], 'F'), (10.0, ['Db3', 'Ab3', 'C4', 'F4'], 'Db'), (12.0, ['Ab2', 'Eb3', 'C4', 'G4'], 'Ab'), (14.0, ['Eb3', 'Bb3', 'F4', 'G4'], 'Eb'), (16.0, ['F3', 'C4', 'G4', 'Ab4'], 'F')]
    arp_sets = {'F': ['F4', 'Ab4', 'C5', 'G5', 'Ab5', 'G5', 'C5', 'Ab4'], 'Db': ['Db4', 'F4', 'Ab4', 'C5', 'F5', 'C5', 'Ab4', 'F4'], 'Ab': ['Ab3', 'C4', 'Eb4', 'G4', 'C5', 'G4', 'Eb4', 'C4'], 'Eb': ['Eb4', 'G4', 'Bb4', 'F5', 'G5', 'F5', 'Bb4', 'G4']}
    for c0, notes, root in chords:
        hold = min(2.0, 17.95 - c0)
        p = pad([hz(n) for n in notes], hold, attack=0.25, release=0.6, cutoff=2800, seed=int(c0))
        music.add(p, c0, 0.36)
        hall.add(p, c0, 0.12)
        # bass: 8ths, low on the beat, up an octave between
        r1 = hz(root + '2')
        for k in range(int(hold / 0.25)):
            tt = c0 + k * 0.25
            bassb.add(bass(r1 * (2 if k % 2 else 1), 0.24, growl=0.7, decay=0.32), tt, 0.48)
        n = int(hold * SR)
        sb = np.sin(2 * np.pi * hz(root + '1') * T(n)) * np.minimum(1, T(n) / 0.02)
        bassb.add(fade(sb, 0.01, 0.05), c0, 0.16)
        # arp from 9.25 on (the bars play their own notes first)
        for k in range(int(hold / 0.125)):
            tt = c0 + k * 0.125
            if tt < 9.25:
                continue
            f = hz(arp_sets[root][k % 8])
            y = pluck(f, 0.5, 0.18, bright=0.8, seed=int(tt * 1000))
            music.add(y, tt, 0.14, pan=0.35 if k % 2 else -0.35)
            hall.add(y, tt, 0.05)
    # drums in the groove: kick 1 and 3 plus a push, clap 2 and 4, 16th hats
    for bar in np.arange(8.0, 17.2, 2.0):
        for off in (0.0, 0.75, 1.0):
            if bar + off < 17.2 and bar + off != 8.0:
                K(bar + off, 0.85)
        for off in (0.5, 1.5):
            if bar + off < 17.2:
                c = clap()
                drums.add(c, bar + off, 0.42)
                room.add(c, bar + off, 0.2)
                hall.add(c, bar + off, 0.06)
        for k in range(16):
            tt = bar + k * 0.125
            if tt < 17.2:
                drums.add(hat(0.05 if k % 4 == 2 else 0.022), tt, 0.1 if k % 2 == 0 else 0.065, pan=0.3)
        if bar + 1.75 < 17.2:
            drums.add(hat(0.22, 0.4), bar + 1.75, 0.09, pan=-0.2)
    # the chart: each bar plays its own note, higher bars higher; the misses sound dull
    scale = ['F4', 'G4', 'Ab4', 'Bb4', 'C5', 'Db5', 'Eb5', 'F5', 'G5', 'Ab5']
    games = [28, 31, 19, 27, 33, 22, 29, 30, 26, 35]
    for i, v in enumerate(games):
        tt = 8.0 + i * 0.125
        f = hz(scale[int(np.floor((v - 19) / 16 * 9 + 0.5))])
        hit_ = v > 24.5
        y = pluck(f, 0.9, 0.4 if hit_ else 0.15, bright=1.3 if hit_ else 0.35, seed=i)
        music.add(y, tt, 0.24 if hit_ else 0.2, pan=-0.6 + 1.2 * i / 9)
        hall.add(y, tt, 0.14)
        if hit_:
            b = bell(f * 2, 1.2, decay=0.4, index=1.2)
            music.add(b, tt, 0.07, pan=-0.6 + 1.2 * i / 9)
    # 9.5: 8 of 10, counted up
    HIT(9.5, 0.8, 51, None, g=0.8)
    for k in range(1, 9):
        x = 1 - (1 - (k - 0.5) / 8) ** (1 / 3)
        sfx.add(tick(2600 + 120 * k, q=0.002), 9.5 + x * 0.315, 0.16)
    sfx.add(whoosh(0.4, peak=0.5, f_lo=1200, f_hi=7000, f_end=3000, bw=0.6, pan0=-0.8, pan1=0.8, seed=52), 9.9, 0.16)
    # whip pans down the page
    for k, (a, b) in enumerate([(10.18, 10.5), (12.68, 13.0), (14.93, 15.25)]):
        d = (b - a) + 0.24
        sfx.add(whoosh(d, peak=(b - a) * 0.5 / d + 0.12, f_lo=220, f_hi=3600, f_end=500, bw=1.0, pan0=-0.5 * (-1) ** k, pan1=0.5 * (-1) ** k, seed=60 + k), a - 0.06, 0.55)
    # the ring fills: a rising tone that settles on a chime
    n = int(1.2 * SR)
    tt = T(n)
    u = 1 - (1 - tt / 1.2) ** 3
    ring = np.sin(2 * np.pi * np.cumsum(hz('C5') * 2 ** (u * 1.0)) / SR) * (0.3 + 0.7 * u) * np.minimum(1, tt / 0.05)
    sfx.add(fade(ring * 0.5, 0.01, 0.1), 10.5, 0.12)
    music.add(bell(hz('C6'), 2.0, decay=0.7), 11.55, 0.18)
    hall.add(bell(hz('C6'), 2.0, decay=0.7), 11.55, 0.12)
    # prices: three tiles, then the best one
    for k, tt in enumerate((13.0, 13.14, 13.28)):
        sfx.add(blip(1100 + 160 * k, 1300 + 160 * k, 0.07), tt, 0.2, pan=-0.4 + 0.4 * k)
    music.add(bell(hz('F6'), 2.2, decay=0.8), 13.62, 0.2, pan=0.35)
    hall.add(bell(hz('F6'), 2.2, decay=0.8), 13.62, 0.15)
    # 14.0: the edge, rolling up
    HIT(14.0, 0.5, 61, ['Eb2', 'Bb2'], 0.9, g=0.75)
    n = int(0.5 * SR)
    tt = T(n)
    zip_ = np.sin(2 * np.pi * np.cumsum(700 * 3 ** (tt / 0.5)) / SR) * np.exp(-((tt - 0.3) / 0.25) ** 2)
    sfx.add(fade(zip_, 0.005, 0.05), 14.0, 0.1)
    sfx.add(whoosh(0.55, peak=0.6, f_lo=400, f_hi=3000, f_end=1200, bw=0.8, pan0=-0.6, pan1=0.6, seed=62), 14.3, 0.18)
    # 15.25: the AI read, a shimmer; 15.45 the verdict
    sfx.add(sparkles(0.7, 30, seed=71, fmin=3500, fmax=11000), 15.22, 0.1)
    HIT(15.45, 0.55, 72, ['F2', 'C3'], 0.9, g=0.75)
    for k, nn in enumerate(('F5', 'Ab5', 'C6')):
        b = bell(hz(nn), 2.6, decay=1.0, index=1.8)
        music.add(b, 15.45 + 0.03 * k, 0.12, pan=-0.3 + 0.3 * k)
        hall.add(b, 15.45 + 0.03 * k, 0.12)
    # typing
    for t0, t1, line in [(15.9, 16.35, 'Hit in 8 of his last 10'), (16.35, 16.8, 'Usage climbs with the starter out'), (16.8, 17.15, 'Fast pace, soft perimeter defense')]:
        for j in range(1, len(line) + 1):
            if line[j - 1] == ' ':
                continue
            sfx.add(tick(rg.uniform(1700, 2600), 0.012, 0.0012), t0 + (t1 - t0) * (j - 0.5) / len(line), 0.045, pan=rg.uniform(-0.3, 0.3))
    for k in range(3):
        sfx.add(blip(600 + 200 * k, 900 + 200 * k, 0.08), 16.55 + 0.12 * k, 0.16, pan=-0.4 + 0.4 * k)
    # 17.2: pull back to the whole board; the music closes down into the cut
    sfx.add(whoosh(0.95, peak=0.55, f_lo=180, f_hi=2400, f_end=260, bw=1.2, pan0=0.6, pan1=-0.6, seed=81), 17.12, 0.6)
    HIT(17.55, 0.5, 82, ['F2', 'C3', 'F3'], 0.9, g=0.65)
    sfx.add(rev_cymbal(0.3, seed=8), 17.7, 0.3)

    # ===== 18 to 22: live. The count climbs past the line
    HIT(18.0, 0.55, 91, None, g=0.7)
    env = np.zeros(int(6.4 * SR))
    te = T(len(env)) + 18.0

    def bump(c, w, h):
        return h * np.exp(-0.5 * ((te - c) / w) ** 2)

    env += np.clip((te - 18.0) / 0.4, 0, 1) * 0.3
    env += bump(19.25, 0.35, 0.3) + bump(20.25, 0.35, 0.35)
    env += np.clip((te - 20.5) / 1.38, 0, 1) ** 1.6 * 0.45 * (te < 21.9)
    env += (te >= 22.0) * (0.9 * np.exp(-(te - 22.0) / 1.1) + 0.25)
    env *= np.where(te > 23.4, np.clip((24.2 - te) / 0.8, 0, 1), 1)
    env *= np.where((te > 21.88) & (te < 22.0), 0.35, 1)
    env = np.convolve(env, np.hanning(481) / np.hanning(481).sum(), mode='same')
    cw = crowd(6.4, env, seed=5)
    crowdb.add(cw, 18.0, 0.55)
    hall.add(cw, 18.0, 0.12)
    # the clock
    for k in range(8):
        sfx.add(tock(1250 if k % 2 == 0 else 980), 18.0 + 0.5 * k, 0.16, pan=0.2)
    # heartbeat, quickening
    for tt in [18.0, 19.0, 20.0, 20.5, 21.0, 21.25, 21.5, 21.625, 21.75]:
        for dt_, g in ((0.0, 0.62), (0.16, 0.42)):
            if tt + dt_ < 21.88:
                K(tt + dt_, g, f0=95, f1=40, decay=0.2, click=0.08)
    # a low pulse under it
    n = int(3.9 * SR)
    tt = T(n)
    pulse = lp(saw(hz('F2'), n) + saw(hz('F2') * 1.005, n), 260) * (0.6 + 0.4 * np.sign(np.sin(2 * np.pi * 4 * tt))) * np.minimum(1, tt / 0.5)
    music.add(fade(pulse * 0.4, 0.01, 0.05), 18.0, 0.5)
    sub = np.sin(2 * np.pi * hz('F1') * tt) * np.minimum(1, tt / 0.3)
    bassb.add(fade(sub, 0.01, 0.05), 18.0, 0.2)
    # 19 and 20: he scores
    for tt, nn in ((19.0, 'C6'), (20.0, 'Eb6')):
        b = bell(hz(nn), 1.6, decay=0.6, index=1.5)
        music.add(b, tt, 0.18)
        hall.add(b, tt, 0.16)
        sfx.add(blip(900, 1800, 0.12), tt, 0.2)
        HIT(tt, 0.3, int(tt * 10), None, g=0.5)
    # 20.5 to 22: the tension
    sfx.add(riser(1.45, f0=300, f1=10000, p0=130, p1=1700, seed=101, curve=2.2), 20.45, 0.5)
    tt = 20.5
    while tt < 21.86:
        u = (tt - 20.5) / 1.38
        s = snare(180 + 140 * u, 0.22, tone=0.35)
        drums.add(s, tt, 0.12 + 0.35 * u ** 1.5)
        room.add(s, tt, 0.1)
        tt += 0.125 if u < 0.45 else 0.0625 if u < 0.8 else 0.03125
    sfx.add(rev_cymbal(0.5, seed=9), 21.5, 0.4)
    st = pad([hz(n) for n in ('F3', 'C4', 'F4', 'Ab4')], 1.38, attack=1.3, release=0.05, cutoff=2200, seed=21)
    music.add(st, 20.5, 0.32)

    # ===== 22.0: past the line. Cashed.
    HIT(22.0, 1.35, 111, ['F1', 'F2', 'C3', 'F3', 'A3'], 2.8)
    cr = cymbal(3.2, 1.4, seed=12)
    drums.add(cr, 22.0, 0.26)
    hall.add(cr, 22.0, 0.08)
    stamp = tom(80, 0.6)
    hits.add(stamp, 22.06, 0.45)
    sp = sparkles(1.6, 90, seed=113, fmin=2200, fmax=10000)
    sfx.add(sp, 22.0, 0.14)
    hall.add(sp, 22.0, 0.08)
    for k, nn in enumerate(('F5', 'A5', 'C6', 'F6')):
        b = bell(hz(nn), 2.4, decay=0.9, index=1.6)
        music.add(b, 22.0 + 0.04 * k, 0.1, pan=-0.45 + 0.3 * k)
        hall.add(b, 22.0 + 0.04 * k, 0.12)
    # the groove comes back for a bar
    p = pad([hz(n) for n in ('F3', 'A3', 'C4', 'G4')], 1.35, attack=0.08, release=0.5, cutoff=3200, seed=7)
    music.add(p, 22.0, 0.36)
    for tt in (22.75, 23.0):
        K(tt, 0.85)
    for tt in (22.5,):
        c = clap()
        drums.add(c, tt, 0.42)
        room.add(c, tt, 0.2)
    for k in range(10):
        drums.add(hat(0.022), 22.0 + k * 0.125, 0.09, pan=0.3)
    for k in range(5):
        bassb.add(bass(hz('F2') * (2 if k % 2 else 1), 0.24, growl=0.7, decay=0.32), 22.0 + 0.25 * k, 0.48)
    for k in range(10):
        f = hz(['F4', 'A4', 'C5', 'G5', 'A5', 'G5', 'C5', 'A4'][k % 8])
        y = pluck(f, 0.5, 0.18, bright=0.8, seed=900 + k)
        music.add(y, 22.0 + 0.125 * k, 0.13, pan=0.35 if k % 2 else -0.35)
        hall.add(y, 22.0 + 0.125 * k, 0.05)
    # into the logo
    sfx.add(riser(0.75, f0=500, f1=11000, p0=220, p1=1760, seed=121, curve=1.8), 23.25, 0.42)
    sfx.add(rev_cymbal(0.7, seed=13), 23.3, 0.5)
    sfx.add(whoosh(0.8, peak=0.75, f_lo=300, f_hi=5000, f_end=2000, bw=0.9, pan0=0.6, pan1=0.0, seed=122), 23.2, 0.3)

    # ===== 24 to 30: the brand
    HIT(24.0, 1.1, 131, ['Db1', 'Db2', 'Ab2', 'Db3'], 3.4)
    cr = cymbal(4.0, 1.8, seed=14)
    drums.add(cr, 24.0, 0.22)
    hall.add(cr, 24.0, 0.12)
    for c0, notes, low, hold in [(24.0, ['Db3', 'Ab3', 'C4', 'F4'], 'Db', 2.0), (26.0, ['Eb3', 'Bb3', 'F4', 'G4'], 'Eb', 2.0), (28.0, ['F3', 'C4', 'G4', 'A4'], 'F', 1.25)]:
        p = pad([hz(n) for n in notes], hold, attack=0.15 if c0 == 24.0 else 0.5, release=1.6 if c0 == 28.0 else 0.6, cutoff=3000, seed=int(c0))
        music.add(p, c0, 0.34)
        hall.add(p, c0, 0.18)
        shimmer = pad([hz(n) * 2 for n in notes], hold, attack=0.8, release=1.6, cutoff=7000, voices=3, cents=8, seed=int(c0) + 1)
        music.add(shimmer, c0, 0.08)
        hall.add(shimmer, c0, 0.1)
        n = int((hold + 0.3) * SR)
        sub = 0.45 * np.sin(2 * np.pi * hz(low + '1') * T(n)) + 0.8 * np.sin(2 * np.pi * hz(low + '2') * T(n)) + 0.22 * np.sin(2 * np.pi * hz(low + '3') * T(n))
        sub *= np.minimum(1, T(n) / 0.05) * np.where(T(n) > hold, np.exp(-(T(n) - hold) / 0.1), 1)
        bassb.add(fade(sub, 0.005, 0.05), c0, 0.42)
    # the light sweeps across the word
    sfx.add(whoosh(0.75, peak=0.55, f_lo=3000, f_hi=12000, f_end=6000, bw=0.5, pan0=-0.9, pan1=0.9, seed=132), 24.5, 0.2)
    sfx.add(sparkles(0.8, 26, seed=133, fmin=5000, fmax=12000), 24.55, 0.07)
    b = bell(hz('Ab6'), 2.5, decay=1.0, index=1.2)
    music.add(b, 25.15, 0.12, pan=0.5)
    hall.add(b, 25.15, 0.14)
    # READ. THE. LINE.: the sound logo, one note a word
    for k, (tt, nn) in enumerate([(25.25, 'Ab4'), (25.5, 'C5'), (25.75, 'F5')]):
        last = k == 2
        hits.add(tom(110 - 10 * k, 0.9), tt, 0.55 + 0.15 * last)
        hall.add(tom(110 - 10 * k, 0.9), tt, 0.1)
        b = braam([hz(nn) / 2, hz(nn)], 0.7 if not last else 1.6, peak=0.05, fc_lo=400, fc_hi=3600, seed=140 + k)
        music.add(b, tt, 0.24 + 0.1 * last)
        hall.add(b, tt, 0.2)
        bl_ = bell(hz(nn) * 2, 2.6 if last else 1.4, decay=1.0 if last else 0.5, index=1.6)
        music.add(bl_, tt, 0.16)
        hall.add(bl_, tt, 0.18)
        kicks.append(tt)
    hits.add(impact(0.35, 145), 25.75, 0.4)
    # 27.6: try it free
    for k, nn in enumerate(('F6', 'C7')):
        b = bell(hz(nn), 2.0, decay=0.8, index=1.0)
        music.add(b, 27.6 + 0.06 * k, 0.12, pan=-0.2 + 0.4 * k)
        hall.add(b, 27.6 + 0.06 * k, 0.16)
    sfx.add(blip(700, 1400, 0.1), 27.6, 0.14)
    # 28: home. One last low swell under the logo, then the room fades
    hits.add(impact(0.5, 151), 28.0, 0.35)
    hall.add(impact(0.5, 151), 28.0, 0.15)

    # ---------------------------------------------------------------- mix
    sc = duck(kicks, depth=0.55, rel=0.14)
    bassb.x *= sc[None, :]
    music.x *= (0.35 + 0.65 * sc)[None, :]
    # the pull-out closes the music down into the cut at 18
    for bus in (music, drums, bassb):
        i0, i1 = int(17.1 * SR), int(18.0 * SR)
        bus.x[:, i0:i1] = sweep_lp(bus.x[:, i0:i1], lambda tt: 16000 * (320 / 16000) ** np.clip((tt - 17.2) / 0.78, 0, 1), 17.1)
        bus.x[:, int(17.97 * SR):int(18.0 * SR)] *= np.linspace(1, 0, int(18.0 * SR) - int(17.97 * SR))
        i0, i1 = int(23.0 * SR), int(24.0 * SR)
        bus.x[:, i0:i1] = sweep_lp(bus.x[:, i0:i1], lambda tt: 16000 * (400 / 16000) ** np.clip((tt - 23.0) / 0.75, 0, 1), 23.0)
    # hard stops: the freeze at 7.5 and the breath before the cash
    for bus in (music, drums, bassb):
        a, b = int(7.5 * SR), int(8.0 * SR)
        bus.x[:, a - 96:a] *= np.linspace(1, 0, 96)
        bus.x[:, a:b] = 0
    for bus in (hits, horns):  # the hit's tail sinks so the drop lands in a near-empty room
        a, b = int(7.62 * SR), int(7.98 * SR)
        bus.x[:, a:b] *= np.linspace(1, 0.22, b - a)[None, :]
        bus.x[:, b:int(8.0 * SR)] *= 0.22
    for bus in (music, drums, bassb):
        a, b = int(21.88 * SR), int(22.0 * SR)
        bus.x[:, a - 96:a] *= np.linspace(1, 0, 96)
        bus.x[:, a:b] *= 0.15
    # the music stops as the logo line flies in
    for bus in (music, drums, bassb, horns):
        a, b = int(23.75 * SR), int(24.0 * SR)
        bus.x[:, a:b] *= np.linspace(1, 0, b - a)[None, :] ** 2

    dry = drums.x * 1.0 + bassb.x * 0.9 + music.x * 1.5 + horns.x * 1.3 + sfx.x * 1.1 + hits.x * 1.0 + crowdb.x * 1.35
    # the glitch at 3.74: stutter, reverse and crush the mix itself
    i0, i1 = int(3.74 * SR), int(4.04 * SR)
    seg = dry[:, i0:i1].copy()
    out = np.zeros_like(seg)
    gr = np.random.default_rng(17)
    pos, src = 0, 0
    blk = int(0.021 * SR)
    while pos < seg.shape[1]:
        L = min(blk * int(gr.integers(1, 3)), seg.shape[1] - pos)
        piece = seg[:, src:src + L] if src + L <= seg.shape[1] else seg[:, seg.shape[1] - L:]
        mode = gr.integers(0, 4)
        if mode == 0:
            piece = piece[:, ::-1]
        elif mode == 1:
            piece = np.round(piece * 5) / 5
        elif mode == 2:
            piece = np.repeat(piece[:, ::7], 7, axis=1)[:, :L]
        out[:, pos:pos + L] = piece * np.hanning(L)[None, :] ** 0.15
        src = src if gr.uniform() < 0.45 else src + L
        pos += L
    dry[:, i0:i1] = out
    # space
    wet = convolve(hall.x, make_ir(2.8, 4.0, seed=11)) * 0.55 + convolve(room.x, make_ir(0.9, 1.4, seed=12, pre=0.008, bright=1.4)) * 0.4
    mix = dry + wet
    mix = hp(mix, 32, 4)
    for ch in range(2):
        mix[ch] = stft_shape(mix[ch], lambda f, tt: (1 - 0.48 / (1 + (f / 95) ** 4)) * (1 + 0.26 * np.exp(-0.5 * (np.log2(np.maximum(f, 20) / 2000) / 1.1) ** 2)) + 0 * tt)
    # fade out at the end
    a = int(29.0 * SR)
    mix[:, a:] *= np.linspace(1, 0, N - a)[None, :] ** 1.5
    mix[:, :int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))[None, :]
    return mix


def master(mix, target=-14.0):
    mix = mix * (0.7 / np.percentile(np.abs(mix), 99.9))
    mix = np.tanh(mix)  # soft saturation: the loudest hits round off instead of clipping
    g = 10 ** ((target - lufs(mix)) / 20)
    for _ in range(6):
        x = limiter(mix * g)
        d = target - lufs(x)
        if abs(d) < 0.1:
            break
        g *= 10 ** (d / 20)
    return x


def main():
    t0 = __import__('time').time()
    mix = build()
    print(f'built in {__import__("time").time() - t0:.1f}s; raw peak {np.abs(mix).max():.2f}, raw loudness {lufs(mix):.1f} LUFS', flush=True)
    out = master(mix)
    print(f'mastered: {lufs(out):.2f} LUFS, true peak {20 * np.log10(true_peak(out)):.2f} dBTP')
    wavfile.write(os.path.join(HERE, 'audio.wav'), SR, out.T.astype(np.float32))
    if len(sys.argv) > 1:
        wavfile.write(os.path.join(HERE, 'audio_raw.wav'), SR, (mix / np.abs(mix).max()).T.astype(np.float32))


if __name__ == '__main__':
    main()

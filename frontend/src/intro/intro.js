/*
 * Propify intro: "Under the lights".
 *
 * About 4.7 seconds, drawn with WebGL. The stadium lights clank on one bank at a
 * time, the camera rushes down a night field past live stat chips, and the Propify
 * logo painted at midfield peels off the turf as thousands of particles. They
 * stand up, the logo ignites (flash, shockwave, flare, sparks), the tagline
 * decodes, then a gold triangle portal opens onto the site while the logo flies
 * into its place in the header.
 *
 * No dependencies. It plays at most once every INTRO_EVERY_HOURS per browser and
 * is always skippable (click, tap or any key). It never runs for reduced motion,
 * data saver or automated browsers. ?intro forces it, ?nointro turns it off.
 * If anything fails (no WebGL, a shader error, a stalled frame), the overlay
 * removes itself and the site is simply there.
 */

import { WORDMARK } from '../brand/wordmark.js'

export const INTRO_EVERY_HOURS = 6
const STORE_KEY = 'apex_intro_at'

/* ---------------------------------------------------------------- timeline */

const T = {
  fly0: 0.1,
  fly1: 2.3,
  banks: [0.44, 0.58, 0.74, 0.86, 1.0, 1.1, 1.42, 1.5],
  chips0: 0.5,
  chips1: 2.05,
  spot: 1.65,
  lift: 1.98,
  wipe: 0.38,
  ignite: 2.9,
  stamp: 3.04,
  tag: 3.08,
  live: 3.26,
  portal: 4.05,
  portalDur: 0.72,
}

/* ---------------------------------------------------------------- the stadium (world units are yards) */

// x, y, z, aimX, aimZ, poolRadius. Side banks light the field, the far pair sits behind the end zone.
const BANKS = [
  [-27, 16, 30, -9, 30, 26],
  [27, 16, 30, 9, 30, 26],
  [-27, 17, 66, -9, 66, 26],
  [27, 17, 66, 9, 66, 26],
  [-27, 18, 102, -9, 100, 27],
  [27, 18, 102, 9, 100, 27],
  [-12, 26, 136, -5, 114, 32],
  [12, 26, 136, 5, 114, 32],
]

// Floating stat chips along the flight path: x, y, z.
const CHIP_SPOTS = [
  [-7.5, 2.2, 12], [8.5, 2.9, 18], [-11, 2.6, 24], [6.5, 1.9, 30],
  [-6, 3.4, 36], [11, 2.4, 41], [-9, 3.0, 47], [5, 3.8, 53],
]

const GENERIC_CHIPS = [
  ['L5', '5/5', 'green'], ['PROPIFY SCORE', '92', 'gold'], ['L10', '9/10', 'green'], ['FAIR ODDS', '-341', 'gold'],
  ['HIT RATE', '80%', 'green'], ['VS DEFENSE', '#3', 'chalk'], ['PROJECTION', '74.5', 'gold'], ['L20', '17/20', 'green'],
]

const TAGLINE = 'EVERY PROP. EVERY EDGE. LIVE.'
const SCRAMBLE = '0123456789+-%./'

const F_NUM = (px) => `800 ${px}px "Big Shoulders Display", Impact, "Arial Narrow", sans-serif`
const F_UI = (w, px) => `${w} ${px}px Barlow, "Helvetica Neue", Arial, sans-serif`

/* ---------------------------------------------------------------- small math */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const lerp = (a, b, t) => a + (b - a) * t
const easeOutCubic = (t) => 1 - (1 - t) ** 3
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2
const easeInOutQuart = (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2)
const easeOutBack = (t, s = 1.7) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------------------------------------------------------------- when to play */

function params() {
  try {
    return new URLSearchParams(window.location.search)
  } catch {
    return new URLSearchParams()
  }
}
function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
function saveData() {
  try {
    return Boolean(navigator.connection && navigator.connection.saveData)
  } catch {
    return false
  }
}
function lastPlayed() {
  try {
    return Number(window.localStorage.getItem(STORE_KEY)) || 0
  } catch {
    return 0
  }
}
function markPlayed() {
  try {
    window.localStorage.setItem(STORE_KEY, String(Date.now()))
  } catch {
    /* private mode */
  }
}

/** Whether the intro should play on this page load. */
export function introWanted({ force = false } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const q = params()
  if (q.has('nointro')) return false
  if (force || q.has('intro')) return true
  if (prefersReducedMotion() || saveData() || navigator.webdriver) return false
  if (document.visibilityState === 'hidden') return false
  return Date.now() - lastPlayed() > INTRO_EVERY_HOURS * 3600e3
}

/** Play the intro if introWanted() says so. Returns the controller or null. */
export function maybePlayIntro(opts = {}) {
  return introWanted(opts) ? playIntro(opts) : null
}

/**
 * Play the intro now.
 * opts.stats      object or promise: { week, games, live, props, chips: [[label, value, tone], ...] }
 * opts.logo       selector for the header wordmark to fly into (default [data-apex-logo])
 * opts.chip       selector for the header league chip (default [data-apex-chip])
 * opts.chipText   the league on that chip (default "NFL")
 * opts.onDone     called once the overlay is gone
 * Returns { done: Promise, skip() } or null when it can't run.
 */
export function playIntro(opts = {}) {
  try {
    return createIntro(opts)
  } catch (err) {
    if (opts.debug) console.warn('[apex intro]', err)
    return null
  }
}

/* ---------------------------------------------------------------- shaders */

const FULL_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uDpr;
vec2 cssCoord() { return vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr; }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`

const FIELD_FS = `${COMMON}
uniform vec3 uEye;
uniform vec3 uFwd;
uniform vec3 uUp;
uniform vec3 uRight;
uniform vec2 uTan;
uniform vec2 uShake;
uniform float uTime;
uniform float uAmb;
uniform float uHaze;
uniform float uCrowd;
uniform float uSpot;
uniform float uMotion;
uniform vec4 uBank[8];
uniform vec4 uAim[8];
uniform vec4 uPool[8];
uniform sampler2D uNums;
uniform sampler2D uLogo;
uniform vec4 uDecalA;
uniform vec4 uMid;
uniform vec4 uEnd;

float aaLine(float d, float w, float f) {
  return 1.0 - smoothstep(w - 0.5 * f, w + 0.5 * f, d);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec4 decal(vec2 g, vec2 c, vec2 size) {
  vec2 uv = vec2((g.x - c.x) / size.x + 0.5, 0.5 - (g.y - c.y) / size.y);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return texture2D(uLogo, clamp(uv, 0.002, 0.998)) * inside;
}

float beam(vec3 ro, vec3 rd, vec3 a, vec3 b, float smax) {
  vec3 ba = b - a;
  vec3 w0 = ro - a;
  float B = dot(rd, ba);
  float C = dot(ba, ba);
  float D = dot(rd, w0);
  float E = dot(ba, w0);
  float den = max(C - B * B, 1e-3);
  float u = clamp((E - B * D) / den, 0.0, 1.0);
  vec3 q = a + ba * u;
  float sq = dot(q - ro, rd);
  float s = clamp(sq, 0.0, smax);
  vec3 p = ro + rd * s;
  float r = mix(0.9, 7.5, u);
  vec3 dd = p - q;
  return exp(-dot(dd, dd) / (r * r)) * (1.0 - 0.6 * u) * step(0.0, sq);
}

vec3 sky(vec3 dir) {
  float e = dir.y;
  vec3 c = mix(vec3(0.030, 0.048, 0.080), vec3(0.006, 0.010, 0.020), smoothstep(0.0, 0.5, e));
  c *= 0.35 + 0.85 * uHaze;
  float az = atan(dir.x, dir.z);
  float rim = 0.064 + 0.03 * (1.0 - cos(az * 2.0)) * 0.5 + 0.0025 * sin(az * 23.0);
  float bowl = 1.0 - smoothstep(rim - 0.003, rim + 0.001, e);
  vec3 stands = vec3(0.015, 0.023, 0.039) * (0.55 + 1.25 * uHaze);
  c = mix(c, stands, bowl);
  vec2 q = vec2(az * 150.0, e * 820.0);
  vec2 id = floor(q);
  vec2 f = fract(q) - 0.5;
  float h = hash12(id);
  float on = step(0.83, h) * bowl * step(0.004, e);
  float tw = pow(max(0.0, sin(uTime * (2.0 + h * 8.0) + h * 60.0)), 28.0);
  c += vec3(1.0, 0.95, 0.86) * on * tw * smoothstep(0.42, 0.0, length(f)) * 1.6 * uCrowd;
  c += vec3(0.95, 0.82, 0.5) * exp(-pow((e - rim) / 0.0035, 2.0)) * 0.10 * uHaze;
  return c;
}

vec3 ground(vec2 g, float s) {
  float pa = uTan.y / (uRes.y * 0.5);
  float fx = s * pa;
  float fz = fx * s / max(uEye.y, 0.2) + uMotion;
  float x = g.x;
  float z = g.y;
  float ax = abs(x);
  float inX = 1.0 - smoothstep(26.67, 26.67 + fx, ax);
  float inZ = smoothstep(0.0, fz, z) * (1.0 - smoothstep(120.0, 120.0 + fz, z));
  float band = mod(floor((z - 10.0) / 5.0), 2.0);
  band = mix(band, 0.5, smoothstep(1.5, 5.0, fz));
  vec3 turf = mix(vec3(0.030, 0.063, 0.102), vec3(0.041, 0.083, 0.130), band);
  float ez = clamp((1.0 - smoothstep(10.0 - fz * 0.5, 10.0 + fz * 0.5, z)) + smoothstep(110.0 - fz * 0.5, 110.0 + fz * 0.5, z), 0.0, 1.0);
  turf = mix(turf, vec3(0.024, 0.043, 0.082), ez);
  float grain = mix(0.86 + 0.28 * vnoise(g * 0.9) * (0.6 + 0.4 * vnoise(g * 0.17)), 1.0, smoothstep(0.4, 1.6, fz));
  turf *= grain;
  vec3 alb = mix(vec3(0.013, 0.022, 0.040), turf, inX * inZ);

  float inPlay = step(10.0, z) * step(z, 110.0) * inX;
  float d5 = abs(fract((z - 10.0) / 5.0 + 0.5) - 0.5) * 5.0;
  float lines = aaLine(d5, 0.06, fz) * inPlay;
  lines = mix(lines, 0.024 * inPlay, smoothstep(2.0, 5.0, fz));
  float d1 = abs(fract(z + 0.5) - 0.5);
  float hm = (1.0 - smoothstep(0.30, 0.30 + fx, abs(ax - 3.08))) + (1.0 - smoothstep(0.30, 0.30 + fx, abs(ax - 25.9)));
  float hashes = aaLine(d1, 0.05, fz) * hm * inPlay * (1.0 - smoothstep(0.6, 1.2, fz));
  float goal = (aaLine(abs(z - 10.0), 0.11, fz) + aaLine(abs(z - 110.0), 0.11, fz)) * inX;
  float endl = (aaLine(abs(z), 0.16, fz) + aaLine(abs(z - 120.0), 0.16, fz)) * inX;
  float side = aaLine(abs(ax - 26.67), 0.16, fx) * step(0.0, z) * step(z, 120.0);
  float chalk = clamp(lines + hashes + goal + endl + side, 0.0, 1.0);

  float n = floor((z - 10.0) / 10.0 + 0.5);
  float zm = 10.0 + n * 10.0;
  float valid = step(0.5, n) * step(n, 9.5);
  float sd = x < 0.0 ? -1.0 : 1.0;
  float a = -sd * (x - sd * 17.0);
  float b = sd * (z - zm);
  vec2 cuv = vec2(b / 3.8 + 0.5, 0.5 - a / 2.0);
  float inCell = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
  float c = (n <= 5.0 ? n : 10.0 - n) - 1.0;
  vec2 cell = vec2(mod(c, 4.0), floor(c / 4.0));
  vec2 auv = (cell + clamp(cuv, 0.02, 0.98)) * vec2(0.25, 0.5);
  float num = texture2D(uNums, auv).a * inCell * valid;
  chalk = max(chalk, num * 0.95);

  vec3 col = mix(alb, vec3(0.86, 0.89, 0.93), chalk);
  vec4 dn = decal(g, uEnd.xy, uEnd.zw) * uDecalA.x;
  vec4 df = decal(g, vec2(uEnd.x, 120.0 - uEnd.y), uEnd.zw) * uDecalA.z;
  vec2 muv = vec2((x - uMid.x) / uMid.z + 0.5, 0.5 - (z - uMid.y) / uMid.w);
  vec4 dm = decal(g, uMid.xy, uMid.zw);
  float keep = smoothstep(uDecalA.w - 0.012, uDecalA.w + 0.012, muv.x);
  float burn = exp(-pow((muv.x - uDecalA.w) / 0.022, 2.0)) * step(0.0005, uDecalA.w) * step(uDecalA.w, 0.999);
  col = col * (1.0 - dn.a) + dn.rgb;
  col = col * (1.0 - df.a) + df.rgb;
  vec4 dk = dm * keep * uDecalA.y;
  col = col * (1.0 - dk.a) + dk.rgb;

  float L = uAmb;
  for (int i = 0; i < 8; i++) {
    vec2 d = g - uPool[i].xy;
    L += uPool[i].w * exp(-dot(d, d) / (uPool[i].z * uPool[i].z));
  }
  vec2 dsp = g - uMid.xy;
  L += uSpot * exp(-dot(dsp, dsp) / 75.0);
  vec3 lit = col * L * vec3(1.0, 0.965, 0.9);
  lit += vec3(1.0, 0.85, 0.32) * dm.a * burn * 2.4 * uDecalA.y;
  float fog = 1.0 - exp(-s * 0.0095);
  vec3 fogc = vec3(0.034, 0.054, 0.088) * (0.3 + uHaze);
  return mix(lit, fogc, fog);
}

void main() {
  vec2 css = cssCoord() - uShake;
  vec2 wc = uRes / uDpr;
  vec2 ndc = vec2(css.x / wc.x * 2.0 - 1.0, 1.0 - css.y / wc.y * 2.0);
  vec3 dir = normalize(uFwd + ndc.x * uTan.x * uRight + ndc.y * uTan.y * uUp);
  float gnd = step(dir.y, -0.0004);
  float s = uEye.y / max(-dir.y, 0.0004);
  vec2 g = uEye.xz + dir.xz * s;
  vec3 col = gnd > 0.5 ? ground(g, s) : sky(dir);
  float smax = gnd > 0.5 ? s : 10000.0;
  vec3 warm = vec3(1.0, 0.93, 0.8);
  float bs = 0.0;
  vec3 glare = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float lv = uBank[i].w;
    if (lv > 0.001) {
      bs += lv * beam(uEye, dir, uBank[i].xyz, uAim[i].xyz, smax);
      vec3 bd = normalize(uBank[i].xyz - uEye);
      float cs = max(dot(dir, bd), 0.0);
      glare += lv * (pow(cs, 160.0) * 0.22 + pow(cs, 18.0) * 0.035) * warm;
    }
  }
  col += warm * bs * 0.07 * (0.55 + 0.45 * uHaze);
  col += glare;
  gl_FragColor = vec4(col, 1.0);
}
`

const POINT_VS = `
attribute vec2 aPos;
attribute float aSize;
attribute vec4 aCol;
attribute float aKind;
uniform vec2 uView;
uniform float uPx;
uniform float uMaxPt;
varying vec4 vCol;
varying float vKind;
void main() {
  gl_Position = vec4(aPos.x / uView.x * 2.0 - 1.0, 1.0 - aPos.y / uView.y * 2.0, 0.0, 1.0);
  gl_PointSize = clamp(aSize * uPx, 1.0, uMaxPt);
  vCol = aCol;
  vKind = aKind;
}
`

const POINT_FS = `
precision mediump float;
varying vec4 vCol;
varying float vKind;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float a = vKind < 0.5 ? exp(-r2 * 3.6) : exp(-r2 * 26.0) * 1.7 + exp(-r2 * 3.2) * 0.32;
  gl_FragColor = vec4(vCol.rgb * vCol.a * a, 0.0);
}
`

const QUAD_VS = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute vec4 aCol;
attribute vec4 aPar;
uniform vec2 uView;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPar;
void main() {
  gl_Position = vec4(aPos.x / uView.x * 2.0 - 1.0, 1.0 - aPos.y / uView.y * 2.0, 0.0, 1.0);
  vUv = aUv;
  vCol = aCol;
  vPar = aPar;
}
`

// Modes: 0 texture, 1 soft glow, 2 ring, 3 anamorphic streak, 4 sheen over a texture's alpha,
// 5 soft ellipse with alpha (darkens under normal blending), 6 vertical streak (turf reflections).
const QUAD_FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPar;
void main() {
  float m = vPar.x;
  vec2 p = vUv * 2.0 - 1.0;
  if (m < 0.5) {
    gl_FragColor = texture2D(uTex, vUv) * vCol;
  } else if (m < 1.5) {
    float a = exp(-dot(p, p) * vPar.y);
    gl_FragColor = vec4(vCol.rgb * vCol.a * a, 0.0);
  } else if (m < 2.5) {
    float d = (length(p) - vPar.y) / vPar.z;
    float a = exp(-d * d) * step(length(p), 1.0);
    gl_FragColor = vec4(vCol.rgb * vCol.a * a, 0.0);
  } else if (m < 3.5) {
    float a = exp(-p.y * p.y * vPar.y) * pow(max(0.0, 1.0 - abs(p.x)), vPar.z);
    gl_FragColor = vec4(vCol.rgb * vCol.a * a, 0.0);
  } else if (m > 4.5 && m < 5.5) {
    float a = (1.0 - smoothstep(vPar.y, 1.0, length(p))) * vCol.a;
    gl_FragColor = vec4(vCol.rgb * a, a);
  } else if (m > 5.5) {
    float a = exp(-p.x * p.x * vPar.y) * pow(max(0.0, 1.0 - abs(p.y)), vPar.z);
    gl_FragColor = vec4(vCol.rgb * vCol.a * a, 0.0);
  } else {
    float t = texture2D(uTex, vUv).a;
    float b = vUv.x + (1.0 - vUv.y) * 0.32 - vPar.y;
    float a = exp(-(b * b) / (vPar.z * vPar.z));
    gl_FragColor = vec4(vCol.rgb * vCol.a * a * t, 0.0);
  }
}
`

const POST_FS = `${COMMON}
uniform float uFlash;
uniform vec3 uFlashCol;
uniform float uGrain;
uniform float uLift;
uniform float uTime;
void main() {
  vec2 css = cssCoord();
  vec2 wc = uRes / uDpr;
  vec2 p = css / wc - 0.5;
  p.x *= wc.x / wc.y;
  float vig = smoothstep(0.38, 1.1, length(p)) * 0.66;
  float n = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0);
  vec3 add = uFlashCol * uFlash + vec3(n * uGrain + uLift);
  gl_FragColor = vec4(add * (1.0 - vig), vig);
}
`

const PORTAL_FS = `${COMMON}
uniform vec2 uCenter;
uniform float uR;
uniform float uRound;
uniform float uRim;
uniform float uMode;
float sdTri(vec2 p, float r) {
  const float k = 1.7320508;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
void main() {
  vec2 css = cssCoord();
  vec2 p = vec2(css.x - uCenter.x, uCenter.y - css.y);
  float d = sdTri(p, uR) - uRound;
  if (uMode < 0.5) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, smoothstep(-1.2, 1.2, d));
  } else {
    float e = (exp(-abs(d) / 5.0) * 0.95 + exp(-abs(d) / 36.0) * 0.38) * uRim;
    gl_FragColor = vec4(vec3(1.0, 0.86, 0.22) * e, e * 0.9);
  }
}
`

/* ---------------------------------------------------------------- styles */

const CSS = `
.apex-intro{position:fixed;inset:0;z-index:2147483000;background:#03060c;cursor:pointer;touch-action:none;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;overflow:hidden}
.apex-intro>canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.apex-intro.is-portal{background:transparent;cursor:default}
.apex-intro__skip{position:absolute;right:max(16px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));z-index:2;display:flex;align-items:center;gap:10px;font:600 12px/1 Barlow,"Helvetica Neue",Arial,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:rgba(232,237,245,.78);background:rgba(6,11,20,.5);border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:10px 14px 10px 16px;cursor:pointer;opacity:0;transform:translateY(6px);transition:opacity .45s ease,transform .45s ease,color .2s,border-color .2s;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.apex-intro__skip.is-on{opacity:1;transform:none}
.apex-intro__skip:hover,.apex-intro__skip:focus-visible{color:#fcd800;border-color:rgba(252,216,0,.6);outline:none}
.apex-intro__skip kbd{font:inherit;font-size:10px;letter-spacing:.08em;color:rgba(232,237,245,.5);border:1px solid rgba(255,255,255,.18);border-radius:5px;padding:3px 5px}
.apex-intro.is-portal .apex-intro__skip{opacity:0;transition-duration:.15s}
.apex-intro-fly{position:fixed;left:0;top:0;z-index:2147483001;pointer-events:none;transform-origin:0 0;will-change:transform}
.apex-intro-fly>canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
@media (hover:none){.apex-intro__skip kbd{display:none}}
`

function injectCss() {
  if (document.getElementById('apex-intro-css')) return
  const s = document.createElement('style')
  s.id = 'apex-intro-css'
  s.textContent = CSS
  document.head.appendChild(s)
}

/* ---------------------------------------------------------------- GL helpers */

function compile(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s)
    gl.deleteShader(s)
    throw new Error(`shader: ${log}`)
  }
  return s
}

function program(gl, vs, fs, attribs) {
  const p = gl.createProgram()
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`)
  const u = {}
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name)
  }
  return { p, u }
}

function makeTexture(gl, source, { mip = false, aniso = null } = {}) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  if (source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  if (mip && source) {
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max))
    }
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  }
  return tex
}

function updateTexture(gl, tex, source) {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
}

function canvas2d(w, h) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  return [c, c.getContext('2d')]
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/* ---------------------------------------------------------------- 2D art (logo, decals, numbers, chips) */

let wordmarkPath = null
function wordmark() {
  if (!wordmarkPath) wordmarkPath = new Path2D(WORDMARK.d)
  return wordmarkPath
}

/** Wordmark box for a given cap height (css px). The path's viewBox is tight to the letters. */
function logoMetrics(h) {
  return { w: (h * WORDMARK.w) / WORDMARK.h, h, s: h / WORDMARK.h }
}

function metalGradient(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, WORDMARK.h)
  g.addColorStop(0, '#fff7cc')
  g.addColorStop(0.16, '#ffe65e')
  g.addColorStop(0.4, '#fcd800')
  g.addColorStop(0.56, '#d89e00')
  g.addColorStop(0.7, '#f6c400')
  g.addColorStop(0.88, '#ffe57a')
  g.addColorStop(1, '#fff4b0')
  return g
}

/** The wordmark in a padded canvas. kind: metal | glow | flat | mask */
function paintLogo(L, kind, scale) {
  const { m, pad } = L
  const [c, ctx] = canvas2d((m.w + pad * 2) * scale, (m.h + pad * 2) * scale)
  ctx.scale(scale, scale)
  ctx.translate(pad, pad)
  ctx.scale(m.s, m.s)
  const path = wordmark()
  if (kind === 'metal') {
    ctx.fillStyle = metalGradient(ctx)
    ctx.fill(path, 'evenodd')
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.fillRect(-10, -1, WORDMARK.w + 20, 6.5)
    ctx.fillStyle = 'rgba(120,70,0,0.18)'
    ctx.fillRect(-10, 93, WORDMARK.w + 20, 8)
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 0.8
    ctx.strokeStyle = 'rgba(110,70,0,0.5)'
    ctx.stroke(path)
  } else if (kind === 'glow') {
    ctx.shadowColor = 'rgba(255,196,0,0.95)'
    ctx.shadowBlur = m.h * 0.3 * scale
    ctx.fillStyle = 'rgba(255,196,0,0.85)'
    ctx.fill(path, 'evenodd')
    ctx.shadowBlur = m.h * 0.08 * scale
    ctx.fill(path, 'evenodd')
    ctx.shadowBlur = 0
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = '#000'
    ctx.fill(path, 'evenodd')
    ctx.globalCompositeOperation = 'source-over'
  } else {
    ctx.fillStyle = kind === 'mask' ? '#fff' : '#fcd800'
    ctx.fill(path, 'evenodd')
  }
  return c
}

/** Field paint: the wordmark centered in a 1024x512 texture, gold with a chalk keyline. */
function paintDecal() {
  const [c, ctx] = canvas2d(1024, 512)
  const s = (1024 * 0.92) / WORDMARK.w
  const w = WORDMARK.w * s
  const h = WORDMARK.h * s
  const x = (1024 - w) / 2
  const y = (512 - h) / 2
  ctx.translate(x, y)
  ctx.scale(s, s)
  const path = wordmark()
  ctx.lineJoin = 'round'
  ctx.lineWidth = 5
  ctx.strokeStyle = 'rgba(236,240,246,0.92)'
  ctx.stroke(path)
  ctx.fillStyle = '#f2c900'
  ctx.fill(path, 'evenodd')
  return { canvas: c, mx: x / 1024, my: y / 512 }
}

function paintNumbers() {
  const [c, ctx] = canvas2d(1024, 256)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.font = F_NUM(118)
  for (let i = 0; i < 5; i++) {
    const cx = (i % 4) * 256 + 128
    const cy = Math.floor(i / 4) * 128 + 66
    const [d1, d2] = String((i + 1) * 10)
    ctx.textAlign = 'right'
    ctx.fillText(d1, cx - 14, cy)
    ctx.textAlign = 'left'
    ctx.fillText(d2, cx + 14, cy)
  }
  return c
}

const TONES = { green: '#2fd47a', gold: '#fcd800', chalk: '#e8edf5', red: '#ff5a5a' }

function paintChips(chips) {
  const [c, ctx] = canvas2d(1024, 512)
  chips.slice(0, 8).forEach(([label, value, tone], i) => {
    const x = (i % 2) * 512 + 16
    const y = Math.floor(i / 2) * 128 + 12
    const w = 480
    const h = 104
    roundRect(ctx, x, y, w, h, 26)
    ctx.fillStyle = 'rgba(8,14,26,0.88)'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.stroke()
    ctx.fillStyle = TONES[tone] || TONES.gold
    ctx.beginPath()
    ctx.arc(x + 34, y + h / 2, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.font = F_UI(600, 30)
    ctx.fillStyle = 'rgba(232,237,245,0.92)'
    let text = String(label).toUpperCase()
    while (ctx.measureText(text).width > w - 210 && text.length > 3) text = `${text.slice(0, -2)}…`
    ctx.fillText(text, x + 58, y + h / 2 + 1)
    ctx.textAlign = 'right'
    ctx.font = F_NUM(56)
    ctx.fillStyle = TONES[tone] || TONES.gold
    ctx.fillText(String(value), x + w - 26, y + h / 2 + 2)
  })
  return c
}

function paintChipBadge(L, scale) {
  const { chipW, chipH, chipFont, chipText } = L
  const p = Math.ceil(chipH * 0.5)
  const [c, ctx] = canvas2d((chipW + p * 2) * scale, (chipH + p * 2) * scale)
  ctx.scale(scale, scale)
  const lw = Math.max(1.2, chipH * 0.055)
  roundRect(ctx, p + lw / 2, p + lw / 2, chipW - lw, chipH - lw, Math.max(3, chipH * 0.19))
  ctx.fillStyle = 'rgba(8,14,24,0.92)'
  ctx.fill()
  ctx.lineWidth = lw
  ctx.strokeStyle = 'rgba(232,237,245,0.62)'
  ctx.stroke()
  ctx.fillStyle = '#f4f6fa'
  ctx.font = F_NUM(chipFont)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(chipText, p + chipW / 2, p + chipH / 2 + chipFont * 0.05)
  return { canvas: c, pad: p }
}

function spacedWidth(ctx, text, sp) {
  let w = 0
  for (const ch of text) w += ctx.measureText(ch).width + sp
  return Math.max(0, w - sp)
}

/* ---------------------------------------------------------------- the intro */

function softwareRenderer(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)
  } catch {
    return false
  }
}

function pickTier(W, H) {
  const dpr = window.devicePixelRatio || 1
  const ua = navigator.userAgent || ''
  const mobile = /Mobi|Android|iPhone|iPod/i.test(ua) || Math.min(W, H) < 600
  const cores = navigator.hardwareConcurrency || 4
  if (mobile && cores <= 4) return { name: 'low', dpr: Math.min(dpr, 1.25), particles: 1500, maxPx: 1.0e6 }
  if (mobile) return { name: 'mid', dpr: Math.min(dpr, 1.6), particles: 2400, maxPx: 1.5e6 }
  return { name: 'high', dpr: Math.min(dpr, 2), particles: 4200, maxPx: 3.4e6 }
}

function normalizeStats(s) {
  if (!s || typeof s !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null)
  const out = { week: num(s.week), games: num(s.games), live: num(s.live), props: num(s.props), chips: null }
  if (Array.isArray(s.chips)) {
    const chips = s.chips
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map(([a, b, tone]) => [String(a).slice(0, 40), String(b).slice(0, 8), tone || 'gold'])
    if (chips.length) out.chips = chips
  }
  return out
}

function createIntro(opts) {
  const q = params()
  const chipText = String(opts.chipText || 'NFL').toUpperCase().slice(0, 6)
  const seekMode = q.get('intro') === 'seek'
  const W0 = document.documentElement.clientWidth || window.innerWidth
  const H0 = window.innerHeight || document.documentElement.clientHeight
  if (!W0 || !H0) return null

  const tier = opts.tier || pickTier(W0, H0)
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  const forced = Boolean(opts.force) || q.has('intro')
  const glOpts = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    // No GPU (software rendering) means a slideshow, so skip the intro unless it was asked for.
    failIfMajorPerformanceCaveat: !forced,
  }
  const gl = canvas.getContext('webgl', glOpts) || canvas.getContext('experimental-webgl', glOpts)
  if (!gl) return null
  if (!forced && softwareRenderer(gl)) return null
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')

  const progs = {
    field: program(gl, FULL_VS, FIELD_FS, ['aPos']),
    points: program(gl, POINT_VS, POINT_FS, ['aPos', 'aSize', 'aCol', 'aKind']),
    quads: program(gl, QUAD_VS, QUAD_FS, ['aPos', 'aUv', 'aCol', 'aPar']),
    post: program(gl, FULL_VS, POST_FS, ['aPos']),
    portal: program(gl, FULL_VS, PORTAL_FS, ['aPos']),
  }
  const maxPoint = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || [1, 64])[1]

  const fullBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, fullBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const pointBuf = gl.createBuffer()
  const quadBuf = gl.createBuffer()

  /* ---------- DOM ---------- */
  injectCss()
  const root = document.createElement('div')
  root.className = 'apex-intro'
  root.appendChild(canvas)
  const skipBtn = document.createElement('button')
  skipBtn.type = 'button'
  skipBtn.className = 'apex-intro__skip'
  skipBtn.innerHTML = 'Skip intro <kbd>Esc</kbd>'
  root.appendChild(skipBtn)
  document.body.appendChild(root)

  /* ---------- state ---------- */
  let W = W0
  let H = H0
  let pxRatio = 1
  let L = null
  let stats = null
  let art = null
  let parts = null
  let portalAt = T.portal
  let skipped = false
  let finished = false
  let t = 0
  let raf = 0
  let lastNow = 0
  let frames = 0
  let slowFrames = 0
  let degraded = false
  let flyer = null
  let flyerTried = false
  let resolveDone
  const done = new Promise((r) => {
    resolveDone = r
  })
  const assets = { ready: false, at: 0, chipsLive: false }
  const tex = {
    blank: makeTexture(gl, null),
    nums: null,
    decal: null,
    chips: null,
    metal: null,
    glow: null,
    badge: null,
    tag: null,
    live: null,
  }

  const MAXP = 8 * 12 + 300 + tier.particles * 3 + Math.ceil(tier.particles * 0.26) * 2 + 64
  const pts = new Float32Array(MAXP * 8)
  let np = 0
  const quadData = new Float32Array(160 * 6 * 12)
  let nq = 0

  function resize() {
    W = document.documentElement.clientWidth || window.innerWidth
    H = window.innerHeight || document.documentElement.clientHeight
    const budget = Math.sqrt(tier.maxPx / Math.max(1, W * H))
    pxRatio = Math.max(0.5, Math.min(tier.dpr, budget) * (degraded ? 0.6 : 1))
    canvas.width = Math.round(W * pxRatio)
    canvas.height = Math.round(H * pxRatio)
  }
  resize()

  /* ---------- layout ---------- */
  const [, measureCtx] = canvas2d(4, 4)
  function makeLayout() {
    const portrait = H > W * 1.05
    const maxW = Math.min(W * (portrait ? 0.7 : 0.5), 820)
    const m = logoMetrics((maxW * WORDMARK.h) / WORDMARK.w)
    const size = m.h
    const chipH = Math.round(m.h * 0.5)
    const chipFont = Math.round(chipH * 0.66)
    measureCtx.font = F_NUM(chipFont)
    const chipW = Math.round(measureCtx.measureText(chipText).width + chipH * 0.62)
    const gap = Math.round(m.h * 0.17)
    const lockW = m.w + gap + chipW
    const cx = W / 2
    const cy = H * (portrait ? 0.42 : 0.43)
    const logoX = cx - lockW / 2
    const logoY = cy - m.h / 2
    const tagSize = Math.max(12, Math.round(m.h * 0.15))
    const liveSize = Math.max(11, Math.round(m.h * 0.105))
    const tagY = logoY + m.h + Math.max(24, m.h * 0.46)
    return {
      portrait,
      m,
      size,
      pad: Math.ceil(size * 0.5),
      chipW,
      chipH,
      chipFont,
      chipText,
      gap,
      lockW,
      cx,
      cy,
      logoX,
      logoY,
      logoCx: logoX + m.w / 2,
      chipX: logoX + m.w + gap,
      chipY: logoY + (m.h - chipH) / 2,
      tagSize,
      liveSize,
      tagY,
      liveY: tagY + tagSize * 1.25 + Math.max(10, liveSize * 1.1),
      tagSpacing: tagSize * (W < 520 ? 0.24 : 0.36),
      // The painted midfield logo and end-zone paint, in yards.
      midW: portrait ? 9.5 : 14,
      midZ: 60,
    }
  }

  /* ---------- assets (need the web fonts) ---------- */
  function buildArt() {
    L = makeLayout()
    const scale = pxRatio
    const metal = paintLogo(L, 'metal', scale)
    const glow = paintLogo(L, 'glow', scale)
    const flat = paintLogo(L, 'flat', scale)
    const mask = paintLogo(L, 'mask', 1)
    const decal = paintDecal()
    const badge = paintChipBadge(L, scale)
    const [tagC, tagX] = canvas2d(Math.min(W * 0.96, 1400) * scale, L.tagSize * 1.7 * scale)
    const [liveC, liveX] = canvas2d(Math.min(W * 0.96, 1400) * scale, L.liveSize * 1.9 * scale)
    art = { metal, glow, flat, mask, decal, badge, tagC, tagX, liveC, liveX, scale }
    tex.metal = makeTexture(gl, metal)
    tex.glow = makeTexture(gl, glow)
    tex.badge = makeTexture(gl, badge.canvas)
    tex.decal = makeTexture(gl, decal.canvas, { mip: true, aniso })
    tex.nums = makeTexture(gl, paintNumbers(), { mip: true, aniso })
    tex.chips = makeTexture(gl, paintChips((stats && stats.chips) || GENERIC_CHIPS))
    assets.chipsLive = Boolean(stats && stats.chips)
    tex.tag = makeTexture(gl, tagC)
    tex.live = makeTexture(gl, liveC)
    parts = buildParticles(mask)
    assets.ready = true
    assets.at = t
  }

  function buildParticles(mask) {
    const { m, pad } = L
    const ctx = mask.getContext('2d')
    const img = ctx.getImageData(0, 0, mask.width, mask.height).data
    const cand = []
    for (let y = 0; y < mask.height; y += 1) {
      for (let x = 0; x < mask.width; x += 1) {
        if (img[(y * mask.width + x) * 4 + 3] > 150) cand.push(x, y)
      }
    }
    const count = cand.length / 2
    const N = Math.min(tier.particles, Math.max(200, count))
    const step = Math.max(1, Math.sqrt(count / (N * 1.25)))
    const R = rng(7)
    const pick = []
    for (let y = 0; y < mask.height; y += step) {
      for (let x = 0; x < mask.width; x += step) {
        const jx = Math.min(mask.width - 1, Math.round(x + (R() - 0.5) * step))
        const jy = Math.min(mask.height - 1, Math.round(y + (R() - 0.5) * step))
        if (img[(jy * mask.width + jx) * 4 + 3] > 150) pick.push([jx, jy])
      }
    }
    for (let i = pick.length - 1; i > 0; i--) {
      const j = Math.floor(R() * (i + 1))
      const tmp = pick[i]
      pick[i] = pick[j]
      pick[j] = tmp
    }
    const chosen = pick.slice(0, N).sort((a, b) => a[0] - b[0])
    const n = chosen.length
    const P = {
      n,
      tx: new Float32Array(n),
      ty: new Float32Array(n),
      wx: new Float32Array(n),
      wz: new Float32Array(n),
      delay: new Float32Array(n),
      dur: new Float32Array(n),
      rise: new Float32Array(n),
      ox: new Float32Array(n),
      oy: new Float32Array(n),
      size: new Float32Array(n),
      seed: new Float32Array(n),
      spin: new Float32Array(n),
      spark: new Uint8Array(n),
      svx: new Float32Array(n),
      svy: new Float32Array(n),
      slife: new Float32Array(n),
    }
    const midW = L.midW
    const midD = midW / 2
    const dm = art.decal
    for (let i = 0; i < n; i++) {
      const [px, py] = chosen[i]
      const gx = px - pad
      const gy = py - pad
      const u = gx / m.w
      const v = gy / m.h
      P.tx[i] = gx
      P.ty[i] = gy
      const tu = dm.mx + u * (1 - 2 * dm.mx)
      const tv = dm.my + v * (1 - 2 * dm.my)
      P.wx[i] = (tu - 0.5) * midW
      P.wz[i] = L.midZ + (0.5 - tv) * midD
      P.delay[i] = Math.max(0, u) * T.wipe + R() * 0.04
      P.dur[i] = 0.34 + R() * 0.1
      P.rise[i] = 90 + R() * 170
      P.ox[i] = (R() - 0.5) * 60
      P.oy[i] = 30 + R() * 70
      P.size[i] = 2.0 + R() * 1.8
      P.seed[i] = R() * 1000
      P.spin[i] = (R() - 0.5) * 0.5
      if (R() < 0.24) {
        P.spark[i] = 1
        const ang = Math.atan2(gy - m.h / 2, gx - m.w / 2)
        const sp = 240 + R() * 760
        P.svx[i] = Math.cos(ang) * sp * (0.7 + R() * 0.6)
        P.svy[i] = Math.sin(ang) * sp * 0.6 - (120 + R() * 380)
        P.slife[i] = 0.5 + R() * 0.7
      }
    }
    return P
  }

  const fontsReady = (() => {
    const fonts = document.fonts
    if (!fonts || typeof fonts.load !== 'function') return Promise.resolve()
    const loads = [F_NUM(100), F_UI(600, 100)].map((f) =>
      fonts.load(f).catch(() => null),
    )
    return Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 1100))])
  })()

  Promise.resolve(opts.stats)
    .then((s) => {
      stats = normalizeStats(s)
      if (assets.ready && stats && stats.chips && !assets.chipsLive && t < T.chips0 + 0.1 && !finished) {
        updateTexture(gl, tex.chips, paintChips(stats.chips))
        assets.chipsLive = true
      }
    })
    .catch(() => {})

  /* ---------- camera ---------- */
  function cameraAt(tt) {
    const k = easeInOutCubic(clamp01((tt - T.fly0) / (T.fly1 - T.fly0)))
    const e = easeInOutSine(clamp01((tt - T.fly0) / (T.fly1 - T.fly0)))
    const hold = Math.max(0, tt - T.fly1)
    const u = clamp01((tt - T.fly0) / (T.fly1 - T.fly0))
    return {
      x: Math.sin(tt * 1.6) * 0.4 * (1 - k),
      y: lerp(1.0, 4.0, e) + hold * 0.12,
      z: lerp(-8, 46.5, k) + hold * 0.9,
      pitch: lerp(0.03, 0.14, e) + hold * 0.004,
      roll: -0.055 * Math.sin(Math.PI * clamp01((u - 0.2) / 0.7)) ** 2,
    }
  }

  const view = {
    eye: [0, 0, 0],
    fwd: [0, 0, 1],
    up: [0, 1, 0],
    right: [1, 0, 0],
    tanX: 1,
    tanY: 1,
    sx: 0,
    sy: 0,
  }
  function setView(cam, zoom, shx, shy) {
    const cp = Math.cos(cam.pitch)
    const sp = Math.sin(cam.pitch)
    view.eye[0] = cam.x
    view.eye[1] = cam.y
    view.eye[2] = cam.z
    const cr = Math.cos(cam.roll || 0)
    const sr = Math.sin(cam.roll || 0)
    view.fwd[0] = 0
    view.fwd[1] = -sp
    view.fwd[2] = cp
    // roll around the view axis: right = r0 cos + u0 sin, up = u0 cos - r0 sin (r0 = x axis, u0 = pitched up)
    view.right[0] = cr
    view.right[1] = cp * sr
    view.right[2] = sp * sr
    view.up[0] = -sr
    view.up[1] = cp * cr
    view.up[2] = sp * cr
    const aspect = W / H
    const fovY = aspect < 1 ? 70 : aspect < 1.3 ? 62 : 56
    view.tanY = Math.tan(((fovY / 2) * Math.PI) / 180) / zoom
    view.tanX = view.tanY * aspect
    view.sx = shx
    view.sy = shy
  }
  const proj = [0, 0, 0]
  function project(x, y, z) {
    const dx = x - view.eye[0]
    const dy = y - view.eye[1]
    const dz = z - view.eye[2]
    const zc = dx * view.fwd[0] + dy * view.fwd[1] + dz * view.fwd[2]
    if (zc < 0.05) return null
    const xc = dx * view.right[0] + dy * view.right[1] + dz * view.right[2]
    const yc = dx * view.up[0] + dy * view.up[1] + dz * view.up[2]
    proj[0] = W / 2 + (xc / zc / view.tanX) * (W / 2) + view.sx
    proj[1] = H / 2 - (yc / zc / view.tanY) * (H / 2) + view.sy
    proj[2] = zc
    return proj
  }

  /* ---------- per-frame drawing helpers ---------- */
  function point(x, y, size, r, g, b, a, kind) {
    if (np >= MAXP || a <= 0.002) return
    const o = np * 8
    pts[o] = x
    pts[o + 1] = y
    pts[o + 2] = size
    pts[o + 3] = r
    pts[o + 4] = g
    pts[o + 5] = b
    pts[o + 6] = a
    pts[o + 7] = kind
    np++
  }

  function quad(x, y, w, h, col, mode, p1 = 0, p2 = 0, p3 = 0, uv = null) {
    if (nq >= 160) return
    const u0 = uv ? uv[0] : 0
    const v0 = uv ? uv[1] : 0
    const u1 = uv ? uv[2] : 1
    const v1 = uv ? uv[3] : 1
    const corners = [
      [x, y, u0, v0],
      [x + w, y, u1, v0],
      [x, y + h, u0, v1],
      [x + w, y, u1, v0],
      [x + w, y + h, u1, v1],
      [x, y + h, u0, v1],
    ]
    let o = nq * 72
    for (const c of corners) {
      quadData[o++] = c[0]
      quadData[o++] = c[1]
      quadData[o++] = c[2]
      quadData[o++] = c[3]
      quadData[o++] = col[0]
      quadData[o++] = col[1]
      quadData[o++] = col[2]
      quadData[o++] = col[3]
      quadData[o++] = mode
      quadData[o++] = p1
      quadData[o++] = p2
      quadData[o++] = p3
    }
    nq++
  }

  function blendNormal() {
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE)
  }
  function blendAdd() {
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE)
  }

  function flushQuads(texture, additive) {
    if (!nq) return
    const pr = progs.quads
    gl.useProgram(pr.p)
    gl.uniform2f(pr.u.uView, W, H)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture || tex.blank)
    gl.uniform1i(pr.u.uTex, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
    gl.bufferData(gl.ARRAY_BUFFER, quadData.subarray(0, nq * 72), gl.DYNAMIC_DRAW)
    const stride = 48
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32)
    if (additive) blendAdd()
    else blendNormal()
    gl.drawArrays(gl.TRIANGLES, 0, nq * 6)
    nq = 0
  }

  function flushPoints() {
    if (!np) return
    const pr = progs.points
    gl.useProgram(pr.p)
    gl.uniform2f(pr.u.uView, W, H)
    gl.uniform1f(pr.u.uPx, pxRatio)
    gl.uniform1f(pr.u.uMaxPt, maxPoint)
    gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf)
    gl.bufferData(gl.ARRAY_BUFFER, pts.subarray(0, np * 8), gl.DYNAMIC_DRAW)
    const stride = 32
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 12)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28)
    blendAdd()
    gl.drawArrays(gl.POINTS, 0, np)
    np = 0
  }

  function fullscreen(pr) {
    gl.useProgram(pr.p)
    gl.bindBuffer(gl.ARRAY_BUFFER, fullBuf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i)
    gl.uniform2f(pr.u.uRes, canvas.width, canvas.height)
    gl.uniform1f(pr.u.uDpr, pxRatio)
  }

  function bankLevel(tt, i) {
    const dt = tt - T.banks[i]
    if (dt < 0) return 0
    if (dt < 0.18) {
      const f = Math.floor(dt * 55)
      return hash(i * 17.3 + f * 3.1) > 0.42 ? 0.55 + 0.45 * hash(i + f * 0.7) : 0.04
    }
    return 1 + 0.5 * Math.exp(-(dt - 0.18) * 9)
  }

  /* ---------- the frame ---------- */
  const bankU = new Float32Array(32)
  const aimU = new Float32Array(32)
  const poolU = new Float32Array(32)
  const levels = new Float32Array(8)

  function portalState(tt) {
    const k = clamp01((tt - portalAt) / T.portalDur)
    return { on: tt >= portalAt, k, q: easeInOutQuart(k) }
  }

  function render(tt) {
    const P = portalState(tt)
    if (P.on && !flyerTried) startFlyer()
    const ign = tt - T.ignite
    const shk = ign > 0 && ign < 0.7 ? Math.exp(-ign * 9) : 0
    const shx = shk * 7 * Math.sin(ign * 91)
    const shy = shk * 6 * Math.cos(ign * 73)
    const cam = cameraAt(tt)
    setView(cam, 1 + 0.65 * P.q * P.q, shx, shy)
    const speed = Math.abs(cameraAt(tt + 0.01).z - cameraAt(tt - 0.01).z) / 0.02

    let total = 0
    for (let i = 0; i < 8; i++) {
      const lv = bankLevel(tt, i)
      levels[i] = lv
      total += Math.min(lv, 1)
      const b = BANKS[i]
      bankU.set([b[0], b[1], b[2], lv], i * 4)
      aimU.set([b[3], 0, b[4], 0], i * 4)
      poolU.set([b[3], b[4], b[5], 0.62 * Math.min(lv, 1.25)], i * 4)
    }
    const haze = Math.min(1, total / 5)

    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)

    /* field + sky */
    const f = progs.field
    fullscreen(f)
    gl.uniform3fv(f.u.uEye, view.eye)
    gl.uniform3fv(f.u.uFwd, view.fwd)
    gl.uniform3fv(f.u.uUp, view.up)
    gl.uniform3fv(f.u.uRight, view.right)
    gl.uniform2f(f.u.uTan, view.tanX, view.tanY)
    gl.uniform2f(f.u.uShake, shx, shy)
    gl.uniform1f(f.u.uTime, tt)
    gl.uniform1f(f.u.uAmb, 0.016 + 0.024 * clamp01((tt - 0.1) / 0.5))
    gl.uniform1f(f.u.uHaze, haze)
    gl.uniform1f(f.u.uCrowd, clamp01((tt - 1.25) / 0.6))
    gl.uniform1f(f.u.uSpot, 0.95 * clamp01((tt - T.spot) / 0.4))
    gl.uniform1f(f.u.uMotion, speed / 60)
    gl.uniform4fv(f.u.uBank, bankU)
    gl.uniform4fv(f.u.uAim, aimU)
    gl.uniform4fv(f.u.uPool, poolU)
    const ready = assets.ready
    const da = ready ? clamp01((tt - assets.at) / 0.25) : 0
    const wipeK = clamp01((tt - T.lift) / T.wipe)
    const wipe = wipeK > 0 ? (art ? art.decal.mx : 0.03) + wipeK * (1 - 2 * (art ? art.decal.mx : 0.03)) + (wipeK >= 1 ? 0.06 : 0) : 0
    gl.uniform4f(f.u.uDecalA, da * 0.9, da, da * 0.85, wipe)
    const midW = L ? L.midW : 14
    gl.uniform4f(f.u.uMid, 0, 60, midW, midW / 2)
    gl.uniform4f(f.u.uEnd, 0, 5, 30, 15)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex.nums || tex.blank)
    gl.uniform1i(f.u.uNums, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, tex.decal || tex.blank)
    gl.uniform1i(f.u.uLogo, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)

    gl.enable(gl.BLEND)

    /* floating stat chips */
    if (ready && tex.chips && tt > T.chips0 && tt < T.chips1 + 0.05) {
      const out = 1 - clamp01((tt - (T.chips1 - 0.25)) / 0.25)
      const order = CHIP_SPOTS.map((c, i) => [c, i]).sort((a, b) => b[0][2] - a[0][2])
      for (const [c, i] of order) {
        const p = project(c[0], c[1], c[2])
        if (!p) continue
        const depth = p[2]
        const w = (3.4 / depth / view.tanX) * (W / 2)
        const big = clamp01((Math.min(W * 0.36, 460) - w) / 120)
        const a = clamp01((56 - depth) / 16) * clamp01((depth - 3) / 3) * big * out * clamp01((tt - T.chips0) / 0.3)
        if (a <= 0.01) continue
        const h = w * (104 / 480)
        const cu = (i % 2) * 0.5
        const cv = Math.floor(i / 2) * 0.25
        quad(p[0] - w / 2, p[1] - h / 2, w, h, [a, a, a, a], 0, 0, 0, 0, [
          cu + 16 / 1024,
          cv + 12 / 512,
          cu + 496 / 1024,
          cv + 116 / 512,
        ])
      }
      flushQuads(tex.chips, false)
    }

    /* bank halos, power-on streaks, the opening horizon beam */
    for (let i = 0; i < 8; i++) {
      const lv = levels[i]
      if (lv <= 0.01) continue
      const b = BANKS[i]
      const p = project(b[0], b[1] + 0.6, b[2])
      if (!p) continue
      const s = Math.min(900, (12 / p[2] / view.tanY) * (H / 2))
      const surge = 1 + (ign > 0 ? 0.6 * Math.exp(-ign * 5) : 0)
      quad(p[0] - s, p[1] - s, s * 2, s * 2, [1, 0.92, 0.78, 0.34 * Math.min(lv, 1.3) * surge], 1, 5.5)
      const dt = tt - T.banks[i]
      const streak = dt > 0.15 ? Math.exp(-(dt - 0.15) * 5) : 0.35
      if (streak > 0.02) {
        const sw = Math.min(W * 0.7, s * 7)
        quad(p[0] - sw / 2, p[1] - 22, sw, 44, [0.88, 0.92, 1, 0.5 * streak], 3, 90, 2.4)
      }
      const hy = H / 2 - (Math.tan(cam.pitch) / view.tanY) * (H / 2) + shy
      if (p[1] < hy) {
        const ry = hy + (hy - p[1]) * 0.55
        const rh = Math.min(H * 0.6, (hy - p[1]) * 1.6 + s * 0.4)
        const rw = Math.max(10, s * 0.5)
        quad(p[0] - rw / 2, ry - rh / 2, rw, rh, [1, 0.9, 0.72, 0.16 * Math.min(lv, 1.2) * surge], 6, 9, 1.6)
      }
    }
    const horizon = H / 2 - (Math.tan(cam.pitch) / view.tanY) * (H / 2) + shy
    const bk = clamp01((tt - 0.03) / 0.5)
    const beamA = clamp01(1 - (tt - 0.66) / 0.45)
    if (bk > 0 && beamA > 0) {
      const len = W * 1.02 * easeInOutCubic(bk)
      quad(W / 2 - len / 2, horizon - 1.5, len, 3, [1, 0.95, 0.7, beamA], 3, 1, 0.5)
      quad(W / 2 - len / 2, horizon - 46, len, 92, [0.99, 0.82, 0.2, 0.42 * beamA], 3, 10, 0.8)
      const hs = 46 * beamA
      for (const sx of [W / 2 - len / 2, W / 2 + len / 2]) {
        quad(sx - hs, horizon - hs, hs * 2, hs * 2, [1, 0.95, 0.78, 0.95 * beamA * (1 - bk * 0.7)], 1, 7)
        quad(sx - hs * 3, horizon - 6, hs * 6, 12, [1, 0.95, 0.8, 0.6 * beamA * (1 - bk * 0.7)], 3, 6, 2)
      }
      const ig = clamp01(1 - tt / 0.35)
      quad(W / 2 - 160, horizon - 160, 320, 320, [1, 0.85, 0.3, 0.55 * ig * bk], 1, 5)
    }
    flushQuads(null, true)

    /* a dark stage behind the lockup so the logo and text read cleanly */
    if (L && tt > T.lift + 0.25) {
      const st = clamp01((tt - (T.lift + 0.25)) / 0.6) * (1 - P.q)
      const sw = L.lockW * 1.75
      const sh = (L.liveY - L.logoY + L.m.h) * 2.1
      quad(L.cx - sw / 2, (L.logoY + L.liveY) / 2 - sh / 2, sw, sh, [0.008, 0.014, 0.028, 0.55 * st], 5, 0.15)
      if (tt > T.tag - 0.1) {
        const pa = clamp01((tt - (T.tag - 0.1)) / 0.3) * (1 - P.q)
        const pw = Math.min(W * 1.05, L.lockW * 1.35)
        const top = L.tagY - L.tagSize * 2.2
        const bot = L.liveY + L.liveSize * 2.4
        quad(L.cx - pw / 2, top, pw, bot - top, [0.006, 0.011, 0.022, 0.8 * pa], 5, 0.42)
      }
      flushQuads(null, false)
    }

    /* lamps, dust, logo particles, sparks */
    for (let i = 0; i < 8; i++) {
      const lv = levels[i]
      if (lv <= 0.01) continue
      const b = BANKS[i]
      const ax = b[4] - b[2]
      const az = -(b[3] - b[0])
      const al = Math.hypot(ax, az) || 1
      const sx = ax / al
      const sz = az / al
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 6; c++) {
          const off = (c - 2.5) * 1.3
          const p = project(b[0] + sx * off, b[1] + r * 1.2, b[2] + sz * off)
          if (!p) continue
          const size = Math.max(2, Math.min(64, (1.15 / p[2] / view.tanY) * (H / 2)))
          const flick = 0.85 + 0.15 * hash(i * 13 + r * 7 + c + Math.floor(tt * 24))
          point(p[0], p[1], size, 1, 0.95, 0.85, Math.min(1.4, lv) * flick, 1)
        }
      }
    }
    if (tt > 0.45) {
      const dustA = haze * 0.55 * (1 - P.q)
      for (let i = 0; i < 260; i++) {
        const x = (hash(i * 1.7) - 0.5) * 56
        const y = 0.3 + hash(i * 2.3) * 11 + Math.sin(tt * 0.6 + i) * 0.25
        const z = -4 + hash(i * 3.1) * 130
        const p = project(x, y, z)
        if (!p || p[2] < 1.2) continue
        const size = Math.max(1, Math.min(7, 14 / p[2]))
        const tw = 0.5 + 0.5 * Math.sin(tt * (1.5 + hash(i) * 3) + i)
        point(p[0], p[1], size, 1, 0.94, 0.82, dustA * (0.25 + 0.5 * tw) * clamp01((90 - p[2]) / 40), 0)
      }
    }
    if (parts && tt >= T.lift) drawParticles(tt, P)
    flushPoints()

    /* the logo */
    if (ready && tt >= T.ignite - 0.02 && !(flyer && P.on)) drawLogo(tt, P)

    /* tagline + live line */
    if (ready && tt >= T.tag) drawText(tt, P)

    /* post: vignette, grain, flash, exposure kicks */
    const pp = progs.post
    fullscreen(pp)
    let lift = 0
    for (let i = 0; i < 8; i++) {
      const dt = tt - T.banks[i] - 0.18
      if (dt > 0) lift += 0.028 * Math.exp(-dt * 10)
    }
    const flash = ign > 0 ? 0.12 * Math.exp(-ign * 16) : 0
    gl.uniform1f(pp.u.uFlash, flash)
    gl.uniform3f(pp.u.uFlashCol, 1, 0.93, 0.72)
    gl.uniform1f(pp.u.uGrain, 0.028)
    gl.uniform1f(pp.u.uLift, lift)
    gl.uniform1f(pp.u.uTime, tt)
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    /* portal */
    if (P.on) {
      const pr = progs.portal
      fullscreen(pr)
      const cx = W / 2
      const cy = L ? L.cy : H / 2
      const far = Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy))
      const rMax = far * 1.7320508 * 1.12 + 40
      const r = P.q * rMax
      gl.uniform2f(pr.u.uCenter, cx, cy)
      gl.uniform1f(pr.u.uR, r)
      gl.uniform1f(pr.u.uRound, Math.min(28, r * 0.12))
      gl.uniform1f(pr.u.uRim, Math.sin(Math.PI * Math.min(1, P.k * 1.05)) ** 0.6)
      gl.uniform1f(pr.u.uMode, 0)
      gl.blendFuncSeparate(gl.ZERO, gl.SRC_ALPHA, gl.ZERO, gl.SRC_ALPHA)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.uniform1f(pr.u.uMode, 1)
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    updateFlyer(tt, P)
  }

  function particleAt(i, tt, s, tx, ty, cx, cy, out) {
    const k = clamp01((tt - (T.lift + parts.delay[i])) / parts.dur[i])
    if (k >= 1 || !s) {
      out[0] = tx
      out[1] = ty
      return k
    }
    const e = easeInOutCubic(k)
    const i1 = 1 - e
    const c1x = s[0] + parts.ox[i] * 0.2
    const c1y = s[1] - parts.rise[i]
    const c2x = tx + parts.ox[i]
    const c2y = ty - parts.oy[i]
    let x = i1 * i1 * i1 * s[0] + 3 * i1 * i1 * e * c1x + 3 * i1 * e * e * c2x + e * e * e * tx
    let y = i1 * i1 * i1 * s[1] + 3 * i1 * i1 * e * c1y + 3 * i1 * e * e * c2y + e * e * e * ty
    // swirl into place around the logo's center
    const spin = parts.spin[i] * (1 - e) * (1 - e)
    const c = Math.cos(spin)
    const sn = Math.sin(spin)
    const dx = x - cx
    const dy = (y - cy) * 1.6
    x = cx + dx * c - dy * sn
    y = cy + (dx * sn + dy * c) / 1.6
    out[0] = x
    out[1] = y
    return k
  }

  const pa = [0, 0]
  function drawParticles(tt, P) {
    const { m } = L
    const pop = logoPop(tt)
    const lx = L.logoX
    const ly = L.logoY
    const ign = tt - T.ignite
    const fadeP = ign > 0 ? 1 - clamp01(ign / 0.1) : 1
    const charge = clamp01((tt - (T.ignite - 0.22)) / 0.22)
    const cx = L.logoX + m.w / 2
    const cy = L.logoY + m.h / 2
    const stride = degraded ? 2 : 1
    const trails = degraded || tier.name === 'low' ? 1 : 2
    const fade = 1 - P.q
    for (let i = 0; i < parts.n; i += stride) {
      const t0 = T.lift + parts.delay[i]
      if (tt < t0) continue
      const tx = cx + (lx + parts.tx[i] - cx) * pop
      const ty = cy + (ly + parts.ty[i] - cy) * pop
      if (fadeP > 0) {
        const s = project(parts.wx[i], 0.02, parts.wz[i])
        const k = particleAt(i, tt, s, tx, ty, cx, cy, pa)
        const hot = Math.sin(Math.min(1, k) * Math.PI)
        if (k < 1) {
          const a = 0.85 * fadeP * fade
          point(pa[0], pa[1], parts.size[i] * (1 + hot * 0.8), 1, 0.8 + 0.2 * hot, 0.22 + 0.68 * hot, a, 0)
          for (let j = 1; j <= trails; j++) {
            const kt = particleAt(i, tt - j * 0.022, s, tx, ty, cx, cy, pa)
            if (kt <= 0) break
            point(pa[0], pa[1], parts.size[i] * (1.1 - j * 0.25), 1, 0.74, 0.16, a * (0.5 - j * 0.16) * hot, 0)
          }
        } else {
          const jit = 0.6 + charge * 2.2
          const x = tx + Math.sin(parts.seed[i] + tt * 31) * jit
          const y = ty + Math.cos(parts.seed[i] * 1.7 + tt * 27) * jit
          const a = (0.6 + 0.4 * charge) * fadeP * fade
          point(x, y, parts.size[i] * (1 + charge * 0.5), 1, 0.84 + 0.16 * charge, 0.26 + 0.6 * charge, a, 0)
        }
      }
      if (ign > 0 && parts.spark[i] && ign < parts.slife[i]) {
        const life = ign / parts.slife[i]
        const kd = 2.2
        const g = 1150
        const ek = (1 - Math.exp(-kd * ign)) / kd
        const sx = tx + parts.svx[i] * ek
        const sy = ty + (g / kd) * ign + (parts.svy[i] - g / kd) * ek
        const a = (1 - life) ** 1.3 * fade
        point(sx, sy, 2.8 * (1 - life * 0.6), 1, 0.92 - life * 0.42, 0.6 - life * 0.55, a * 1.3, 0)
        const ek2 = (1 - Math.exp(-kd * Math.max(0, ign - 0.02))) / kd
        const px = tx + parts.svx[i] * ek2
        const py = ty + (g / kd) * Math.max(0, ign - 0.02) + (parts.svy[i] - g / kd) * ek2
        point(px, py, 2.0 * (1 - life * 0.6), 1, 0.75, 0.25, a * 0.5, 0)
      }
    }
  }

  function logoPop(tt) {
    const ign = tt - T.ignite
    if (ign <= 0) return 1
    return 1.08 - 0.08 * easeOutBack(clamp01(ign / 0.34))
  }

  function drawLogo(tt, P) {
    const { m, pad } = L
    const ign = tt - T.ignite
    const pop = logoPop(tt)
    const appear = clamp01((ign + 0.02) / 0.08)
    const fadeOut = flyer ? 1 : 1 - clamp01(P.k / 0.55)
    const zoom = 1 + (flyer ? 0 : 0.9 * P.q * P.q)
    const s = pop * zoom
    const cx = L.logoX + m.w / 2
    const cy = L.logoY + m.h / 2
    const w = (m.w + pad * 2) * s
    const h = (m.h + pad * 2) * s
    const x = cx - (m.w / 2 + pad) * s + view.sx
    const y = cy - (m.h / 2 + pad) * s + view.sy
    const a = appear * fadeOut
    quad(x, y, w, h, [a, a, a, a], 0)
    flushQuads(tex.metal, false)
    const glow = (0.42 * Math.exp(-Math.max(0, ign) * 2.6) + 0.15 + 0.03 * Math.sin(tt * 5)) * a
    quad(x, y, w, h, [glow, glow * 0.82, glow * 0.55, glow], 0)
    flushQuads(tex.glow, true)
    const sh = ign - 0.12
    if (sh > 0 && sh < 0.95) {
      const band = lerp(-0.45, 1.6, sh / 0.95)
      quad(x, y, w, h, [1, 0.97, 0.86, 0.62 * a], 4, band, 0.07)
      flushQuads(tex.metal, true)
    }
    if (ign > 0 && ign < 1.0) {
      const span = Math.max(W, H)
      for (const [delay, amp, width, col] of [
        [0, 1, 0.005, [1, 0.94, 0.72]],
        [0.014, 0.38, 0.006, [0.5, 0.7, 1]],
      ]) {
        const k = clamp01((ign - delay) / 0.5)
        if (k <= 0 || k >= 1) continue
        const R = m.w * 0.32 + span * 0.95 * easeOutCubic(k)
        const fade = (1 - k) ** 1.2 * amp
        quad(cx - R, cy - R, R * 2, R * 2, [col[0], col[1], col[2], fade], 2, 0.99, width + 0.012 * (1 - k))
      }
      const fl = Math.exp(-ign * 3.6)
      const burst = Math.exp(-ign * 9)
      const bs = m.w * 1.9
      quad(cx - bs / 2, cy - bs / 2, bs, bs, [1, 0.86, 0.5, 0.65 * burst], 1, 5)
      quad(-W * 0.3, cy - 70, W * 1.6, 140, [1, 0.92, 0.74, 0.8 * fl], 3, 300, 1.3)
      quad(-W * 0.3, cy - 200, W * 1.6, 400, [0.55, 0.7, 1, 0.16 * fl], 3, 26, 2.2)
      flushQuads(null, true)
    }
    const st = tt - T.stamp
    if (st > 0) {
      const k = clamp01(st / 0.16)
      const sc = lerp(1.7, 1, easeOutCubic(k)) * zoom
      const bp = art.badge.pad
      const bw = (L.chipW + bp * 2) * sc
      const bh = (L.chipH + bp * 2) * sc
      const bx = L.chipX + L.chipW / 2 - bw / 2 + view.sx
      const by = L.chipY + L.chipH / 2 - bh / 2 + view.sy
      const ba = k * fadeOut
      quad(bx, by, bw, bh, [ba, ba, ba, ba], 0)
      flushQuads(tex.badge, false)
      const fa = Math.max(0, 1 - st / 0.3) ** 2 * 0.8
      if (fa > 0.01) {
        quad(bx, by, bw, bh, [fa, fa, fa, fa], 0)
        flushQuads(tex.badge, true)
      }
    }
  }

  function drawText(tt, P) {
    const a = 1 - clamp01((tt - portalAt) / 0.2)
    if (a <= 0) return
    const sc = art.scale
    /* tagline: decodes left to right through scrambled digits */
    {
      const ctx = art.tagX
      const c = art.tagC
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.setTransform(sc, 0, 0, sc, 0, 0)
      ctx.font = F_UI(600, L.tagSize)
      ctx.textBaseline = 'middle'
      const sp = L.tagSpacing
      const total = spacedWidth(ctx, TAGLINE, sp)
      let x = (c.width / sc - total) / 2
      const y = (c.height / sc) / 2
      const lt = tt - T.tag
      const chars = [...TAGLINE]
      const liveFrom = TAGLINE.lastIndexOf('LIVE')
      chars.forEach((ch, i) => {
        const ti = i * 0.012
        const w = ctx.measureText(ch).width
        if (ch !== ' ' && lt >= ti) {
          if (lt >= ti + 0.12) {
            ctx.fillStyle = i >= liveFrom ? '#fcd800' : 'rgba(232,237,245,0.94)'
            ctx.fillText(ch, x, y)
          } else {
            const r = SCRAMBLE[Math.floor(hash(i * 7.7 + Math.floor(lt * 40)) * SCRAMBLE.length)]
            ctx.fillStyle = 'rgba(252,216,0,0.9)'
            ctx.fillText(r, x, y)
          }
        }
        x += w + sp
      })
      updateTexture(gl, tex.tag, c)
      const cw = c.width / sc
      const ch = c.height / sc
      quad(L.cx - cw / 2 + view.sx, L.tagY - ch / 2 + view.sy, cw, ch, [a, a, a, a], 0)
      flushQuads(tex.tag, false)
    }
    /* live line: counts up */
    const lt = tt - T.live
    if (lt > 0) {
      const ctx = art.liveX
      const c = art.liveC
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.setTransform(sc, 0, 0, sc, 0, 0)
      const k = easeOutCubic(clamp01(lt / 0.5))
      const segs = liveSegments(k)
      ctx.font = F_UI(600, L.liveSize)
      ctx.textBaseline = 'middle'
      const sp = L.liveSize * 0.12
      const widths = segs.map(([s]) => spacedWidth(ctx, s, sp))
      const total = widths.reduce((s, w) => s + w, 0) + sp * (segs.length - 1)
      let x = (c.width / sc - total) / 2
      const y = (c.height / sc) / 2
      segs.forEach(([s, tone]) => {
        ctx.fillStyle = tone === 'num' ? '#fcd800' : 'rgba(232,237,245,0.66)'
        for (const glyph of s) {
          ctx.fillText(glyph, x, y)
          x += ctx.measureText(glyph).width + sp
        }
      })
      updateTexture(gl, tex.live, c)
      const cw = c.width / sc
      const ch = c.height / sc
      const la = a * clamp01(lt / 0.22)
      const dy = (1 - easeOutCubic(clamp01(lt / 0.3))) * 8
      quad(L.cx - cw / 2 + view.sx, L.liveY - ch / 2 + dy + view.sy, cw, ch, [la, la, la, la], 0)
      flushQuads(tex.live, false)
    }
  }

  function liveSegments(k) {
    const s = stats
    const n = (v) => Math.round(v * k).toLocaleString('en-US')
    if (!s || (s.games == null && s.props == null)) {
      return [[`${chipText} PROPS`, 'txt'], ['   ·   ', 'txt'], ['MATCHUPS', 'txt'], ['   ·   ', 'txt'], ['PICKS', 'txt']]
    }
    const out = []
    const sep = () => out.length && out.push(['   ·   ', 'txt'])
    if (s.week != null) {
      sep()
      out.push(['WEEK ', 'txt'], [String(s.week), 'num'])
    }
    if (s.games != null) {
      sep()
      out.push([n(s.games), 'num'], [' GAMES', 'txt'])
    }
    if (s.props != null) {
      sep()
      out.push([n(s.props), 'num'], [' PROPS', 'txt'])
    }
    return out
  }

  /* ---------- the hand-off: the logo flies into the header ---------- */
  // The header wordmark is an <svg> whose box is tight to the letters, so its rect is the glyph box.
  function findTarget() {
    const el = document.querySelector(opts.logo || '[data-apex-logo]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) return null
    let chip = null
    const chipEl = document.querySelector(opts.chip || '[data-apex-chip]')
    if (chipEl) {
      const cr = chipEl.getBoundingClientRect()
      if (cr.width && cr.height) chip = cr
    }
    return { rect: r, chip, el, chipEl: chip ? chipEl : null }
  }

  // The real header logo hides while its stand-in is in flight, so there is never a double.
  const hidden = []
  function hideTarget(el) {
    if (!el) return
    hidden.push([el, el.style.visibility])
    el.style.visibility = 'hidden'
  }
  function restoreTargets() {
    while (hidden.length) {
      const [el, v] = hidden.pop()
      el.style.visibility = v
    }
  }

  function startFlyer() {
    flyerTried = true
    if (!art || t < T.ignite) return
    const target = findTarget()
    if (!target) return
    const { m, pad } = L
    const box = document.createElement('div')
    box.className = 'apex-intro-fly'
    box.setAttribute('aria-hidden', 'true')
    const cw = m.w + pad * 2
    const ch = m.h + pad * 2
    box.style.width = `${cw}px`
    box.style.height = `${ch}px`
    const glow = cloneCanvas(art.glow)
    glow.style.mixBlendMode = 'screen'
    const metal = cloneCanvas(art.metal)
    const flat = cloneCanvas(art.flat)
    flat.style.opacity = '0'
    box.append(glow, metal, flat)
    let chipBox = null
    if (target.chip && t > T.stamp + 0.16) {
      chipBox = document.createElement('div')
      chipBox.className = 'apex-intro-fly'
      chipBox.setAttribute('aria-hidden', 'true')
      const bp = art.badge.pad
      chipBox.style.width = `${L.chipW + bp * 2}px`
      chipBox.style.height = `${L.chipH + bp * 2}px`
      chipBox.appendChild(cloneCanvas(art.badge.canvas))
      document.body.appendChild(chipBox)
    }
    document.body.appendChild(box)
    hideTarget(target.el)
    if (chipBox) hideTarget(target.chipEl)
    const s1 = target.rect.height / m.h
    flyer = {
      box,
      glow,
      metal,
      flat,
      chipBox,
      from: { x: L.logoX - pad, y: L.logoY - pad, s: 1 },
      to: { x: target.rect.left - pad * s1, y: target.rect.top - pad * s1, s: s1 },
      chipFrom: { x: L.chipX - art.badge.pad, y: L.chipY - art.badge.pad, s: 1 },
      chipTo:
        chipBox && target.chip
          ? (() => {
              const sc = target.chip.height / L.chipH
              return {
                x: target.chip.left + target.chip.width / 2 - (L.chipW / 2 + art.badge.pad) * sc,
                y: target.chip.top - art.badge.pad * sc,
                s: sc,
              }
            })()
          : null,
    }
  }

  function cloneCanvas(src) {
    const c = document.createElement('canvas')
    c.width = src.width
    c.height = src.height
    c.getContext('2d').drawImage(src, 0, 0)
    return c
  }

  function updateFlyer(tt, P) {
    if (!flyer) return
    const k = easeInOutCubic(P.k)
    const place = (el, a, b) => {
      const x = lerp(a.x, b.x, k)
      const y = lerp(a.y, b.y, k)
      const s = lerp(a.s, b.s, k)
      el.style.transform = `translate3d(${x}px,${y}px,0) scale(${s})`
    }
    place(flyer.box, flyer.from, flyer.to)
    flyer.glow.style.opacity = String(Math.max(0, 0.5 * (1 - k * 1.6)))
    flyer.metal.style.opacity = String(1 - clamp01((k - 0.45) / 0.35))
    flyer.flat.style.opacity = String(clamp01((k - 0.4) / 0.35))
    if (flyer.chipBox) {
      if (flyer.chipTo) place(flyer.chipBox, flyer.chipFrom, flyer.chipTo)
      flyer.chipBox.style.opacity = '1'
    }
  }

  /* ---------- control ---------- */
  function skip() {
    if (finished || skipped) return
    skipped = true
    if (t < portalAt) portalAt = Math.max(t, 0)
    if (seekMode) render(t)
  }

  function finish() {
    if (finished) return
    finished = true
    cancelAnimationFrame(raf)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onResize)
    clearTimeout(watchdog)
    root.remove()
    restoreTargets()
    if (flyer) {
      const els = [flyer.box, flyer.chipBox].filter(Boolean)
      els.forEach((el) => {
        el.style.transition = 'opacity .18s ease'
        el.style.opacity = '0'
      })
      setTimeout(() => els.forEach((el) => el.remove()), 220)
    }
    try {
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
    } catch {
      /* ignore */
    }
    resolveDone()
    if (typeof opts.onDone === 'function') {
      try {
        opts.onDone()
      } catch {
        /* ignore */
      }
    }
  }

  function onKey(e) {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return
    if (e.metaKey || e.ctrlKey) return
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') e.preventDefault()
    skip()
  }
  function onResize() {
    resize()
    skip()
  }
  root.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    skip()
  })
  skipBtn.addEventListener('click', (e) => {
    e.preventDefault()
    skip()
  })
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onResize)
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    finish()
  })

  markPlayed()
  fontsReady.then(() => {
    if (finished) return
    try {
      buildArt()
    } catch (err) {
      if (opts.debug) console.warn('[apex intro] art', err)
      finish()
    }
  })

  let watchdog = setTimeout(finish, 12000)
  const safeRender = (tt) => {
    try {
      render(tt)
    } catch (err) {
      if (opts.debug) console.warn('[apex intro] frame', err)
      finish()
    }
  }

  let wallStart = 0
  function frame(now) {
    if (finished) return
    if (!lastNow) {
      lastNow = now
      wallStart = now
    }
    const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000))
    lastNow = now
    frames++
    const wall = (now - wallStart) / 1000
    if (dt > 0.034) slowFrames++
    // A slow device gets fewer pixels; one that is still struggling goes straight to the portal.
    if (!degraded && frames >= 8 && slowFrames > frames * 0.5) {
      degraded = true
      resize()
    }
    if (wall > 7.5 && t < portalAt) skip()
    if (wall > 10) {
      finish()
      return
    }
    t += dt
    if (t > 0.6) skipBtn.classList.add('is-on')
    safeRender(t)
    if (t >= portalAt) root.classList.add('is-portal')
    if (t >= portalAt + T.portalDur) {
      finish()
      return
    }
    raf = requestAnimationFrame(frame)
  }

  if (seekMode) {
    clearTimeout(watchdog)
    watchdog = 0
    window.__apexIntro = {
      ready: () => fontsReady.then(() => new Promise((r) => setTimeout(r, 30))),
      seek(tt) {
        t = tt
        safeRender(tt)
        root.classList.toggle('is-portal', tt >= portalAt)
        skipBtn.classList.toggle('is-on', tt > 0.6)
        return { t: tt, ready: assets.ready, tier: tier.name, particles: parts ? parts.n : 0 }
      },
      skipAt(tt) {
        portalAt = tt
      },
      finish,
      timeline: T,
    }
  } else {
    raf = requestAnimationFrame(frame)
  }

  return { done, skip: () => skip() }
}

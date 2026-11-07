// Draws the PropPickz brand images from scripts/brand/brand.json (run build.py first):
// favicons, app icons, the square logo and the link-preview image, into frontend/public and
// frontend/src/assets. Needs Playwright with Chromium: `node scripts/brand/render.cjs`.
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const HERE = __dirname
const FE = path.join(HERE, '..', '..', 'frontend')
const B = JSON.parse(fs.readFileSync(path.join(HERE, 'brand.json'), 'utf8'))
const { mark: M, word: W, lockup: L, colors: C } = B
// fonts inline: a page made with setContent can't load file:// fonts
const FONT = (f) => `url(data:font/woff;base64,${fs.readFileSync(path.join(FE, 'public', 'fonts', f)).toString('base64')}) format('woff')`

const defs = `
  <linearGradient id="gm" gradientUnits="userSpaceOnUse" x1="0" y1="${M.h}" x2="${M.w}" y2="0">
    <stop offset="0" stop-color="${C.markFrom}"/><stop offset=".55" stop-color="${C.markMid}"/><stop offset="1" stop-color="${C.markTo}"/>
  </linearGradient>
  <linearGradient id="gp" gradientUnits="userSpaceOnUse" x1="${W.pickzX}" y1="${W.h}" x2="${W.w}" y2="0">
    <stop offset="0" stop-color="${C.pickzFrom}"/><stop offset="1" stop-color="${C.pickzTo}"/>
  </linearGradient>`
const markG = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})" fill="url(#gm)"><path d="${M.p}"/>${M.lines.map((d) => `<path d="${d}"/>`).join('')}</g>`
const wordG = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><path fill="${C.white}" d="${W.prop}"/><path fill="url(#gp)" d="${W.pickz}"/></g>`

/** The mark centred in a size x size square, `frac` of the width, on black with a lime glow. */
function iconSvg(size, frac, { radius = 0, glow = 0.55 } = {}) {
  const mw = size * frac
  const s = mw / M.w
  const mh = M.h * s
  // optical centre: the speed lines are light, so nudge the mark a little left of true centre
  const x = (size - mw) / 2 - mw * 0.02
  const y = (size - mh) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>${defs}
    <radialGradient id="glow" cx=".56" cy=".46" r=".62"><stop offset="0" stop-color="#7cfc00" stop-opacity="${0.26 * glow}"/><stop offset=".55" stop-color="#7cfc00" stop-opacity="${0.07 * glow}"/><stop offset="1" stop-color="#7cfc00" stop-opacity="0"/></radialGradient>
    <clipPath id="tile"><rect width="${size}" height="${size}" rx="${radius}"/></clipPath>
  </defs>
  <g clip-path="url(#tile)"><rect width="${size}" height="${size}" fill="${C.black}"/><rect width="${size}" height="${size}" fill="url(#glow)"/>
  ${markG(x, y, s)}</g></svg>`
}

/** Mark over word, as on the app icon art. */
function stackedSvg(size) {
  const ww = size * 0.78
  const ws = ww / W.w
  const wh = W.h * ws
  const mw = size * 0.5
  const ms = mw / M.w
  const mh = M.h * ms
  const gap = size * 0.06
  const top = (size - (mh + gap + wh)) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>${defs}
    <radialGradient id="glow" cx=".5" cy=".38" r=".6"><stop offset="0" stop-color="#7cfc00" stop-opacity=".2"/><stop offset=".6" stop-color="#7cfc00" stop-opacity=".05"/><stop offset="1" stop-color="#7cfc00" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="${C.black}"/><rect width="${size}" height="${size}" fill="url(#glow)"/>
  ${markG((size - mw) / 2 - mw * 0.03, top, ms)}
  ${wordG((size - ww) / 2, top + mh + gap, ws)}</svg>`
}

/** The link preview: the lockup on a black field with neon edges, and what the site does. */
function ogHtml() {
  const Wd = 1200
  const Ht = 630
  const lw = 860
  const s = lw / L.w
  const lh = L.h * s
  const x = (Wd - lw) / 2
  const y = 228 - lh / 2
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:Barlow;font-weight:600;src:${FONT('barlow-600.woff')}}
  @font-face{font-family:Barlow;font-weight:800;src:${FONT('barlow-800.woff')}}
  html,body{margin:0;width:${Wd}px;height:${Ht}px;background:${C.black};overflow:hidden}
  .tag{position:absolute;left:0;right:0;top:372px;text-align:center;font:600 34px/1.2 Barlow;color:#c9d3cc;letter-spacing:.01em}
  .tag b{font-weight:800;color:${C.white}}
  .leagues{position:absolute;left:0;right:0;top:446px;display:flex;justify-content:center;gap:14px}
  .leagues span{font:800 22px/1 Barlow;letter-spacing:.12em;color:${C.lime};padding:10px 16px;border:1.5px solid rgba(184,255,31,.45);border-radius:999px;background:rgba(184,255,31,.06)}
  </style></head><body>
  <svg width="${Wd}" height="${Ht}" viewBox="0 0 ${Wd} ${Ht}" style="position:absolute;inset:0">
    <defs>${defs}
      <radialGradient id="bg" cx=".5" cy=".36" r=".7"><stop offset="0" stop-color="#0d1a10"/><stop offset=".55" stop-color="#050a07"/><stop offset="1" stop-color="${C.black}"/></radialGradient>
      <linearGradient id="arc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7cfc00" stop-opacity="0"/><stop offset=".5" stop-color="#b8ff1f"/><stop offset="1" stop-color="#7cfc00" stop-opacity="0"/></linearGradient>
      <filter id="neon" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
    </defs>
    <rect width="${Wd}" height="${Ht}" fill="url(#bg)"/>
    <ellipse cx="600" cy="228" rx="420" ry="120" fill="#7cfc00" opacity=".08" filter="url(#soft)"/>
    <g filter="url(#neon)" fill="none" stroke-linecap="round">
      <path d="M-40 520 C 180 470, 300 600, 470 700" stroke="url(#arc)" stroke-width="3" opacity=".9"/>
      <path d="M-60 120 C 120 40, 260 -10, 420 -60" stroke="url(#arc)" stroke-width="2.5" opacity=".7"/>
      <path d="M1240 110 C 1060 150, 960 40, 860 -60" stroke="url(#arc)" stroke-width="3" opacity=".85"/>
      <path d="M1260 560 C 1080 520, 960 620, 900 700" stroke="url(#arc)" stroke-width="2.5" opacity=".7"/>
    </g>
    <g filter="url(#neon)" opacity=".55">${markG(x, y + L.mark.y * s, s * L.mark.s)}</g>
    ${markG(x, y + L.mark.y * s, s * L.mark.s)}
    ${wordG(x + L.word.x * s, y, s)}
  </svg>
  <div class="tag">Every player prop. <b>Hit rates, matchups, live tracking.</b></div>
  <div class="leagues"><span>NFL</span><span>NBA</span><span>NHL</span><span>MLB</span><span>NCAA</span></div>
  </body></html>`
}

async function shoot(page, html, out, w, h) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(html.startsWith('<svg') ? `<html><body style="margin:0;background:transparent">${html}</body></html>` : html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } })
  console.log(path.relative(path.join(HERE, '..', '..'), out), `${w}x${h}`)
}

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const pub = (f) => path.join(FE, 'public', f)
  // tab icons: a dark rounded tile so the lime reads on light and dark tab bars alike
  await shoot(page, iconSvg(32, 0.86, { radius: 7, glow: 0.4 }), pub('favicon-32.png'), 32, 32)
  await shoot(page, iconSvg(64, 0.84, { radius: 14, glow: 0.5 }), pub('favicon-64.png'), 64, 64)
  // home-screen icons: full bleed (the system rounds them), maskable keeps to the safe circle
  await shoot(page, iconSvg(180, 0.72), pub('apple-touch-icon.png'), 180, 180)
  await shoot(page, iconSvg(192, 0.72), pub('icon-192.png'), 192, 192)
  await shoot(page, iconSvg(512, 0.72), pub('icon-512.png'), 512, 512)
  await shoot(page, iconSvg(512, 0.58), pub('icon-maskable-512.png'), 512, 512)
  // the square logo (share previews of picks pages without a photo, wallet sign-in)
  await shoot(page, stackedSvg(1024), pub('logo.png'), 1024, 1024)
  fs.copyFileSync(pub('logo.png'), path.join(FE, 'src', 'assets', 'logo.png'))
  // the link preview
  await shoot(page, ogHtml(), pub('og.png'), 1200, 630)
  await browser.close()
})()

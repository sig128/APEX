// The App Store pictures: each app screen under a short caption, in the brand's own type (Big
// Shoulders Display over Barlow) and colours, at the two iPhone sizes App Store Connect takes:
// 1206 x 2622 (6.3-inch, required) and 1320 x 2868 (6.9-inch). The screens are captures of the
// iPhone app's own build (frontend/ios/appstore/screens/*.png, 1206 x 2622, the top 186 px left
// for the status bar). Run: node scripts/brand/store.cjs (Playwright + Pillow).
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { chromium } = require('playwright')

const ROOT = path.join(__dirname, '..', '..')
const STORE = path.join(ROOT, 'frontend', 'ios', 'appstore')
const FONTS = path.join(ROOT, 'frontend', 'public', 'fonts')
const font = (f) => `data:font/woff;base64,${fs.readFileSync(path.join(FONTS, f)).toString('base64')}`

// in the order the App Store shows them
const SHOTS = [
  { file: 'board', head: 'Every prop’s chance to hit', sub: 'Each line turned into a percentage, for every game on the slate.' },
  { file: 'prop', head: 'The numbers behind the line', sub: 'Game logs, hit rates, matchups and injury news on one screen.' },
  { file: 'builder', head: 'Build a parlay to your price', sub: 'Choose safe, balanced or longshot and how many legs. It finds legs that fit.' },
  { file: 'sim', head: 'Play it out before you bet', sub: 'Run the slip thousands of times and see how often it cashes.' },
  { file: 'learn', head: 'Learn the bets, props to parlays', sub: 'Forty plain-English entries, each with a worked example.' },
]
const SIZES = [
  { name: '6.3', w: 1206, h: 2622 },
  { name: '6.9', w: 1320, h: 2868 },
]

// a plain status bar for the screen (time, signal, wifi, battery), drawn at the screen's width
const statusBar = (w) => {
  const s = w / 402
  return `<div class="sb" style="height:${62 * s}px;padding:0 ${30 * s}px 0 ${50 * s}px;font-size:${17 * s}px">
    <span>9:41</span>
    <svg viewBox="0 0 78 14" style="height:${13 * s}px" fill="#eef3ec" aria-hidden="true">
      <rect x="0" y="9" width="3.4" height="5" rx="1"/><rect x="5" y="6.5" width="3.4" height="7.5" rx="1"/><rect x="10" y="4" width="3.4" height="10" rx="1"/><rect x="15" y="1.5" width="3.4" height="12.5" rx="1"/>
      <path d="M32 3.2a10.5 10.5 0 0 1 14.5 0l-1.5 1.6a8.3 8.3 0 0 0-11.5 0zm2.6 2.8a6.8 6.8 0 0 1 9.3 0l-1.6 1.6a4.6 4.6 0 0 0-6.1 0zm2.7 2.9a3 3 0 0 1 3.9 0l-1.95 2.1z"/>
      <rect x="53" y="1.5" width="21" height="11" rx="3.2" fill="none" stroke="#eef3ec" stroke-opacity=".45" stroke-width="1.1"/><rect x="55" y="3.5" width="17" height="7" rx="1.8"/><rect x="75.3" y="5" width="1.6" height="4" rx=".8" fill-opacity=".45"/>
    </svg>
  </div>`
}

function page({ w, h }, shot, img) {
  const k = w / 1320
  const screenW = Math.round(1060 * k)
  const top = Math.round(700 * k)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'BSD'; src: url(${font('bigshoulders-var.woff')}) format('woff'); font-weight: 100 900; }
    @font-face { font-family: 'Barlow'; src: url(${font('barlow-500.woff')}) format('woff'); font-weight: 500; }
    @font-face { font-family: 'Barlow'; src: url(${font('barlow-600.woff')}) format('woff'); font-weight: 600; }
    html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: #030605; }
    .bg { position: absolute; inset: 0; background:
      radial-gradient(${1100 * k}px ${820 * k}px at 88% 6%, rgba(124, 252, 0, .15), transparent 62%),
      radial-gradient(${900 * k}px ${700 * k}px at 0% 100%, rgba(47, 212, 122, .07), transparent 60%); }
    .cap { position: absolute; left: ${96 * k}px; right: ${96 * k}px; top: ${150 * k}px; }
    h1 { margin: 0; font: 800 ${124 * k}px/0.96 'BSD', sans-serif; letter-spacing: ${-0.5 * k}px; color: #eef3ec; text-wrap: balance; }
    p { margin: ${30 * k}px 0 0; font: 500 ${46 * k}px/1.32 'Barlow', sans-serif; color: #a9b5ae; max-width: ${1040 * k}px; text-wrap: pretty; }
    .phone { position: absolute; left: ${(w - screenW) / 2}px; top: ${top}px; width: ${screenW}px; border-radius: ${62 * k}px; overflow: hidden;
      outline: ${3 * k}px solid #2c3b34; box-shadow: 0 ${40 * k}px ${140 * k}px rgba(0, 0, 0, .65), 0 0 ${90 * k}px rgba(124, 252, 0, .08); }
    .phone img { display: block; width: 100%; }
    .sb { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: space-between; box-sizing: border-box;
      font-family: 'Barlow', sans-serif; font-weight: 600; color: #eef3ec; }
  </style></head><body><div class="bg"></div>
  <div class="cap"><h1>${shot.head}</h1><p>${shot.sub}</p></div>
  <div class="phone"><img src="${img}" alt="">${statusBar(screenW)}</div>
  </body></html>`
}

;(async () => {
  const browser = await chromium.launch()
  const pg = await browser.newPage({ deviceScaleFactor: 1 })
  for (const size of SIZES) {
    const dir = path.join(STORE, `screenshots-${size.name}`)
    fs.mkdirSync(dir, { recursive: true })
    await pg.setViewportSize({ width: size.w, height: size.h })
    for (const [i, shot] of SHOTS.entries()) {
      const src = path.join(STORE, 'screens', `${shot.file}.png`)
      const img = `data:image/png;base64,${fs.readFileSync(src).toString('base64')}`
      await pg.setContent(page(size, shot, img), { waitUntil: 'load' })
      await pg.evaluate(() => document.fonts.ready)
      const out = path.join(dir, `${i + 1}-${shot.file}.png`)
      await pg.screenshot({ path: out, clip: { x: 0, y: 0, width: size.w, height: size.h } })
      // App Store Connect refuses pictures with an alpha channel
      execFileSync('python3', ['-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[1], optimize=True)', out])
      console.log(path.relative(ROOT, out))
    }
  }
  await browser.close()
})()

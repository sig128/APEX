// The iPhone app's icon and launch screen, from the same brand shapes as the website's icons
// (scripts/brand/brand.json): the P mark full bleed on black with a lime glow for the icon, and
// the mark over the word, small and centred, for the launch screen (iOS crops it to the phone).
// Needs Playwright with Chromium and Python with Pillow: `node scripts/brand/ios.cjs`.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { chromium } = require('playwright')

const HERE = __dirname
const ASSETS = path.join(HERE, '..', '..', 'frontend', 'ios', 'App', 'App', 'Assets.xcassets')
const B = JSON.parse(fs.readFileSync(path.join(HERE, 'brand.json'), 'utf8'))
const { mark: M, word: W, colors: C } = B

const defs = `
  <linearGradient id="gm" gradientUnits="userSpaceOnUse" x1="0" y1="${M.h}" x2="${M.w}" y2="0">
    <stop offset="0" stop-color="${C.markFrom}"/><stop offset=".55" stop-color="${C.markMid}"/><stop offset="1" stop-color="${C.markTo}"/>
  </linearGradient>
  <linearGradient id="gp" gradientUnits="userSpaceOnUse" x1="${W.pickzX}" y1="${W.h}" x2="${W.w}" y2="0">
    <stop offset="0" stop-color="${C.pickzFrom}"/><stop offset="1" stop-color="${C.pickzTo}"/>
  </linearGradient>
  <radialGradient id="glow" cx=".56" cy=".46" r=".62"><stop offset="0" stop-color="#7cfc00" stop-opacity=".143"/><stop offset=".55" stop-color="#7cfc00" stop-opacity=".0385"/><stop offset="1" stop-color="#7cfc00" stop-opacity="0"/></radialGradient>`
const markG = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})" fill="url(#gm)"><path d="${M.p}"/>${M.lines.map((d) => `<path d="${d}"/>`).join('')}</g>`
const wordG = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><path fill="${C.white}" d="${W.prop}"/><path fill="url(#gp)" d="${W.pickz}"/></g>`

/** The App Store icon: the same art as the website's home-screen icon, at 1024. */
function iconSvg(size) {
  const mw = size * 0.72
  const s = mw / M.w
  const mh = M.h * s
  const x = (size - mw) / 2 - mw * 0.02
  const y = (size - mh) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${defs}</defs>
  <rect width="${size}" height="${size}" fill="${C.black}"/><rect width="${size}" height="${size}" fill="url(#glow)"/>${markG(x, y, s)}</svg>`
}

/** The launch screen: mark over word in the middle third, so any phone's crop keeps it whole. */
function splashSvg(size) {
  const ww = size * 0.3
  const ws = ww / W.w
  const wh = W.h * ws
  const mw = size * 0.18
  const ms = mw / M.w
  const mh = M.h * ms
  const gap = size * 0.02
  const top = (size - (mh + gap + wh)) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${defs}</defs>
  <rect width="${size}" height="${size}" fill="${C.black}"/><rect width="${size}" height="${size}" fill="url(#glow)"/>
  ${markG((size - mw) / 2 - mw * 0.03, top, ms)}${wordG((size - ww) / 2, top + mh + gap, ws)}</svg>`
}

async function shoot(page, svg, out, size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0;background:${C.black}">${svg}</body></html>`, { waitUntil: 'load' })
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size } })
  // the App Store refuses an icon with an alpha channel, even a fully opaque one
  execFileSync('python3', ['-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[1], optimize=True)', out])
  console.log(path.relative(path.join(HERE, '..', '..'), out), `${size}x${size}`)
}

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await shoot(page, iconSvg(1024), path.join(ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), 1024)
  const splash = path.join(ASSETS, 'Splash.imageset', 'splash-2732x2732.png')
  await shoot(page, splashSvg(2732), splash, 2732)
  for (const n of ['splash-2732x2732-1.png', 'splash-2732x2732-2.png']) fs.copyFileSync(splash, path.join(ASSETS, 'Splash.imageset', n))
  await browser.close()
})()

/**
 * Compact “picked matchup” strip: both team logos + Away @ Home next to Analyze.
 */

import { loadEspnTeamLogos, resolveTeamLogoUrl } from './espnTeamLogos.js'
import './apexPickedGameStrip.css'

function teamInitials(name) {
  const w = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (w.length === 0) return '?'
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase()
  return (w[0][0] + w[w.length - 1][0]).toUpperCase()
}

/**
 * @param {HTMLElement} wrap
 * @param {string} name
 * @param {Record<string, Map<string, string>>} maps
 * @param {string} sportKey
 */
function fillLogoWrap(wrap, name, maps, sportKey) {
  wrap.replaceChildren()
  const url = resolveTeamLogoUrl(maps, sportKey, name)
  if (url) {
    const img = document.createElement('img')
    img.className = 'apex-picked-game-logo-img'
    img.src = url
    img.alt = ''
    img.width = 32
    img.height = 32
    img.loading = 'lazy'
    img.decoding = 'async'
    img.addEventListener(
      'error',
      () => {
        wrap.replaceChildren()
        const fb = document.createElement('span')
        fb.className = 'apex-picked-game-logo-fallback'
        fb.textContent = teamInitials(name)
        wrap.appendChild(fb)
      },
      { once: true },
    )
    wrap.appendChild(img)
  } else {
    const fb = document.createElement('span')
    fb.className = 'apex-picked-game-logo-fallback'
    fb.textContent = teamInitials(name)
    wrap.appendChild(fb)
  }
}

export function hidePickedGameStrip(root) {
  const el = root.querySelector('#apex-picked-game')
  if (!el) return
  el.hidden = true
  el.removeAttribute('data-sport-key')
  root.querySelector('#apex-picked-game-away-logo-wrap')?.replaceChildren()
  root.querySelector('#apex-picked-game-home-logo-wrap')?.replaceChildren()
  const matchup = root.querySelector('#apex-picked-game-matchup')
  if (matchup) matchup.textContent = ''
}

/**
 * @param {HTMLElement} root
 * @param {{ awayTeam: string, homeTeam: string, sportKey?: string }} p
 */
export async function showPickedGameStrip(root, p) {
  const el = root.querySelector('#apex-picked-game')
  const awayW = root.querySelector('#apex-picked-game-away-logo-wrap')
  const homeW = root.querySelector('#apex-picked-game-home-logo-wrap')
  const matchup = root.querySelector('#apex-picked-game-matchup')
  if (!el || !awayW || !homeW || !matchup) return

  const away = String(p.awayTeam || '').trim()
  const home = String(p.homeTeam || '').trim()
  if (!away || !home) {
    hidePickedGameStrip(root)
    return
  }

  const sportKey =
    typeof p.sportKey === 'string' && p.sportKey.trim() ? p.sportKey.trim() : 'baseball_mlb'
  el.dataset.sportKey = sportKey
  matchup.textContent = `${away} @ ${home}`

  try {
    const maps = await loadEspnTeamLogos()
    fillLogoWrap(awayW, away, maps, sportKey)
    fillLogoWrap(homeW, home, maps, sportKey)
  } catch {
    const empty = { [sportKey]: new Map() }
    fillLogoWrap(awayW, away, empty, sportKey)
    fillLogoWrap(homeW, home, empty, sportKey)
  }

  el.hidden = false
}

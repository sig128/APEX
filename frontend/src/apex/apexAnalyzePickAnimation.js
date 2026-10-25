/** Shared: carousel pick “pop” + logo ghosts → Analyze button (sport glow). */

const SPORT_GLOW_KEYS = new Set([
  'baseball_mlb',
  'americanfootball_nfl',
  'basketball_nba',
  'icehockey_nhl',
])

/**
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * @param {unknown} sportKey
 * @returns {string | null}
 */
export function normalizeSportGlowKey(sportKey) {
  const k = String(sportKey || '').trim()
  return SPORT_GLOW_KEYS.has(k) ? k : null
}

/**
 * @param {HTMLElement | null} slideEl
 */
export function playCarouselPickAnimation(slideEl) {
  if (!slideEl || prefersReducedMotion()) return
  slideEl.classList.remove('apex-qg-slide--picked')
  void slideEl.offsetWidth
  slideEl.classList.add('apex-qg-slide--picked')
  slideEl.addEventListener(
    'animationend',
    (e) => {
      if (e.target !== slideEl) return
      slideEl.classList.remove('apex-qg-slide--picked')
    },
    { once: true },
  )
}

/**
 * Snapshot logo positions + content for fly animation after route change (e.g. Today → Analyze).
 * @param {HTMLElement | null} slideEl
 * @returns {{ rect: DOMRectReadOnly; imgSrc?: string; letter?: string }[]}
 */
export function captureFlySourcesFromSlide(slideEl) {
  /** @type {{ rect: DOMRectReadOnly; imgSrc?: string; letter?: string }[]} */
  const sources = []
  if (!slideEl) return sources
  slideEl.querySelectorAll('.apex-qg-team .apex-qg-logo').forEach((wrap) => {
    if (!(wrap instanceof HTMLElement)) return
    const rect = wrap.getBoundingClientRect()
    const logoImg = wrap.querySelector('img.apex-qg-logo-img')
    if (logoImg instanceof HTMLImageElement && logoImg.src) {
      sources.push({ rect, imgSrc: logoImg.src })
    } else {
      const letter = (wrap.textContent || '?').trim().slice(0, 1) || '?'
      sources.push({ rect, letter })
    }
  })
  return sources
}

/**
 * @param {HTMLElement} root
 * @param {{ rect: DOMRectReadOnly; imgSrc?: string; letter?: string }[]} sources
 * @param {unknown} sportKey
 */
export function playFlyToAnalyzeFromCaptured(root, sources, sportKey) {
  if (!root || prefersReducedMotion()) return
  const btn = root.querySelector('#abtn')
  if (!(btn instanceof HTMLElement)) return
  const glowKey = normalizeSportGlowKey(sportKey)
  const endRect = btn.getBoundingClientRect()
  if (endRect.width < 8) return
  if (!sources.length) return

  const size = 48
  const ghosts = []
  const promises = []

  sources.forEach((src, i) => {
    const startRect = src.rect
    if (startRect.width < 4) return

    const ghost = document.createElement('div')
    ghost.className = 'apex-qg-fly-to-analyze'
    if (i > 0) ghost.classList.add('apex-qg-fly-to-analyze--b')
    ghost.setAttribute('aria-hidden', 'true')

    if (typeof src.imgSrc === 'string' && src.imgSrc) {
      const img = document.createElement('img')
      img.src = src.imgSrc
      img.alt = ''
      img.className = 'apex-qg-fly-to-analyze__img'
      img.decoding = 'sync'
      ghost.appendChild(img)
    } else {
      const span = document.createElement('span')
      span.className = 'apex-qg-fly-to-analyze__letter'
      span.textContent = src.letter || '?'
      ghost.appendChild(span)
    }

    ghost.style.left = `${startRect.left + startRect.width / 2 - size / 2}px`
    ghost.style.top = `${startRect.top + startRect.height / 2 - size / 2}px`
    ghost.style.width = `${size}px`
    ghost.style.height = `${size}px`
    ghost.style.zIndex = String(100000 + i)

    document.body.appendChild(ghost)
    ghosts.push(ghost)

    const dx = endRect.left + endRect.width / 2 - (startRect.left + startRect.width / 2)
    const dy = endRect.top + endRect.height / 2 - (startRect.top + startRect.height / 2)
    const arcBase = Math.min(52, Math.max(16, Math.abs(dx) * 0.07 + 10))
    const spread = i === 0 ? -20 : 20
    const arcLift = i === 0 ? arcBase : -arcBase * 0.72

    const anim = ghost.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        {
          transform: `translate(${dx * 0.5 + spread}px, ${dy * 0.5 - arcLift}px) scale(0.54)`,
          opacity: 1,
          offset: 0.5,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0.85 },
      ],
      {
        duration: 620,
        delay: i * 55,
        easing: 'cubic-bezier(0.22, 0.99, 0.35, 1)',
        fill: 'forwards',
      },
    )
    promises.push(anim.finished)
  })

  if (promises.length === 0) return

  const finish = () => {
    ghosts.forEach((g) => g.remove())
    btn.classList.add('apex-abtn--pulse')
    window.setTimeout(() => btn.classList.remove('apex-abtn--pulse'), 480)
    if (glowKey) {
      btn.setAttribute('data-sport-glow', glowKey)
      btn.classList.add('apex-abtn--sport-glow')
    }
  }

  Promise.all(promises).then(finish).catch(finish)
}

/**
 * @param {HTMLElement} root
 * @param {HTMLElement | null} slideEl
 * @param {unknown} sportKey
 */
export function playFlyToAnalyzeButton(root, slideEl, sportKey) {
  playFlyToAnalyzeFromCaptured(root, captureFlySourcesFromSlide(slideEl), sportKey)
}

/** Remove sport-colored glow / pulse on Analyze (e.g. after Clear). */
export function clearAnalyzeButtonSportGlow(root) {
  const btn = root.querySelector('#abtn')
  if (!(btn instanceof HTMLElement)) return
  btn.classList.remove('apex-abtn--sport-glow', 'apex-abtn--pulse')
  btn.removeAttribute('data-sport-glow')
}

/**
 * Mobile (≤768px) ticker: continuous auto-scroll plus touch drag and flick inertia.
 * Extra velocity from flicks decays so motion settles back to the baseline auto speed.
 */
export const MOBILE_CAROUSEL_MQ = '(max-width: 768px)'

export function useMobileSwipeCarousel() {
  if (typeof window === 'undefined') return false
  try {
    return window.matchMedia(MOBILE_CAROUSEL_MQ).matches
  } catch {
    return false
  }
}

const EXTRA_VEL_DECAY_PER_SEC = 18
const FLICK_STRENGTH = 0.42
const EXTRA_VEL_CAP = 920

/**
 * @param {HTMLElement} viewport
 * @param {HTMLElement} track
 * @param {() => number} getLoopWidthPx - one duplicated set width (px)
 * @param {number} autoPxPerSec - baseline ticker speed (px/s), same intent as CSS ticker
 * @returns {() => void} cleanup
 */
export function setupMobileAutoPhysicsTicker(viewport, track, getLoopWidthPx, autoPxPerSec) {
  let cancelled = false
  let pos = 0
  let extraVel = 0
  let rafId = 0
  let lastTs = performance.now()
  let lastClientX = /** @type {number | null} */ (null)
  /** @type {{ t: number, x: number }[]} */
  let velSamples = []

  function wrap() {
    const w = getLoopWidthPx()
    if (w <= 0) return
    while (pos >= w) pos -= w
    while (pos < 0) pos += w
  }

  function applyTransform() {
    track.style.transform = `translate3d(${-pos}px, 0, 0)`
  }

  function tick(ts) {
    if (cancelled) return
    const now = ts || performance.now()
    const dt = Math.min(0.072, Math.max(0, (now - lastTs) / 1000))
    lastTs = now

    const w = getLoopWidthPx()
    if (w <= 0) {
      rafId = window.requestAnimationFrame(tick)
      return
    }

    const decay = Math.exp(-EXTRA_VEL_DECAY_PER_SEC * dt)
    extraVel *= decay
    if (Math.abs(extraVel) < 2.2) extraVel = 0

    pos += (autoPxPerSec + extraVel) * dt
    wrap()
    applyTransform()
    rafId = window.requestAnimationFrame(tick)
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return
    lastClientX = e.touches[0].clientX
    velSamples = [{ t: performance.now(), x: lastClientX }]
  }

  function onTouchMove(e) {
    if (e.touches.length !== 1 || lastClientX == null) return
    const x = e.touches[0].clientX
    const dx = x - lastClientX
    lastClientX = x
    const t = performance.now()
    pos -= dx
    velSamples.push({ t, x })
    if (velSamples.length > 10) velSamples.shift()
    wrap()
    applyTransform()
  }

  function onTouchEnd() {
    if (velSamples.length >= 2) {
      const use = velSamples.length > 6 ? velSamples.slice(-6) : velSamples
      const a = use[0]
      const b = use[use.length - 1]
      const dt = (b.t - a.t) / 1000
      if (dt > 0.004) {
        const dx = b.x - a.x
        const flickPxPerSec = -(dx / dt)
        extraVel += flickPxPerSec * FLICK_STRENGTH
        extraVel = Math.max(-EXTRA_VEL_CAP, Math.min(EXTRA_VEL_CAP, extraVel))
      }
    }
    lastClientX = null
    velSamples = []
  }

  viewport.addEventListener('touchstart', onTouchStart, { passive: true })
  viewport.addEventListener('touchmove', onTouchMove, { passive: true })
  viewport.addEventListener('touchend', onTouchEnd, { passive: true })
  viewport.addEventListener('touchcancel', onTouchEnd, { passive: true })

  rafId = window.requestAnimationFrame(tick)

  return () => {
    cancelled = true
    window.cancelAnimationFrame(rafId)
    viewport.removeEventListener('touchstart', onTouchStart)
    viewport.removeEventListener('touchmove', onTouchMove)
    viewport.removeEventListener('touchend', onTouchEnd)
    viewport.removeEventListener('touchcancel', onTouchEnd)
    track.style.transform = ''
    pos = 0
    extraVel = 0
  }
}

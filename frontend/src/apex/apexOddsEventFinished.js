/**
 * Whether an Odds API schedule event should be treated as already finished
 * (not selectable for analysis).
 *
 * Uses `completed` when present; otherwise assumes finished when wall clock is
 * past commence_time + a generous max game length (covers delay / API lag).
 */
const FINISHED_AFTER_MS = 4 * 60 * 60 * 1000

/**
 * Scheduled start has passed — pre-game analyze / pick-from-schedule should lock
 * (live betting can be a separate premium flow later).
 * @param {unknown} ev
 * @returns {boolean}
 */
export function isOddsEventPastCommence(ev) {
  if (!ev || typeof ev !== 'object') return false
  const t = new Date(ev.commence_time).getTime()
  if (Number.isNaN(t)) return false
  return Date.now() >= t
}

/**
 * @param {unknown} ev
 * @returns {boolean}
 */
export function isOddsEventFinished(ev) {
  if (!ev || typeof ev !== 'object') return false
  if (ev.completed === true) return true
  const t = new Date(ev.commence_time).getTime()
  if (Number.isNaN(t)) return false
  const now = Date.now()
  if (now < t) return false
  return now > t + FINISHED_AFTER_MS
}

/**
 * @param {HTMLElement} slide
 * @param {string} [label]
 */
export function appendGameOverOverlay(slide, label = 'Game over') {
  const el = document.createElement('div')
  el.className = 'apex-qg-game-over'
  el.setAttribute('aria-hidden', 'true')
  el.textContent = label
  slide.appendChild(el)
}

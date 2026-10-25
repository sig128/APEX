/**
 * Pre-game window: countdown next to Analyze + disable analyze after scheduled commence_time.
 * Live betting after start can be gated separately (premium) later.
 */

const TICK_MS = 1000

/**
 * @param {HTMLElement | null} root
 * @returns {number | null} epoch ms of scheduled start, or null if unknown
 */
export function readCommenceMsFromRoot(root) {
  const el = root?.querySelector('#apex-odds-commence-iso')
  if (!(el instanceof HTMLInputElement) || !el.value.trim()) return null
  const t = new Date(el.value.trim()).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * @param {HTMLElement | null} root
 * @param {string} [iso] - ISO 8601 from Odds API `commence_time`
 */
export function setCommenceIsoOnRoot(root, iso) {
  const el = root?.querySelector('#apex-odds-commence-iso')
  if (el instanceof HTMLInputElement) el.value = typeof iso === 'string' ? iso : ''
}

/**
 * @param {HTMLElement | null} root
 */
export function clearCommenceIsoOnRoot(root) {
  setCommenceIsoOnRoot(root, '')
}

/**
 * @param {number | null} commenceMs
 * @returns {boolean}
 */
export function isPastCommenceMs(commenceMs) {
  if (commenceMs == null) return false
  return Date.now() >= commenceMs
}

/**
 * Compact countdown: "2d 3h 4m", "1h 2m 3s", "45s"
 * @param {number} msUntil
 * @returns {string}
 */
export function formatCountdownUntil(msUntil) {
  if (!Number.isFinite(msUntil) || msUntil <= 0) return '0s'
  const sec = Math.floor(msUntil / 1000)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Updates countdown label only (does not change button disabled — use {@link applyAnalyzeButtonEnabledState}).
 * @param {HTMLElement | null} root
 */
export function updatePreGameCountdownLabel(root) {
  const cd = root?.querySelector('#apex-analyze-countdown')
  if (!cd) return
  const ms = readCommenceMsFromRoot(root)
  if (ms == null) {
    cd.hidden = true
    cd.textContent = ''
    cd.removeAttribute('title')
    cd.classList.remove('apex-analyze-countdown--urgent', 'apex-analyze-countdown--expired')
    return
  }
  const until = ms - Date.now()
  cd.hidden = false
  if (until <= 0) {
    cd.textContent = 'Started'
    cd.title = 'Game has started. Pre-game analysis is locked. Live betting may be offered separately.'
    cd.classList.add('apex-analyze-countdown--expired')
    cd.classList.remove('apex-analyze-countdown--urgent')
    return
  }
  cd.classList.remove('apex-analyze-countdown--expired')
  cd.title = 'Time until scheduled start — pre-game bet / analyze window'
  const minsLeft = until / 60000
  if (minsLeft <= 15) cd.classList.add('apex-analyze-countdown--urgent')
  else cd.classList.remove('apex-analyze-countdown--urgent')
  cd.textContent = formatCountdownUntil(until)
}

/**
 * Enables Analyze unless: analyzing in progress, or past commence when schedule time is known.
 * Call after clearing `data-analyzing`, and when restoring chat busy state.
 * @param {HTMLElement | null} root
 */
export function applyAnalyzeButtonEnabledState(root) {
  const btn = root?.querySelector('#abtn')
  if (!(btn instanceof HTMLButtonElement)) return
  if (btn.dataset.analyzing === '1') {
    btn.disabled = true
    return
  }
  const ms = readCommenceMsFromRoot(root)
  if (ms != null && Date.now() >= ms) {
    btn.disabled = true
    btn.title = 'Game has started. Pre-game analysis is locked.'
    return
  }
  btn.disabled = false
  btn.removeAttribute('title')
}

/**
 * @param {HTMLElement | null} root
 */
export function syncPreGameAnalyzeUi(root) {
  updatePreGameCountdownLabel(root)
  applyAnalyzeButtonEnabledState(root)
}

/**
 * @param {HTMLElement | null} root
 * @returns {() => void} stop interval
 */
export function startPreGameCountdownTicker(root) {
  syncPreGameAnalyzeUi(root)
  const id = window.setInterval(() => syncPreGameAnalyzeUi(root), TICK_MS)
  return () => window.clearInterval(id)
}

import { apiUrl } from './apiConfig.js'
import { humanizeOddsScheduleError } from './humanReadableError.js'
import {
  playCarouselPickAnimation,
  playFlyToAnalyzeButton,
} from './apexAnalyzePickAnimation.js'
import { appendGameOverOverlay, isOddsEventFinished, isOddsEventPastCommence } from './apexOddsEventFinished.js'
import { setCommenceIsoOnRoot, syncPreGameAnalyzeUi } from './analyzeScheduleLock.js'
import { loadEspnTeamLogos, resolveTeamLogoUrl } from './espnTeamLogos.js'
import { setupMobileAutoPhysicsTicker, useMobileSwipeCarousel } from './apexCarouselMobileSwipe.js'
import { showPickedGameStrip } from './apexPickedGameStrip.js'

const LEAGUE_LABEL = {
  americanfootball_nfl: 'NFL',
  basketball_nba: 'NBA',
  baseball_mlb: 'MLB',
  icehockey_nhl: 'NHL',
}

/** Values from `#apex-odds-sport` — must match backend `resolveSportsParam`. */
const VALID_CAROUSEL_SPORT_FILTERS = new Set(['all', 'nfl', 'nba', 'mlb', 'nhl'])

const OFFSEASON_LEAGUE_LABEL = {
  nfl: 'NFL',
  nba: 'NBA',
  mlb: 'MLB',
  nhl: 'NHL',
}

/**
 * @param {HTMLElement} root
 * @returns {string}
 */
function readCarouselSportFilter(root) {
  const sel = root.querySelector('#apex-odds-sport')
  const v = sel instanceof HTMLSelectElement ? sel.value.trim().toLowerCase() : 'all'
  return VALID_CAROUSEL_SPORT_FILTERS.has(v) ? v : 'all'
}

/**
 * @param {string} sport - `all` | `nfl` | `nba` | `mlb` | `nhl`
 */
function buildUpcomingOddsUrl(sport) {
  const params = new URLSearchParams()
  params.set('sport', sport)
  if (sport === 'all') {
    params.set('perSportLimit', '120')
  } else {
    params.set('limit', '60')
  }
  return `${apiUrl('/api/odds/upcoming')}?${params}`
}

/** How many game columns are visible at once (stock-ticker row). */
const DESKTOP_VISIBLE_SLOTS = 3
const MOBILE_VISIBLE_SLOTS = 1

/** Space between each game card — keep in sync with `--apex-qg-ticker-gap` in ApexApp.css */
const TICKER_GAP_PX = 12

/** Horizontal scroll speed for the ticker (pixels per second). */
const TICKER_PX_PER_SEC = 32
const MOBILE_TICKER_SPEED_MULTIPLIER = 2

/** Minimum duration (seconds) for one full pass of the unique game list — keeps very short lists from zipping by. */
const MIN_TICKER_DURATION_SEC = 45

function teamAbbr(name) {
  if (!name || typeof name !== 'string') return '—'
  const words = name
    .replace(/\./g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return '—'
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  if (words.length === 2) {
    return (words[0][0] + words[1][0] + (words[1][1] || '')).toUpperCase().slice(0, 3)
  }
  return (words[0][0] + words[1][0] + words[2][0]).toUpperCase().slice(0, 3)
}

function formatDayTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { day: '—', time: '' }
  const now = new Date()
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((t1 - t0) / (24 * 60 * 60 * 1000))
  let day = d.toLocaleDateString(undefined, { weekday: 'short' })
  if (diff === 0) day = 'Today'
  if (diff === 1) day = 'Tomorrow'
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return { day, time }
}

function leagueFromEvent(ev) {
  const k = ev.sport_key || ''
  return LEAGUE_LABEL[k] || ev.sport_title || '—'
}

/**
 * @param {HTMLElement} root
 * @returns {() => void} cleanup
 */
export function setupQuickGamesCarousel(root) {
  const track = root.querySelector('#apex-qg-carousel-track')
  const viewport = root.querySelector('.apex-qg-carousel-viewport')
  if (!track || !viewport) return () => {}

  /** Native swipe loop cleanup (mobile); replaced each layout */
  let detachMobileSwipe = () => {}

  function clearTickerChrome() {
    detachMobileSwipe()
    detachMobileSwipe = () => {}
    track.classList.remove('apex-qg-carousel-track--ticker')
    viewport.classList.remove(
      'apex-qg-carousel-viewport--ticker',
      'apex-qg-carousel-viewport--paused',
      'apex-qg-carousel-viewport--swipe',
    )
    track.style.animation = 'none'
    track.style.width = ''
    track.style.transform = ''
    track.style.removeProperty('--apex-qg-ticker-duration')
  }

  let events = []
  /** Ignores stale responses when `load()` runs again before the previous fetch finishes. */
  let loadSeq = 0

  function hasRenderableSlides() {
    return Boolean(track.querySelector('.apex-qg-slide:not(.apex-qg-slide--empty)'))
  }

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function viewportWidthPx() {
    return Math.max(0, viewport.clientWidth)
  }

  function cellWidthPx() {
    const vw = viewportWidthPx()
    if (vw === 0) return 0
    const slots =
      typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
        ? MOBILE_VISIBLE_SLOTS
        : DESKTOP_VISIBLE_SLOTS
    return (vw - (slots - 1) * TICKER_GAP_PX) / slots
  }

  /** Layout for static row (reduced motion): up to 3 games, no scroll. */
  function layoutStaticRow() {
    const cw = cellWidthPx()
    if (cw === 0) return
    const slides = track.querySelectorAll('.apex-qg-slide:not(.apex-qg-slide--empty)')
    slides.forEach((slide) => {
      slide.style.flex = `0 0 ${cw}px`
      slide.style.width = `${cw}px`
    })
    track.style.width = ''
  }

  function getOneSetPxForSwipe() {
    const slides = track.querySelectorAll('.apex-qg-slide:not(.apex-qg-slide--empty)')
    if (slides.length === 0) return 0
    const half = slides.length / 2
    if (!Number.isInteger(half) || half === 0) return 0
    const cw = cellWidthPx()
    if (cw === 0) return 0
    return half * cw + Math.max(0, half - 1) * TICKER_GAP_PX
  }

  /** Duplicated track: desktop CSS loop; mobile native scroll + momentum + seamless jump. */
  function layoutTicker() {
    detachMobileSwipe()
    detachMobileSwipe = () => {}

    const slides = track.querySelectorAll('.apex-qg-slide:not(.apex-qg-slide--empty)')
    if (slides.length === 0) return
    const cw = cellWidthPx()
    if (cw === 0) return
    const half = slides.length / 2
    if (!Number.isInteger(half) || half === 0) return

    slides.forEach((slide) => {
      slide.style.flex = `0 0 ${cw}px`
      slide.style.width = `${cw}px`
    })
    track.style.width = ''

    const oneSetPx = half * cw + Math.max(0, half - 1) * TICKER_GAP_PX
    const mobileSwipe = useMobileSwipeCarousel() && !reducedMotion

    if (mobileSwipe) {
      viewport.classList.add('apex-qg-carousel-viewport--ticker', 'apex-qg-carousel-viewport--swipe')
      track.style.animation = 'none'
      track.style.removeProperty('--apex-qg-ticker-duration')
      const autoPxPerSec = TICKER_PX_PER_SEC * MOBILE_TICKER_SPEED_MULTIPLIER
      detachMobileSwipe = setupMobileAutoPhysicsTicker(
        viewport,
        track,
        getOneSetPxForSwipe,
        autoPxPerSec,
      )
      return
    }

    viewport.classList.remove('apex-qg-carousel-viewport--swipe')
    const speed =
      typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
        ? TICKER_PX_PER_SEC * MOBILE_TICKER_SPEED_MULTIPLIER
        : TICKER_PX_PER_SEC
    const duration = Math.max(MIN_TICKER_DURATION_SEC, oneSetPx / speed)
    track.style.setProperty('--apex-qg-ticker-duration', `${duration}s`)

    track.style.animation = 'none'
    void track.offsetWidth
    track.style.animation = ''
  }

  function applyLayout() {
    if (track.classList.contains('apex-qg-carousel-track--ticker')) layoutTicker()
    else if (track.querySelector('.apex-qg-slide:not(.apex-qg-slide--empty)')) layoutStaticRow()
  }

  function fillAnalyzeFromEvent(ev, slideEl) {
    if (isOddsEventFinished(ev)) return
    if (isOddsEventPastCommence(ev)) return
    playCarouselPickAnimation(slideEl)
    const sportKeyForGlow =
      typeof ev?.sport_key === 'string' ? ev.sport_key : slideEl?.dataset?.sport
    playFlyToAnalyzeButton(root, slideEl, sportKeyForGlow)
    const oddsEventIdEl = root.querySelector('#apex-odds-event-id')
    if (oddsEventIdEl instanceof HTMLInputElement && typeof ev.id === 'string') {
      oddsEventIdEl.value = ev.id
    }
    setCommenceIsoOnRoot(root, typeof ev.commence_time === 'string' ? ev.commence_time : '')
    syncPreGameAnalyzeUi(root)
    const f1 = root.querySelector('#f1')
    const f2 = root.querySelector('#f2')
    const f3 = root.querySelector('#f3')
    const f4 = root.querySelector('#f4')
    if (f1) f1.value = typeof ev.home_team === 'string' ? ev.home_team : ''
    if (f2) f2.value = typeof ev.away_team === 'string' ? ev.away_team : ''
    const d = new Date(ev.commence_time)
    if (f3 && !Number.isNaN(d.getTime())) {
      f3.value = d.toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    }
    if (f4 && !Number.isNaN(d.getTime())) {
      f4.value = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
    try {
      root.dispatchEvent(
        new CustomEvent('apex:analyze-fill', {
          detail: {
            sportKey: typeof ev?.sport_key === 'string' ? ev.sport_key : null,
          },
        }),
      )
    } catch {
      /* ignore */
    }
    void showPickedGameStrip(root, {
      awayTeam: typeof ev.away_team === 'string' ? ev.away_team : '',
      homeTeam: typeof ev.home_team === 'string' ? ev.home_team : '',
      sportKey: typeof ev.sport_key === 'string' ? ev.sport_key : 'baseball_mlb',
    })
    const inp = root.querySelector('.inp-panel')
    if (inp && typeof window !== 'undefined') {
      const delay = reducedMotion ? 0 : 540
      window.setTimeout(() => {
        inp.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, delay)
    }
  }

  function buildTeamColumn(logoMaps, sportKey, fullName, abbr) {
    const col = document.createElement('div')
    col.className = 'apex-qg-team'
    const logoWrap = document.createElement('div')
    logoWrap.className = 'apex-qg-logo'
    logoWrap.setAttribute('aria-hidden', 'true')

    const url = resolveTeamLogoUrl(logoMaps, sportKey, fullName)
    if (url) {
      const img = document.createElement('img')
      img.className = 'apex-qg-logo-img'
      img.src = url
      img.alt = ''
      img.width = 44
      img.height = 44
      img.loading = 'lazy'
      img.decoding = 'async'
      logoWrap.classList.add('apex-qg-logo--img')
      img.addEventListener(
        'error',
        () => {
          logoWrap.classList.remove('apex-qg-logo--img')
          img.remove()
          logoWrap.textContent = abbr.slice(0, 1)
        },
        { once: true },
      )
      logoWrap.appendChild(img)
    } else {
      logoWrap.textContent = abbr.slice(0, 1)
    }

    const nameEl = document.createElement('span')
    nameEl.className = 'apex-qg-team-name'
    nameEl.textContent = fullName
    nameEl.title = fullName
    col.appendChild(logoWrap)
    col.appendChild(nameEl)
    return col
  }

  function buildSlide(ev, i, n, logoMaps) {
    const slide = document.createElement('div')
    slide.className = 'apex-qg-slide'
    slide.setAttribute('role', 'group')
    slide.setAttribute('aria-roledescription', 'slide')
    const away = typeof ev.away_team === 'string' ? ev.away_team : 'Away'
    const home = typeof ev.home_team === 'string' ? ev.home_team : 'Home'
    const finished = isOddsEventFinished(ev)
    const pastCommence = isOddsEventPastCommence(ev)
    const lockedPick = finished || pastCommence
    slide.setAttribute(
      'aria-label',
      `${leagueFromEvent(ev)}: ${away} at ${home}, game ${i + 1} of ${n}${
        finished ? ', game over' : pastCommence ? ', started' : ''
      }`,
    )

    const { day: dayStr, time: timeStr } = formatDayTime(ev.commence_time)
    const aa = teamAbbr(away)
    const ha = teamAbbr(home)
    const sportKey = typeof ev.sport_key === 'string' ? ev.sport_key : 'icehockey_nhl'
    slide.dataset.sport = sportKey

    slide.tabIndex = 0
    slide.setAttribute('role', 'button')
    slide.setAttribute('aria-roledescription', 'button')
    if (lockedPick) {
      slide.classList.add('apex-qg-slide--finished')
      slide.setAttribute('aria-disabled', 'true')
      appendGameOverOverlay(slide, finished ? 'Game over' : 'Started')
    }

    const onActivateFinished = () => {
      slide.classList.add('apex-qg-slide--finished-flash')
      window.setTimeout(() => slide.classList.remove('apex-qg-slide--finished-flash'), 420)
    }

    slide.addEventListener('click', () => {
      if (lockedPick) {
        onActivateFinished()
        return
      }
      fillAnalyzeFromEvent(ev, slide)
    })
    slide.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (lockedPick) {
          onActivateFinished()
          return
        }
        fillAnalyzeFromEvent(ev, slide)
      }
    })

    const league = document.createElement('span')
    league.className = 'apex-qg-league'
    league.textContent = leagueFromEvent(ev)

    const mid = document.createElement('div')
    mid.className = 'apex-qg-mid'
    const day = document.createElement('span')
    day.className = 'apex-qg-day'
    day.textContent = dayStr
    const tim = document.createElement('span')
    tim.className = 'apex-qg-time'
    tim.textContent = timeStr ? `at ${timeStr}` : ''
    mid.appendChild(day)
    mid.appendChild(tim)

    slide.appendChild(league)
    slide.appendChild(buildTeamColumn(logoMaps, sportKey, away, aa))
    slide.appendChild(mid)
    slide.appendChild(buildTeamColumn(logoMaps, sportKey, home, ha))
    return slide
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  const carouselEl = root.querySelector('#apex-qg-carousel')
  const offseasonMsgEl = root.querySelector('#apex-qg-offseason')

  function hideOffSeasonUi() {
    if (offseasonMsgEl) {
      offseasonMsgEl.hidden = true
      offseasonMsgEl.textContent = ''
    }
    if (carouselEl) carouselEl.hidden = false
  }

  /**
   * Single-league filter returned no events — treat as off season, hide ticker chrome.
   * @param {string} sportFilter - `nfl` | `nba` | `mlb` | `nhl`
   */
  function showOffSeasonUi(sportFilter) {
    const label = OFFSEASON_LEAGUE_LABEL[sportFilter] || String(sportFilter).toUpperCase()
    clearTickerChrome()
    track.replaceChildren()
    if (offseasonMsgEl && carouselEl) {
      offseasonMsgEl.textContent = `${label} is off season — no scheduled games right now.`
      offseasonMsgEl.hidden = false
      carouselEl.hidden = true
    } else {
      hideOffSeasonUi()
      renderEmpty(`${label} is off season — no scheduled games right now.`)
    }
  }

  function renderEmpty(message) {
    hideOffSeasonUi()
    clearTickerChrome()
    track.replaceChildren()
    const slide = document.createElement('div')
    slide.className = 'apex-qg-slide apex-qg-slide--empty'
    slide.innerHTML = `<p class="apex-qg-empty-msg">${escapeHtml(message)}</p>`
    track.appendChild(slide)
    window.requestAnimationFrame(() => {
      const w = viewportWidthPx()
      if (w > 0) {
        slide.style.flex = `0 0 ${w}px`
        slide.style.width = `${w}px`
      }
    })
  }

  async function load() {
    const seq = ++loadSeq
    const hadSlides = hasRenderableSlides()
    if (!hadSlides) {
      renderEmpty('Loading upcoming games…')
    }
    try {
      const sportFilter = readCarouselSportFilter(root)
      const oddsUrl = buildUpcomingOddsUrl(sportFilter)
      const [logoMaps, oddsRes] = await Promise.all([
        loadEspnTeamLogos(),
        fetch(oddsUrl, { cache: 'no-store' }),
      ])
      if (seq !== loadSeq) return
      const data = await oddsRes.json().catch(() => ({}))
      if (seq !== loadSeq) return
      if (!oddsRes.ok) {
        const errMsg = humanizeOddsScheduleError(typeof data.error === 'string' ? data.error : '')
        if (!hadSlides) {
          renderEmpty(errMsg)
        }
        return
      }
      const list = Array.isArray(data.events) ? data.events : []
      if (list.length === 0) {
        if (sportFilter !== 'all') {
          showOffSeasonUi(sportFilter)
          return
        }
        hideOffSeasonUi()
        renderEmpty('No upcoming games right now.')
        return
      }

      hideOffSeasonUi()
      events = list
      track.replaceChildren()

      if (reducedMotion) {
        const slots =
          typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
            ? MOBILE_VISIBLE_SLOTS
            : DESKTOP_VISIBLE_SLOTS
        const subset = events.slice(0, slots)
        subset.forEach((ev, i) => {
          track.appendChild(buildSlide(ev, i, subset.length, logoMaps))
        })
        viewport.classList.add('apex-qg-carousel-viewport--ticker')
        window.requestAnimationFrame(() => layoutStaticRow())
        return
      }

      events.forEach((ev, i) => {
        track.appendChild(buildSlide(ev, i, events.length, logoMaps))
      })

      const n = events.length
      for (let i = 0; i < n; i++) {
        const clone = track.children[i].cloneNode(true)
        clone.setAttribute('aria-hidden', 'true')
        track.appendChild(clone)
      }

      track.classList.add('apex-qg-carousel-track--ticker')
      viewport.classList.add('apex-qg-carousel-viewport--ticker')
      window.requestAnimationFrame(() => layoutTicker())
    } catch (e) {
      if (seq !== loadSeq) return
      if (!hadSlides) {
        renderEmpty(humanizeOddsScheduleError(e))
      }
    }
  }

  const onVis = () => {
    viewport.classList.toggle('apex-qg-carousel-viewport--paused', document.visibilityState === 'hidden')
  }
  document.addEventListener('visibilitychange', onVis)

  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          applyLayout()
        })
      : null
  ro?.observe(viewport)

  const onResize = () => applyLayout()
  window.addEventListener('resize', onResize)

  const sportSel = root.querySelector('#apex-odds-sport')
  const onSportFilterChange = () => {
    void load()
  }
  sportSel?.addEventListener('change', onSportFilterChange)

  void load()

  return () => {
    ro?.disconnect()
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('resize', onResize)
    sportSel?.removeEventListener('change', onSportFilterChange)
    hideOffSeasonUi()
    clearTickerChrome()
  }
}

/**
 * Infinite horizontal ticker: live MLB player props from The Odds API (via `/api/odds/mlb-player-props-showcase`)
 * with sessionStorage cache + server cache. Falls back to sample rows if the API is empty or errors.
 * @param {HTMLElement} root - `.apex-html-root` container
 * @returns {() => void} cleanup
 */

import { apiUrl } from './apiConfig.js'
import { authHeaders } from '../lib/api.js'
import { formatAmericanOddsWithImpliedPercent } from './americanOddsPercent.js'
import { setupMobileAutoPhysicsTicker, useMobileSwipeCarousel } from './apexCarouselMobileSwipe.js'

/** Keep in sync with `--apex-qg-ticker-gap` in ApexApp.css */
const TICKER_GAP_PX = 12
const DESKTOP_VISIBLE_SLOTS = 3
const MOBILE_VISIBLE_SLOTS = 1
const TICKER_PX_PER_SEC = 32
const MOBILE_TICKER_SPEED_MULTIPLIER = 2
const MIN_TICKER_DURATION_SEC = 45

/** Browser cache — stay below server TTL so we rarely hit the network on tab revisits. */
const CLIENT_SHOWCASE_CACHE_KEY = 'apex-mlb-ppc-showcase-v7'
/** Align with server showcase cache — fewer Odds API calls from repeat page loads. */
const CLIENT_SHOWCASE_TTL_MS = 6 * 60 * 60 * 1000

function viewportWidthPx(viewport) {
  return Math.max(0, viewport.clientWidth)
}

function cellWidthPx(viewport) {
  const vw = viewportWidthPx(viewport)
  if (vw === 0) return 0
  const slots =
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
      ? MOBILE_VISIBLE_SLOTS
      : DESKTOP_VISIBLE_SLOTS
  return (vw - (slots - 1) * TICKER_GAP_PX) / slots
}

function layoutStaticRow(track, viewport) {
  const cw = cellWidthPx(viewport)
  if (cw === 0) return
  const slides = track.querySelectorAll('.apex-qg-slide:not(.apex-qg-slide--empty)')
  slides.forEach((slide) => {
    slide.style.flex = `0 0 ${cw}px`
    slide.style.width = `${cw}px`
  })
  track.style.width = ''
}

const FALLBACK_ROWS = [
  {
    name: 'Juan Soto',
    meta: 'NYY · OF',
    prop: 'Hits O/U 0.5',
    odds: 'Over',
    line: formatAmericanOddsWithImpliedPercent(-115),
    mlbPlayerId: 665742,
  },
  {
    name: 'Aaron Judge',
    meta: 'NYY · OF',
    prop: 'Home runs O/U 0.5',
    odds: 'Over',
    line: formatAmericanOddsWithImpliedPercent(185),
    mlbPlayerId: 592450,
  },
  {
    name: 'Gerrit Cole',
    meta: 'NYY · SP',
    prop: 'Pitcher strikeouts (O/U)',
    propMarketKey: 'pitcher_strikeouts',
    impliedPoint: 5.5,
    ouLadder: [
      {
        point: 4.5,
        overPrice: -275,
        underPrice: 190,
        overLabel: formatAmericanOddsWithImpliedPercent(-275),
        underLabel: formatAmericanOddsWithImpliedPercent(190),
      },
      {
        point: 5.5,
        overPrice: -120,
        underPrice: -115,
        overLabel: formatAmericanOddsWithImpliedPercent(-120),
        underLabel: formatAmericanOddsWithImpliedPercent(-115),
      },
      {
        point: 6.5,
        overPrice: 165,
        underPrice: -240,
        overLabel: formatAmericanOddsWithImpliedPercent(165),
        underLabel: formatAmericanOddsWithImpliedPercent(-240),
      },
    ],
    mlbPlayerId: 543037,
  },
  {
    name: 'Bobby Witt Jr.',
    meta: 'KC · SS',
    prop: 'Total bases O/U 1.5',
    odds: 'Over',
    line: formatAmericanOddsWithImpliedPercent(-122),
    mlbPlayerId: 677951,
  },
  {
    name: 'Shohei Ohtani',
    meta: 'LAD · DH',
    prop: 'Hits + Runs + RBI O/U 1.5',
    odds: 'Over',
    line: formatAmericanOddsWithImpliedPercent(-105),
    mlbPlayerId: 660271,
  },
  {
    name: 'Corbin Burnes',
    meta: 'BAL · SP',
    prop: 'Pitching outs O/U 18.5',
    odds: 'Under',
    line: formatAmericanOddsWithImpliedPercent(102),
    mlbPlayerId: 669134,
  },
]

function initialsFromName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * @returns {Promise<{ rows: object[], hint: string, source: string }>}
 */
async function loadShowcaseRows() {
  try {
    const raw = sessionStorage.getItem(CLIENT_SHOWCASE_CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const { at, payload } = parsed
      if (
        typeof at === 'number' &&
        payload &&
        Date.now() - at < CLIENT_SHOWCASE_TTL_MS &&
        (Array.isArray(payload.props) || (payload.source === 'live' && Array.isArray(payload.bookOptions)))
      ) {
        return normalizeApiPayload(payload, true)
      }
    }
  } catch {
    /* ignore */
  }

  const res = await fetch(apiUrl('/api/odds/mlb-player-props-showcase'), {
    cache: 'default',
    headers: await authHeaders().catch(() => ({})),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = humanizeShowcaseErrorPayload(data)
    return { rows: FALLBACK_ROWS, hint: carouselFallbackHint(msg), source: 'fallback' }
  }

  try {
    sessionStorage.setItem(
      CLIENT_SHOWCASE_CACHE_KEY,
      JSON.stringify({ at: Date.now(), payload: data }),
    )
  } catch {
    /* quota / private mode */
  }

  return normalizeApiPayload(data, false)
}

function humanizeShowcaseErrorPayload(data) {
  if (!data || typeof data !== 'object') return 'Could not load player props.'
  if (typeof data.error === 'string') {
    const e = data.error.trim()
    if (e.startsWith('{')) {
      try {
        const j = JSON.parse(e)
        if (j.error_code === 'EXCEEDED_FREQ_LIMIT' || /too frequent/i.test(String(j.message || ''))) {
          return 'Odds feed is rate-limited. Try again in a few minutes.'
        }
        if (typeof j.message === 'string' && j.message.trim()) return j.message.trim()
      } catch {
        /* use raw slice */
      }
    }
    return e.length > 240 ? `${e.slice(0, 120)}…` : e
  }
  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim()
  return 'Could not load player props.'
}

/** Short label for the ticker — avoid long API errors in the hero line. */
function carouselFallbackHint(serverMessage) {
  const m = String(serverMessage || '').trim()
  if (/rate limit|busy|too frequent|EXCEEDED_FREQ/i.test(m)) {
    return 'Odds feed is busy — sample lines below'
  }
  return 'Sample lines'
}

function normalizeApiPayload(data, fromClientCache) {
  const bookOptions = Array.isArray(data.bookOptions) ? data.bookOptions : []
  const props = Array.isArray(data.props) ? data.props : []
  const defaultKey = typeof data.defaultBookKey === 'string' ? data.defaultBookKey : ''

  if (data.source === 'live') {
    const hint = 'Live Lines'

    if (bookOptions.length > 0) {
      let rows = props
      if (defaultKey) {
        const match = bookOptions.find((b) => b.key === defaultKey)
        if (match && Array.isArray(match.props) && match.props.length > 0) {
          rows = match.props
        }
      } else if (bookOptions[0]?.props?.length) {
        rows = bookOptions[0].props
      }
      if (rows.length > 0) {
        return {
          rows,
          hint,
          source: 'live',
          bookOptions,
          defaultBookKey: defaultKey || bookOptions[0].key,
        }
      }
    }
    if (props.length > 0) {
      return { rows: props, hint, source: 'live', bookOptions: null, defaultBookKey: '' }
    }
  }

  const msg = typeof data.message === 'string' ? data.message : ''
  return {
    rows: FALLBACK_ROWS,
    hint: carouselFallbackHint(msg),
    source: 'fallback',
    bookOptions: null,
    defaultBookKey: '',
  }
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

/**
 * When set on `.apex-html-root`, fullscreen game analysis is open: Live Lines carousel uses
 * ladder O/U layout + implied-line chrome. Homepage (analyzer landing) omits ladders (see CSS + mount).
 */
const IMPLIED_LINES_ROOT_CLASS = 'apex-ppc-implied-on'

export function setupPlayerPropsCarousel(root) {
  const track = root.querySelector('#apex-ppc-track')
  const viewport = root.querySelector('#apex-ppc-viewport')
  const hintEl = root.querySelector('#apex-ppc-hint')
  const bookSelect = root.querySelector('#apex-ppc-book')
  if (!track || !viewport) return () => {}

  const analyzePageEl = root.querySelector('#apex-analyze-page')
  /** Raw props from API — remount when analysis page opens/closes so ladder vs flat matches context. */
  let lastPpcRawRows = []
  let lastPpcBookLabel = ''

  let detachMobileSwipe = () => {}

  function clearTickerChrome() {
    detachMobileSwipe()
    detachMobileSwipe = () => {}
    track.classList.remove('apex-qg-carousel-track--ticker')
    viewport.classList.remove('apex-qg-carousel-viewport--swipe')
    track.style.animation = 'none'
    track.style.width = ''
    track.style.transform = ''
    track.style.removeProperty('--apex-qg-ticker-duration')
  }

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function getOneSetPxForSwipe() {
    const slides = track.querySelectorAll('.apex-qg-slide:not(.apex-qg-slide--empty)')
    if (slides.length === 0) return 0
    const half = slides.length / 2
    if (!Number.isInteger(half) || half === 0) return 0
    const cw = cellWidthPx(viewport)
    if (cw === 0) return 0
    return half * cw + Math.max(0, half - 1) * TICKER_GAP_PX
  }

  function layoutTicker() {
    detachMobileSwipe()
    detachMobileSwipe = () => {}

    const slides = track.querySelectorAll('.apex-qg-slide:not(.apex-qg-slide--empty)')
    if (slides.length === 0) return
    const cw = cellWidthPx(viewport)
    if (cw === 0) return
    const half = slides.length / 2
    if (!Number.isInteger(half) || half === 0) return

    slides.forEach((slide) => {
      slide.style.flex = `0 0 ${cw}px`
      slide.style.width = `${cw}px`
    })
    track.style.width = ''

    const oneSetPx = half * cw + Math.max(0, half - 1) * TICKER_GAP_PX

    if (useMobileSwipeCarousel() && !reducedMotion) {
      viewport.classList.add('apex-qg-carousel-viewport--swipe')
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

  const mlbHeadshot = (peopleId) =>
    `https://img.mlbstatic.com/mlb-photos/image/upload/w_128,q_auto:best,f_auto/v1/people/${peopleId}/headshot/silo/current`

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

  function parseMlbPeopleId(v) {
    if (v == null || v === '') return null
    const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  function imgBlock(r) {
    const id = parseMlbPeopleId(r.mlbPlayerId)
    if (id) {
      return `<img class="apex-ppc-card-img" src="${mlbHeadshot(id)}" alt="${esc(r.name)}" width="64" height="64" loading="lazy" decoding="async" />`
    }
    return `<div class="apex-ppc-card-img-fallback" aria-hidden="true">${esc(initialsFromName(r.name))}</div>`
  }

  function formatLadderPoint(p) {
    if (typeof p !== 'number' || !Number.isFinite(p)) return '—'
    return Number.isInteger(p) ? String(p) : String(p)
  }

  /**
   * Single-line card for homepage: one O/U row (implied line if present, else middle of ladder).
   * @param {object} r
   */
  function flattenLadderRowForHomepage(r) {
    const ladder = Array.isArray(r.ouLadder) ? r.ouLadder : []
    if (ladder.length === 0) return r
    const implied =
      typeof r.impliedPoint === 'number' && Number.isFinite(r.impliedPoint) ? r.impliedPoint : null
    let row = implied != null ? ladder.find((x) => x.point === implied) : null
    if (!row) row = ladder[Math.floor(ladder.length / 2)] || ladder[0]
    const pt = formatLadderPoint(row.point)
    const oL = typeof row.overLabel === 'string' ? row.overLabel : '—'
    const { ouLadder, impliedPoint, ...rest } = r
    const baseProp = typeof rest.prop === 'string' ? rest.prop.trim() : ''
    return {
      ...rest,
      prop: baseProp ? `${baseProp} · O ${pt}` : `O ${pt}`,
      odds: 'Over',
      line: oL,
    }
  }

  function rowsForCarouselView(rows) {
    if (root.classList.contains(IMPLIED_LINES_ROOT_CLASS)) return rows
    return rows.map((r) =>
      Array.isArray(r.ouLadder) && r.ouLadder.length > 0 ? flattenLadderRowForHomepage(r) : r,
    )
  }

  /**
   * @param {object} r
   */
  function ladderGridHtml(r) {
    const ladder = Array.isArray(r.ouLadder) ? r.ouLadder : []
    if (ladder.length === 0) return ''
    const implied =
      typeof r.impliedPoint === 'number' && Number.isFinite(r.impliedPoint) ? r.impliedPoint : null
    return ladder
      .map((row) => {
        const isImplied = implied != null && row.point === implied
        const rowCls = isImplied ? 'apex-ppc-ou-row apex-ppc-ou-row--implied' : 'apex-ppc-ou-row'
        const pt = formatLadderPoint(row.point)
        const oL = typeof row.overLabel === 'string' ? row.overLabel : '—'
        const uL = typeof row.underLabel === 'string' ? row.underLabel : '—'
        const impliedBar = isImplied
          ? '<div class="apex-ppc-implied-bar"><span class="apex-ppc-implied-bar-text">Implied line</span></div>'
          : ''
        return `${impliedBar}<div class="${rowCls}">
          <div class="apex-ppc-ou-cell" aria-label="Over ${pt} at ${esc(oL)}">
            <span class="apex-ppc-ou-cell-main"><span class="apex-ppc-ou-side">O</span> ${esc(pt)}</span>
            <span class="apex-ppc-ou-price">${esc(oL)}</span>
          </div>
          <div class="apex-ppc-ou-cell" aria-label="Under ${pt} at ${esc(uL)}">
            <span class="apex-ppc-ou-cell-main"><span class="apex-ppc-ou-side">U</span> ${esc(pt)}</span>
            <span class="apex-ppc-ou-price">${esc(uL)}</span>
          </div>
        </div>`
      })
      .join('')
  }

  /**
   * @param {object[]} data
   * @param {string} [bookLabel] - selected sportsbook name for subtle ladder chip
   */
  function slidesHtmlFor(data, bookLabel = '') {
    const bookChip =
      typeof bookLabel === 'string' && bookLabel.trim()
        ? `<span class="apex-ppc-book-pill">${esc(bookLabel.trim())}</span>`
        : ''

    return data
      .map((r) => {
        const ladder = Array.isArray(r.ouLadder) && r.ouLadder.length > 0
        if (ladder) {
          return `
    <article class="apex-qg-slide apex-ppc-slide apex-ppc-slide--ladder" data-sport="baseball_mlb" role="group" aria-label="${esc(r.name)} · ${esc(r.prop)} · alternate lines">
      <span class="apex-qg-league">MLB</span>
      <div class="apex-ppc-slide-inner apex-ppc-slide-inner--ladder">
        <div class="apex-ppc-ladder-head">
          <div class="apex-ppc-card-img-wrap" aria-hidden="false">
            ${imgBlock(r)}
          </div>
          <div class="apex-ppc-ladder-head-text">
            <div class="apex-ppc-prop-row">
              <span class="apex-ppc-prop apex-ppc-prop--ladder-market">${esc(r.prop)}</span>
              ${bookChip}
            </div>
            <div class="apex-ppc-name">${esc(r.name)}</div>
            <div class="apex-ppc-meta">${esc(r.meta)}</div>
          </div>
        </div>
        <div class="apex-ppc-ou-grid" aria-label="${esc(r.name)} over and under by line">
          ${ladderGridHtml(r)}
        </div>
      </div>
    </article>`
        }
        return `
    <article class="apex-qg-slide apex-ppc-slide" data-sport="baseball_mlb" role="group" aria-label="${esc(r.name)} · ${esc(r.prop)}">
      <span class="apex-qg-league">MLB</span>
      <div class="apex-ppc-slide-inner">
        <div class="apex-ppc-card-img-wrap">
          ${imgBlock(r)}
        </div>
        <div class="apex-ppc-card-body">
          <div class="apex-ppc-name">${esc(r.name)}</div>
          <div class="apex-ppc-meta">${esc(r.meta)}</div>
          <div class="apex-ppc-prop">${esc(r.prop)}</div>
        </div>
        <div class="apex-ppc-odds" aria-label="Odds: ${esc(r.odds)} ${esc(r.line)}">
          <span class="apex-ppc-side">${esc(r.odds)}</span>
          <span class="apex-ppc-line">${esc(r.line)}</span>
        </div>
      </div>
    </article>`
      })
      .join('')
  }

  function applyLayout() {
    if (track.classList.contains('apex-qg-carousel-track--ticker')) layoutTicker()
    else if (track.querySelector('.apex-qg-slide:not(.apex-qg-slide--empty)')) layoutStaticRow(track, viewport)
  }

  let cancelled = false

  /**
   * @param {object[]} rows
   * @param {string} [bookLabel]
   */
  function mountCarousel(rows, bookLabel = '') {
    if (cancelled) return
    lastPpcRawRows = rows
    lastPpcBookLabel = bookLabel
    if (rows.length === 0) {
      track.innerHTML = ''
      return
    }

    const viewRows = rowsForCarouselView(rows)

    if (reducedMotion) {
      const slots =
        typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
          ? MOBILE_VISIBLE_SLOTS
          : DESKTOP_VISIBLE_SLOTS
      track.innerHTML = slidesHtmlFor(viewRows.slice(0, slots), bookLabel)
      window.requestAnimationFrame(() => layoutStaticRow(track, viewport))
    } else {
      track.innerHTML = slidesHtmlFor(viewRows, bookLabel)
      const n = viewRows.length
      for (let i = 0; i < n; i++) {
        const clone = track.children[i].cloneNode(true)
        clone.setAttribute('aria-hidden', 'true')
        track.appendChild(clone)
      }
      track.classList.add('apex-qg-carousel-track--ticker')
      window.requestAnimationFrame(() => layoutTicker(track, viewport))
    }
  }

  const syncImpliedLinesClass = () => {
    const open =
      analyzePageEl instanceof HTMLElement && analyzePageEl.isConnected && !analyzePageEl.hidden
    root.classList.toggle(IMPLIED_LINES_ROOT_CLASS, open)
    if (lastPpcRawRows.length > 0) mountCarousel(lastPpcRawRows, lastPpcBookLabel)
  }
  syncImpliedLinesClass()
  const impliedMo =
    analyzePageEl && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => syncImpliedLinesClass())
      : null
  impliedMo?.observe(analyzePageEl, { attributes: true, attributeFilter: ['hidden'] })

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

  /** @type {{ key: string, title: string, props: object[] }[] | null} */
  let liveBookOptions = null
  /** @type {string} */
  let selectedBookLabel = ''

  const onBookChange = () => {
    if (cancelled || !bookSelect || !liveBookOptions) return
    const sel = liveBookOptions.find((b) => b.key === bookSelect.value)
    if (sel && Array.isArray(sel.props)) {
      selectedBookLabel = typeof sel.title === 'string' ? sel.title : sel.key
      mountCarousel(sel.props, selectedBookLabel)
    }
  }
  bookSelect?.addEventListener('change', onBookChange)

  void loadShowcaseRows().then((result) => {
    if (cancelled) return
    const { rows, hint, bookOptions, defaultBookKey } = result
    if (hintEl && typeof hint === 'string') {
      hintEl.textContent = hint
    }

    if (bookSelect && bookOptions && bookOptions.length > 0) {
      liveBookOptions = bookOptions
      bookSelect.innerHTML = bookOptions
        .map(
          (b) =>
            `<option value="${escapeAttr(b.key)}">${esc(typeof b.title === 'string' ? b.title : b.key)}</option>`,
        )
        .join('')
      const preferred =
        defaultBookKey && bookOptions.some((x) => x.key === defaultBookKey)
          ? defaultBookKey
          : bookOptions[0].key
      bookSelect.value = preferred
      bookSelect.hidden = false
      const active = bookOptions.find((b) => b.key === bookSelect.value)
      selectedBookLabel = active && typeof active.title === 'string' ? active.title : preferred
      mountCarousel(active && Array.isArray(active.props) ? active.props : rows, selectedBookLabel)
    } else {
      liveBookOptions = null
      if (bookSelect) {
        bookSelect.innerHTML = ''
        bookSelect.hidden = true
      }
      selectedBookLabel = ''
      mountCarousel(rows, '')
    }
  })

  return () => {
    cancelled = true
    impliedMo?.disconnect()
    root.classList.remove(IMPLIED_LINES_ROOT_CLASS)
    bookSelect?.removeEventListener('change', onBookChange)
    ro?.disconnect()
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('resize', onResize)
    clearTickerChrome()
  }
}

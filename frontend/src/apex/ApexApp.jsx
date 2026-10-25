import { useRef, useEffect, useState, useCallback, useLayoutEffect } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useSportsConfig } from '../context/SportsConfigContext.jsx'
import apexBody from './ApexStaticBody.html?raw'
import { ApiConfigBanner } from './ApiConfigBanner.jsx'
import { apiUrl } from './apiConfig.js'
import {
  captureFlySourcesFromSlide,
  clearAnalyzeButtonSportGlow,
  playCarouselPickAnimation,
  playFlyToAnalyzeFromCaptured,
  prefersReducedMotion,
} from './apexAnalyzePickAnimation.js'
import {
  appendGameOverOverlay,
  isOddsEventFinished,
  isOddsEventPastCommence,
} from './apexOddsEventFinished.js'
import {
  applyAnalyzeButtonEnabledState,
  clearCommenceIsoOnRoot,
  readCommenceMsFromRoot,
  setCommenceIsoOnRoot,
  startPreGameCountdownTicker,
  syncPreGameAnalyzeUi,
} from './analyzeScheduleLock.js'
import { setupPlayerPropsCarousel } from './PlayerPropsCarousel.js'
import { setupQuickGamesCarousel } from './apexQuickGamesCarousel.js'
import { hidePickedGameStrip, showPickedGameStrip } from './apexPickedGameStrip.js'
import { loadEspnTeamLogos, resolveTeamLogoUrl } from './espnTeamLogos.js'
import { mountApexBetCards, mountApexBetCardsInto, stripBetCardsBlockAndParse } from './apexBetCards.js'
import { refreshAnalyzePropLadderPanel } from './analyzePropLadderPanel.js'
import { postChatStream } from './chatStreamClient.js'
import {
  formatUserFacingError,
  formatStopReasonForUi,
  humanizeOddsScheduleError,
} from './humanReadableError.js'
import { createPastGame, loadPastGame, subscribePastGames, updatePastGameBetCards } from './pastGamesService.js'
import '../styles/apex-app.css'
import './ApexApp.css'
import './PlayerPropsCarousel.css'
import './apexPickedGameStrip.css'
import './analyzeScheduleLock.css'
import { applySportAvailabilityToRoot } from './apexSportAvailability.js'

const APEX_SIDEBAR_COLLAPSED_KEY = 'apex-sidebar-collapsed'
const APEX_THEME_KEY = 'apex-theme'
const APEX_LINE_REASONING_LS_KEY = 'apex-line-reasoning-mode'
const APEX_MLB_BETTING_SCOPE_LS_KEY = 'apex-mlb-betting-scope'

function readStoredLineReasoningMode() {
  if (typeof window === 'undefined') return 'compact'
  try {
    const v = localStorage.getItem(APEX_LINE_REASONING_LS_KEY)
    if (v === 'compact' || v === 'mid' || v === 'full') return v
  } catch {
    /* ignore */
  }
  return 'compact'
}

function readStoredMlbBettingScope() {
  if (typeof window === 'undefined') return 'player_props'
  try {
    const v = localStorage.getItem(APEX_MLB_BETTING_SCOPE_LS_KEY)
    if (v === 'full_board' || v === 'player_props') return v
  } catch {
    /* ignore */
  }
  return 'player_props'
}

/** Labels for the analyze-page stream header + loading overlay (matches Line reasoning control). */
function formatLineReasoningModeUi(mode) {
  const m = String(mode || 'compact').toLowerCase()
  if (m === 'full') {
    return {
      title: 'Full',
      badge: 'Full · max reasoning · most tokens',
      hint: 'Deepest SLCM pass',
    }
  }
  if (m === 'mid') {
    return {
      title: 'Balanced',
      badge: 'Balanced · depth & tokens',
      hint: 'Balanced speed vs depth',
    }
  }
  return {
    title: 'Compact',
    badge: 'Compact · fast · compressed',
    hint: 'Lightest token use',
  }
}

/**
 * Stream header + loading copy when MLB player-prop mode vs full-board line-reasoning modes.
 * @param {'compact' | 'mid' | 'full'} lineMode
 * @param {'full_board' | 'player_props'} mlbScope
 * @param {boolean} isMlb
 */
function formatAnalyzeStreamUi(lineMode, mlbScope, isMlb) {
  if (!isMlb || mlbScope === 'full_board') {
    const lr = formatLineReasoningModeUi(lineMode)
    return {
      streamKicker: 'Line reasoning',
      badge: lr.badge,
      loadingLabel: 'Line reasoning',
      loadingMode: lr.title,
      loadingHint: lr.hint,
    }
  }
  return {
    streamKicker: 'Player props',
    badge: 'MLB · player props only · no ML / sides / totals',
    loadingLabel: 'Analyzer scope',
    loadingMode: 'Player props mandate',
    loadingHint: 'Bet cards must list individual player props only',
  }
}

/** Claude may return `content` as a string or Anthropic-style block array — normalize for parsing. */
function assistantMessageContentToString(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
}

const APEX_ANALYZE_SESSION_KEY = 'apex_analyze_session_v1'

function normalizeMessagesForPersist(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((m) => ({
    role: m.role,
    content:
      m.role === 'assistant'
        ? assistantMessageContentToString(m.content)
        : typeof m.content === 'string'
          ? m.content
          : String(m.content ?? ''),
  }))
}

function readAnalyzeSessionSnapshot() {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(APEX_ANALYZE_SESSION_KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || o.v !== 1 || !Array.isArray(o.messages) || o.messages.length === 0) return null
    return o
  } catch {
    return null
  }
}

function writeAnalyzeSessionSnapshot(payload) {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(APEX_ANALYZE_SESSION_KEY, JSON.stringify(payload))
    }
  } catch (e) {
    console.warn('apex analyze session persist', e)
  }
}

function clearAnalyzeSessionSnapshot() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(APEX_ANALYZE_SESSION_KEY)
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   messages: unknown,
 *   betCards: unknown,
 *   game: Record<string, unknown>,
 *   activePastGameId: string | null | undefined,
 * }} snap
 */
function persistAnalyzeSessionSnapshot(root, { messages, betCards, game, activePastGameId }) {
  const analyzedAtLabel =
    root.querySelector('#apex-analyze-page-analyzed-at')?.textContent?.trim() || ''
  writeAnalyzeSessionSnapshot({
    v: 1,
    messages: normalizeMessagesForPersist(messages),
    betCards: betCards ?? null,
    game: game && typeof game === 'object' ? game : {},
    analyzedAtLabel,
    activePastGameId: activePastGameId ?? null,
  })
}

/** Header controls: icon-only (no text). */
const ICON_THEME_SUN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
const ICON_THEME_MOON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
const ICON_SIGN_OUT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'

function readStoredTheme() {
  if (typeof window === 'undefined') return 'light'
  try {
    const s = localStorage.getItem(APEX_THEME_KEY)
    if (s === 'dark' || s === 'light') return s
  } catch {
    /* ignore */
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function topPageFromPathname(pathname) {
  const p = String(pathname || '/apex').toLowerCase()
  if (p === '/today') return 'today'
  if (p === '/mygames') return 'mygames'
  return 'analyze'
}

function resolveTeamLogoAnySport(logoMaps, teamName) {
  if (!logoMaps || !teamName) return null
  const sports = ['icehockey_nhl', 'basketball_nba', 'americanfootball_nfl', 'baseball_mlb']
  for (const sport of sports) {
    const url = resolveTeamLogoUrl(logoMaps, sport, teamName)
    if (url) return url
  }
  return null
}

/** Prefer league from saved analysis so e.g. "Toronto" → Blue Jays (MLB), not Maple Leafs (NHL). */
function resolveTeamLogoForSavedGame(logoMaps, sportKey, teamName) {
  if (!logoMaps || !teamName) return null
  if (typeof sportKey === 'string' && sportKey && logoMaps[sportKey]) {
    const u = resolveTeamLogoUrl(logoMaps, sportKey, teamName)
    if (u) return u
  }
  return resolveTeamLogoAnySport(logoMaps, teamName)
}

/** @param {Record<string, unknown>} data */
function sportKeyFromPastGameData(data) {
  if (typeof data.sportKey === 'string' && data.sportKey.trim()) return data.sportKey.trim()
  const g = data.game
  if (g && typeof g === 'object' && typeof /** @type {Record<string, unknown>} */ (g).sportKey === 'string') {
    const sk = /** @type {Record<string, unknown>} */ (g).sportKey
    return typeof sk === 'string' && sk.trim() ? sk.trim() : null
  }
  return null
}

const SPORT_KEY_TO_LEAGUE_LABEL = {
  americanfootball_nfl: 'NFL',
  basketball_nba: 'NBA',
  baseball_mlb: 'MLB',
  icehockey_nhl: 'NHL',
}

/** @param {string | null | undefined} sk */
function leagueLabelFromSportKey(sk) {
  if (typeof sk === 'string' && SPORT_KEY_TO_LEAGUE_LABEL[sk]) return SPORT_KEY_TO_LEAGUE_LABEL[sk]
  return '—'
}

/**
 * Center column: same semantics as carousel (day + `at time`).
 * @param {string} gameDateStr
 * @param {string} gameTimeStr
 */
function midDayTimeForPastGameCard(gameDateStr, gameTimeStr) {
  const raw = typeof gameDateStr === 'string' ? gameDateStr.trim() : ''
  const gt = typeof gameTimeStr === 'string' ? gameTimeStr.trim() : ''
  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) {
    const ft = formatDayTime(d.toISOString())
    const timeLine = gt ? `at ${gt}` : ft.time ? `at ${ft.time}` : ''
    return { day: ft.day, timeLine: timeLine || '—' }
  }
  return { day: raw || '—', timeLine: gt ? `at ${gt}` : '—' }
}

/**
 * @param {string} teamName
 * @returns {{ col: HTMLDivElement, logoWrap: HTMLDivElement, img: HTMLImageElement, fallback: HTMLSpanElement }}
 */
function buildPastGameQgTeamColumn(teamName) {
  const col = document.createElement('div')
  col.className = 'apex-qg-team'
  const logoWrap = document.createElement('div')
  logoWrap.className = 'apex-qg-logo'
  logoWrap.setAttribute('aria-hidden', 'true')
  const img = document.createElement('img')
  img.className = 'apex-qg-logo-img'
  img.alt = ''
  img.width = 44
  img.height = 44
  img.loading = 'lazy'
  img.decoding = 'async'
  img.hidden = true
  const fallback = document.createElement('span')
  fallback.textContent = teamAbbr(teamName).slice(0, 1).toUpperCase()
  logoWrap.appendChild(img)
  logoWrap.appendChild(fallback)
  const nameEl = document.createElement('span')
  nameEl.className = 'apex-qg-team-name'
  nameEl.textContent = teamName
  nameEl.title = teamName
  col.appendChild(logoWrap)
  col.appendChild(nameEl)
  return { col, logoWrap, img, fallback }
}

const TODAY_SCHEDULE_CACHE_KEY = 'apex_today_schedule_v4'
const TODAY_SCHEDULE_TTL_MS = 30 * 60 * 1000
let todayScheduleMemoryCache = null

function teamAbbr(name) {
  if (!name || typeof name !== 'string') return '—'
  const words = name
    .replace(/\./g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return '—'
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  if (words.length === 2) return (words[0][0] + words[1][0] + (words[1][1] || '')).toUpperCase().slice(0, 3)
  return (words[0][0] + words[1][0] + words[2][0]).toUpperCase().slice(0, 3)
}

/**
 * Today page: include games whose commence date falls in the next N local calendar days
 * starting from today (N=2 → today and tomorrow). All sports use the same window.
 * @param {string} iso
 * @param {number} numCalendarDays - e.g. 2 for today + tomorrow
 */
function isCommenceWithinLocalCalendarDayWindow(iso, numCalendarDays) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  const n = Math.max(1, Math.min(14, Math.floor(Number(numCalendarDays)) || 1))
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayOffset = Math.round((eventDay - startOfToday) / (86400 * 1000))
  return dayOffset >= 0 && dayOffset < n
}

/** Today section: show games for today and tomorrow (two local calendar days). */
const TODAY_SECTION_CALENDAR_DAY_SPAN = 2

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
  return { day, time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }
}

function readTodayScheduleCache() {
  if (todayScheduleMemoryCache && Date.now() - todayScheduleMemoryCache.fetchedAt < TODAY_SCHEDULE_TTL_MS) {
    if (todayScheduleMemoryCache.complete === true) return todayScheduleMemoryCache.events
    todayScheduleMemoryCache = null
  }
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(TODAY_SCHEDULE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.fetchedAt !== 'number' ||
      !Array.isArray(parsed.events) ||
      parsed.complete !== true ||
      Date.now() - parsed.fetchedAt > TODAY_SCHEDULE_TTL_MS
    ) {
      return null
    }
    todayScheduleMemoryCache = {
      fetchedAt: parsed.fetchedAt,
      events: parsed.events,
      complete: true,
    }
    return parsed.events
  } catch {
    return null
  }
}

/**
 * Only persist when the Odds API returned a full merge (no per-league errors).
 * Partial responses used to be cached and differed per device/session, so MLB could
 * appear on one browser and NHL on another until TTL expired.
 */
function writeTodayScheduleCache(events, { complete = true } = {}) {
  if (!complete) return
  const payload = { fetchedAt: Date.now(), events, complete: true }
  todayScheduleMemoryCache = payload
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(TODAY_SCHEDULE_CACHE_KEY, JSON.stringify(payload))
  } catch {
    /* ignore */
  }
}

/** While streaming, show only the tail so the panel stays readable (full text on complete). */
const STREAM_LIVE_TAIL_CHARS = 5600

function formatLiveStreamText(full) {
  if (full.length <= STREAM_LIVE_TAIL_CHARS) return full
  return `… (earlier lines hidden until complete)\n\n${full.slice(-STREAM_LIVE_TAIL_CHARS)}`
}

/** @param {import('@firebase/firestore').Timestamp | { toDate?: () => Date } | undefined} ts */
function formatAnalyzedTimestamp(ts) {
  if (!ts) return ''
  try {
    const d = typeof ts.toDate === 'function' ? ts.toDate() : null
    const date = d && !Number.isNaN(d.getTime()) ? d : null
    if (!date) return ''
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ''
  }
}

/** Firestore row or admin session row (`analyzedAtMs`). */
function formatAnalyzedAtFromPastGameData(data) {
  if (!data || typeof data !== 'object') return ''
  const o = /** @type {Record<string, unknown>} */ (data)
  if (typeof o.analyzedAtMs === 'number') {
    const d = new Date(o.analyzedAtMs)
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    }
  }
  return formatAnalyzedTimestamp(
    /** @type {import('@firebase/firestore').Timestamp | undefined} */ (o.analyzedAt),
  )
}

const ADMIN_SESSION_ID_PREFIX = 'apex-admin-'

/**
 * @param {object} game
 * @param {unknown} betCards
 * @returns {{ id: string, data: Record<string, unknown> }}
 */
function buildAdminSessionPastGameRow(game, betCards) {
  const id = `${ADMIN_SESSION_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const g = game && typeof game === 'object' ? game : {}
  const homeTeam = typeof g.homeTeam === 'string' ? g.homeTeam : ''
  const awayTeam = typeof g.awayTeam === 'string' ? g.awayTeam : ''
  const gameDate = typeof g.date === 'string' ? g.date : ''
  const gameTime = typeof g.gameTime === 'string' ? g.gameTime : ''
  const sportKey = typeof g.sportKey === 'string' ? g.sportKey : ''
  return {
    id,
    data: {
      userId: '__admin_session__',
      homeTeam,
      awayTeam,
      gameDate,
      gameTime,
      sportKey,
      game: g,
      betCards,
      analyzedAtMs: Date.now(),
    },
  }
}

/** @param {Record<string, unknown>} d */
function analyzedAtMsForPastGameSort(d) {
  if (typeof d?.analyzedAtMs === 'number') return d.analyzedAtMs
  const ts = d?.analyzedAt
  if (ts && typeof ts.toDate === 'function') {
    const t = ts.toDate()
    return t && !Number.isNaN(t.getTime()) ? t.getTime() : 0
  }
  return 0
}

/** @param {HTMLElement} root */
function clearPastGameCardSelection(root) {
  root.querySelectorAll('.past-game-card--open').forEach((el) => el.classList.remove('past-game-card--open'))
}

/** @param {HTMLElement} parent */
function appendAltLineTag(parent) {
  const tag = document.createElement('span')
  tag.className = 'apex-bet-card-line-tag'
  tag.setAttribute('title', 'Alternative line (not the book’s default main number)')
  tag.textContent = 'Alt line'
  parent.appendChild(tag)
}

/**
 * Quick reasoning rows: actual pick(s) above narrative reasoning (from `quickReasoning`).
 * @param {HTMLElement | null} bodyEl
 * @param {object | null | undefined} cards - normalized bet cards from `stripBetCardsBlockAndParse`
 */
function fillAnalyzeQuickReasoning(bodyEl, cards) {
  if (!bodyEl) return
  bodyEl.replaceChildren()
  if (!cards) return
  const qr = cards.quickReasoning
  const ls = cards.lineSource
  const rows = [
    {
      title: 'Single leg lock',
      betText: cards.singleLegLock || '—',
      lineKind: ls?.singleLegLock === 'alt' ? 'alt' : 'main',
      reasonText: qr?.singleLegLock || '—',
      legs: null,
    },
    {
      title: '2-leg parlay',
      betText: '',
      reasonText: qr?.twoLegParlay || '—',
      legs: Array.isArray(cards.twoLegParlay) ? cards.twoLegParlay : [],
      legKinds: ls?.twoLegParlay,
    },
    {
      title: '3-leg parlay',
      betText: '',
      reasonText: qr?.threeLegParlay || '—',
      legs: Array.isArray(cards.threeLegParlay) ? cards.threeLegParlay : [],
      legKinds: ls?.threeLegParlay,
    },
  ]
  for (const row of rows) {
    const item = document.createElement('div')
    item.className = 'apex-analyze-page-reason-item'
    const ttl = document.createElement('div')
    ttl.className = 'apex-analyze-page-reason-item-title'
    ttl.textContent = row.title
    const bet = document.createElement('div')
    bet.className = 'apex-analyze-page-reason-item-bet'
    if (row.legs) {
      if (row.legs.length === 0) {
        bet.textContent = '—'
      } else {
        const ul = document.createElement('ul')
        ul.className = 'apex-analyze-page-reason-item-bet-legs'
        row.legs.forEach((leg, i) => {
          const li = document.createElement('li')
          const kind = Array.isArray(row.legKinds) ? row.legKinds[i] : 'main'
          if (kind === 'alt') appendAltLineTag(li)
          const legText = document.createElement('span')
          legText.className = 'apex-analyze-page-reason-item-bet-leg-text'
          legText.textContent = leg
          li.appendChild(legText)
          ul.appendChild(li)
        })
        bet.appendChild(ul)
      }
    } else {
      if (row.lineKind === 'alt') appendAltLineTag(bet)
      const pick = document.createElement('span')
      pick.className = 'apex-analyze-page-reason-item-bet-pick'
      pick.textContent = row.betText
      bet.appendChild(pick)
    }
    const body = document.createElement('div')
    body.className = 'apex-analyze-page-reason-item-body'
    body.textContent = row.reasonText
    item.appendChild(ttl)
    item.appendChild(bet)
    item.appendChild(body)
    bodyEl.appendChild(item)
  }
}

/**
 * @param {HTMLElement} root
 * @param {Array<{ id: string, data: Record<string, unknown> }>} rows
 * @param {string | null | undefined} uid
 */
function renderPastGamesList(root, rows, uid) {
  const list = root.querySelector('#past-games-list')
  const hint = root.querySelector('#past-games-hint')
  if (!list || !hint) return
  if (!uid) {
    hint.textContent = 'Sign in with Google to save analyses and reopen them here.'
    list.replaceChildren()
    return
  }
  if (rows.length === 0) {
    hint.textContent =
      uid === '__admin_session__'
        ? 'No games in this session yet. Run Analyze on a matchup to save bets here.'
        : 'No saved games yet. Run Analyze on a matchup to save bets here.'
    list.replaceChildren()
    return
  }
  hint.textContent =
    uid === '__admin_session__'
      ? 'Session-only — games clear when you refresh. Sign in with Google to save permanently.'
      : 'Tap a saved game to view the recommended bets that were saved for that analysis.'
  list.replaceChildren()
  /** @type {Array<{ awayImg: HTMLImageElement, awayLogoWrap: HTMLDivElement, awayFallback: HTMLSpanElement, awayTeam: string, homeImg: HTMLImageElement, homeLogoWrap: HTMLDivElement, homeFallback: HTMLSpanElement, homeTeam: string, sportKey: string | null }>} */
  const logoJobs = []
  for (const { id, data } of rows) {
    const rowData = /** @type {Record<string, unknown>} */ (data)
    const away = typeof data.awayTeam === 'string' ? data.awayTeam : 'Away'
    const home = typeof data.homeTeam === 'string' ? data.homeTeam : 'Home'
    const gameDate = typeof data.gameDate === 'string' ? data.gameDate : '—'
    const gameTimeRaw = typeof data.gameTime === 'string' ? data.gameTime : ''
    const saved = formatAnalyzedAtFromPastGameData(
      /** @type {Record<string, unknown>} */ (data),
    )
    const savedSportKey = sportKeyFromPastGameData(rowData)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'past-game-card apex-qg-slide'
    btn.dataset.id = id
    if (savedSportKey) {
      btn.dataset.sportKey = savedSportKey
      btn.dataset.sport = savedSportKey
    }
    if (saved) btn.dataset.analyzedAtText = saved

    const league = document.createElement('span')
    league.className = 'apex-qg-league'
    league.textContent = leagueLabelFromSportKey(savedSportKey)

    const awayCol = buildPastGameQgTeamColumn(away)
    const homeCol = buildPastGameQgTeamColumn(home)

    const { day: midDay, timeLine: midTime } = midDayTimeForPastGameCard(gameDate, gameTimeRaw)
    const mid = document.createElement('div')
    mid.className = 'apex-qg-mid'
    const dayEl = document.createElement('span')
    dayEl.className = 'apex-qg-day'
    dayEl.textContent = midDay
    const timEl = document.createElement('span')
    timEl.className = 'apex-qg-time'
    timEl.textContent = midTime
    mid.appendChild(dayEl)
    mid.appendChild(timEl)
    if (saved) {
      const an = document.createElement('span')
      an.className = 'past-game-card__analyzed'
      an.textContent = `Analyzed ${saved}`
      mid.appendChild(an)
    }

    btn.appendChild(league)
    btn.appendChild(awayCol.col)
    btn.appendChild(mid)
    btn.appendChild(homeCol.col)
    list.appendChild(btn)
    logoJobs.push({
      awayImg: awayCol.img,
      awayLogoWrap: awayCol.logoWrap,
      awayFallback: awayCol.fallback,
      awayTeam: away,
      homeImg: homeCol.img,
      homeLogoWrap: homeCol.logoWrap,
      homeFallback: homeCol.fallback,
      homeTeam: home,
      sportKey: savedSportKey,
    })
  }
  void loadEspnTeamLogos()
    .then((maps) => {
      for (const job of logoJobs) {
        const awayUrl = resolveTeamLogoForSavedGame(maps, job.sportKey, job.awayTeam)
        const homeUrl = resolveTeamLogoForSavedGame(maps, job.sportKey, job.homeTeam)
        if (awayUrl) {
          job.awayImg.src = awayUrl
          job.awayImg.hidden = false
          job.awayFallback.hidden = true
          job.awayLogoWrap.classList.add('apex-qg-logo--img')
        }
        if (homeUrl) {
          job.homeImg.src = homeUrl
          job.homeImg.hidden = false
          job.homeFallback.hidden = true
          job.homeLogoWrap.classList.add('apex-qg-logo--img')
        }
      }
    })
    .catch(() => {
      /* keep initials fallback */
    })
}

function setPrmSubTab(root, which) {
  const chatPane = root.querySelector('#prm-pane-chat')
  const pastPane = root.querySelector('#prm-pane-past')
  const subChat = root.querySelector('#prm-sub-chat')
  const subPast = root.querySelector('#prm-sub-past')
  if (which === 'chat') {
    chatPane?.classList.add('on')
    pastPane?.classList.remove('on')
    subChat?.classList.add('on')
    subPast?.classList.remove('on')
  } else {
    chatPane?.classList.remove('on')
    pastPane?.classList.add('on')
    subPast?.classList.add('on')
    subChat?.classList.remove('on')
  }
}

function val(root, id) {
  return root?.querySelector(`#${id}`)?.value?.trim() ?? ''
}

export function ApexApp() {
  const wrapRef = useRef(null)
  const threadRef = useRef(null)
  /** Last selected line-reasoning mode (MLB); sent with analyze + follow-up. */
  const apexPromptModeRef = useRef(readStoredLineReasoningMode())
  /** Firestore `pastGames` doc id for the current thread (set after a new ANALYZE save / follow-ups). */
  const activePastGameIdRef = useRef(null)
  /** MLB-only: `full_board` (moneyline + props, etc.) vs `player_props` (exclusivity mandate prompt). */
  const apexMlbBettingScopeRef = useRef(readStoredMlbBettingScope())
  const pastGameClickGenRef = useRef(0)
  const analyzerDoneToastTimerRef = useRef(0)
  const [thread, setThread] = useState(null)
  const [colorMode, setColorMode] = useState(readStoredTheme)
  const { adminDevSession, signOutUser, user } = useAuth()
  const { disabledSportKeys } = useSportsConfig()
  /** In-memory only; cleared on full page refresh. Used when admin dev session has no Google uid. */
  const adminSessionPastGamesRef = useRef(/** @type {Array<{ id: string, data: Record<string, unknown> }>} */ ([]))
  const lastFirestorePastRowsRef = useRef(/** @type {Array<{ id: string, data: Record<string, unknown> }>} */ ([]))

  threadRef.current = thread

  useLayoutEffect(() => {
    try {
      localStorage.setItem(APEX_THEME_KEY, colorMode)
    } catch {
      /* ignore */
    }
  }, [colorMode])

  useEffect(() => {
    const root = wrapRef.current
    if (!root) return
    const btn = root.querySelector('.apex-theme-toggle')
    if (!btn) return
    const isDark = colorMode === 'dark'
    btn.innerHTML = isDark ? ICON_THEME_SUN : ICON_THEME_MOON
    btn.setAttribute(
      'aria-label',
      isDark ? 'Switch to light mode' : 'Switch to dark mode',
    )
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false')
  }, [colorMode])

  /** Chat is no longer persisted across reloads; clear legacy keys from the old localStorage session. */
  useEffect(() => {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k && k.startsWith('apex_chat_session_v1_')) localStorage.removeItem(k)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const sn = useCallback((msg) => {
    const n = wrapRef.current?.querySelector('#notif')
    if (!n) return
    n.textContent = msg || '✓ COPIED TO CLIPBOARD'
    n.classList.add('show')
    setTimeout(() => n.classList.remove('show'), 2500)
  }, [])

  const showAnalyzerDoneToast = useCallback(() => {
    const el = document.getElementById('apex-analyzer-toast')
    if (!el) return
    el.textContent = 'Analyzer done'
    el.classList.add('show')
    if (analyzerDoneToastTimerRef.current) {
      window.clearTimeout(analyzerDoneToastTimerRef.current)
    }
    analyzerDoneToastTimerRef.current = window.setTimeout(() => {
      el.classList.remove('show')
      analyzerDoneToastTimerRef.current = 0
    }, 4000)
  }, [])

  const renderChat = useCallback(() => {
    const root = wrapRef.current
    if (!root) return
    const chatLog = root.querySelector('#chat-log')
    if (!chatLog) return
    const t = threadRef.current
    chatLog.innerHTML = ''
    if (!t || t.length === 0) {
      mountApexBetCards(root, null)
      chatLog.innerHTML =
        '<div class="chat-placeholder" id="chat-placeholder">Run Analyze to generate the full APEX breakdown. Then ask questions about that game here.</div>'
      const chatIn = root.querySelector('#chat-input')
      const sendBtn = root.querySelector('#sendbtn')
      if (chatIn) chatIn.disabled = true
      if (sendBtn) sendBtn.disabled = true
      return
    }
    for (const m of t) {
      const d = document.createElement('div')
      d.className = `chat-msg ${m.role === 'user' ? 'u' : 'a'}`
      const lab = document.createElement('div')
      lab.className = 'who'
      lab.textContent = m.role === 'user' ? 'You' : 'Claude'
      const body = document.createElement('div')
      body.textContent = m.content
      d.appendChild(lab)
      d.appendChild(body)
      chatLog.appendChild(d)
    }
    const chatIn = root.querySelector('#chat-input')
    const sendBtn = root.querySelector('#sendbtn')
    if (chatIn) chatIn.disabled = false
    if (sendBtn) sendBtn.disabled = false
    chatLog.scrollTop = chatLog.scrollHeight
  }, [])

  useEffect(() => {
    const root = wrapRef.current
    if (!root) return
    /** Without this, use a missing-template check so React Strict Mode remount reinjects after teardown. */
    if (!root.querySelector('#chat-log')) {
      root.innerHTML = apexBody
    }

    const hdr = root.querySelector('.hdr')
    /** Template is only reinjected when #chat-log is missing; strip legacy header badges so updates apply. */
    if (hdr) {
      hdr
        .querySelectorAll('.tag, .ver, .slcm-badge, .dual-badge')
        .forEach((el) => el.remove())
      hdr.querySelectorAll('.apex-theme-toggle-wrap, .apex-signout-wrap').forEach((el) => el.remove())
    }

    const hdrActions = root.querySelector('#apex-hdr-actions')
    if (hdrActions && !hdrActions.querySelector('.apex-theme-toggle-wrap')) {
      const twrap = document.createElement('span')
      twrap.className = 'apex-theme-toggle-wrap'
      const tbtn = document.createElement('button')
      tbtn.type = 'button'
      tbtn.className = 'apex-theme-toggle'
      const dark = colorMode === 'dark'
      tbtn.innerHTML = dark ? ICON_THEME_SUN : ICON_THEME_MOON
      tbtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode')
      tbtn.setAttribute('aria-pressed', dark ? 'true' : 'false')
      tbtn.addEventListener('click', () => {
        setColorMode((m) => (m === 'dark' ? 'light' : 'dark'))
      })
      twrap.appendChild(tbtn)
      hdrActions.appendChild(twrap)
    }

    if (hdrActions && !hdrActions.querySelector('.apex-signout-wrap')) {
      const wrap = document.createElement('span')
      wrap.className = 'apex-signout-wrap'
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'apex-btn-signout'
      btn.innerHTML = ICON_SIGN_OUT
      btn.setAttribute('aria-label', 'Sign out')
      btn.setAttribute('title', 'Sign out')
      btn.addEventListener('click', () => signOutUser())
      wrap.appendChild(btn)
      hdrActions.appendChild(wrap)
    }

    const syncSidebarAria = () => {
      const toggle = root.querySelector('#apex-sidebar-toggle')
      const collapsed = root.classList.contains('apex-sidebar-collapsed')
      toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      toggle?.setAttribute('title', collapsed ? 'Expand navigation' : 'Collapse navigation')
      toggle?.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation')
      const scrim = root.querySelector('#apex-sidebar-scrim')
      scrim?.setAttribute('aria-hidden', collapsed ? 'true' : 'false')
    }

    try {
      const stored = localStorage.getItem(APEX_SIDEBAR_COLLAPSED_KEY)
      if (stored === '1') root.classList.add('apex-sidebar-collapsed')
      else if (
        stored === null &&
        typeof window !== 'undefined' &&
        window.matchMedia('(max-width: 768px)').matches
      ) {
        root.classList.add('apex-sidebar-collapsed')
      }
    } catch {
      /* ignore */
    }
    syncSidebarAria()

    const onSidebarToggle = () => {
      root.classList.toggle('apex-sidebar-collapsed')
      try {
        localStorage.setItem(
          APEX_SIDEBAR_COLLAPSED_KEY,
          root.classList.contains('apex-sidebar-collapsed') ? '1' : '0',
        )
      } catch {
        /* ignore */
      }
      syncSidebarAria()
    }

    const sidebarToggle = root.querySelector('#apex-sidebar-toggle')
    const sidebarScrim = root.querySelector('#apex-sidebar-scrim')
    sidebarToggle?.addEventListener('click', onSidebarToggle)
    const onScrimClick = () => {
      if (!root.classList.contains('apex-sidebar-collapsed')) {
        root.classList.add('apex-sidebar-collapsed')
        try {
          localStorage.setItem(APEX_SIDEBAR_COLLAPSED_KEY, '1')
        } catch {
          /* ignore */
        }
        syncSidebarAria()
      }
    }
    sidebarScrim?.addEventListener('click', onScrimClick)

    const onTab = (e) => {
      const t = e.currentTarget
      root.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'))
      root.querySelectorAll('.tc').forEach((x) => x.classList.remove('on'))
      t.classList.add('on')
      const pane = root.querySelector(`#${t.dataset.t}`)
      if (pane) pane.classList.add('on')
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
        root.classList.add('apex-sidebar-collapsed')
        try {
          localStorage.setItem(APEX_SIDEBAR_COLLAPSED_KEY, '1')
        } catch {
          /* ignore */
        }
        syncSidebarAria()
      }
    }
    root.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', onTab)
    })

    function mergeAdminSessionPastRows(firestoreRows) {
      if (!adminDevSession || user?.uid) return firestoreRows
      const session = adminSessionPastGamesRef.current
      const merged = [...session, ...firestoreRows]
      merged.sort(
        (a, b) =>
          analyzedAtMsForPastGameSort(/** @type {Record<string, unknown>} */ (b.data)) -
          analyzedAtMsForPastGameSort(/** @type {Record<string, unknown>} */ (a.data)),
      )
      return merged
    }

    const unsubPastGames = subscribePastGames(user?.uid ?? '', (rows) => {
      lastFirestorePastRowsRef.current = rows
      const merged = mergeAdminSessionPastRows(rows)
      const listUid = adminDevSession && !user?.uid ? '__admin_session__' : user?.uid
      renderPastGamesList(root, merged, listUid)
    })

    const subChatBtn = root.querySelector('#prm-sub-chat')
    const subPastBtn = root.querySelector('#prm-sub-past')
    const onSubChat = () => setPrmSubTab(root, 'chat')
    const onSubPast = () => setPrmSubTab(root, 'past')
    subChatBtn?.addEventListener('click', onSubChat)
    subPastBtn?.addEventListener('click', onSubPast)

    const pastGamesListEl = root.querySelector('#past-games-list')
    async function onPastGameCardClick(e) {
      const t = e.target
      if (!(t instanceof Element)) return
      const btn = t.closest('.past-game-card')
      if (!btn || !btn.dataset?.id) return
      const id = btn.dataset.id
      try {
        /** @type {{ betCards: unknown, game?: object } | null} */
        let loaded = null
        if (id.startsWith(ADMIN_SESSION_ID_PREFIX)) {
          if (!adminDevSession) return
          const row = adminSessionPastGamesRef.current.find((r) => r.id === id)
          if (!row?.data?.betCards) {
            sn('Could not load that saved game.')
            return
          }
          loaded = {
            betCards: row.data.betCards,
            game: row.data.game && typeof row.data.game === 'object' ? row.data.game : {},
          }
        } else {
          const uid = user?.uid
          if (!uid) return
          loaded = await loadPastGame(id, uid)
          if (!loaded?.betCards) {
            sn('Could not load that saved game.')
            return
          }
        }
        clearPastGameCardSelection(root)
        btn.classList.add('past-game-card--open')
        btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        navigateTopRoute('mygames')
        const analyzePage = root.querySelector('#apex-analyze-page')
        const analyzeBack = root.querySelector('#apex-analyze-page-back')
        const analyzeAwayName = root.querySelector('#apex-analyze-page-away-name')
        const analyzeHomeName = root.querySelector('#apex-analyze-page-home-name')
        const analyzeAwayLogo = root.querySelector('#apex-analyze-page-away-logo')
        const analyzeAwayLogoFallback = root.querySelector('#apex-analyze-page-away-logo-fallback')
        const analyzeHomeLogo = root.querySelector('#apex-analyze-page-home-logo')
        const analyzeHomeLogoFallback = root.querySelector('#apex-analyze-page-home-logo-fallback')
        const analyzeWhen = root.querySelector('#apex-analyze-page-when')
        const analyzeTime = root.querySelector('#apex-analyze-page-time')
        const analyzeAnalyzedAt = root.querySelector('#apex-analyze-page-analyzed-at')
        const analyzeLiveWrap = root.querySelector('#apex-analyze-page-live')
        const analyzeBets = root.querySelector('#apex-analyze-page-bets')
        const analyzeReason = root.querySelector('#apex-analyze-page-reason')
        const analyzeReasonBody = root.querySelector('#apex-analyze-page-reason-body')
        const g = loaded.game && typeof loaded.game === 'object' ? loaded.game : {}
        const home = typeof g.homeTeam === 'string' ? g.homeTeam : 'Home'
        const away = typeof g.awayTeam === 'string' ? g.awayTeam : 'Away'
        const gameDate = typeof g.date === 'string' ? g.date : '—'
        const gameTime = typeof g.gameTime === 'string' && g.gameTime ? g.gameTime : 'Time TBD'
        if (analyzeAwayName) analyzeAwayName.textContent = away
        if (analyzeHomeName) analyzeHomeName.textContent = home
        if (analyzeWhen) analyzeWhen.textContent = gameDate
        if (analyzeTime) analyzeTime.textContent = gameTime
        const analyzedTxt = btn.dataset?.analyzedAtText
        if (analyzeAnalyzedAt) analyzeAnalyzedAt.textContent = analyzedTxt ? `Analyzed at ${analyzedTxt}` : 'Analyzed'
        if (analyzeAwayLogoFallback) {
          analyzeAwayLogoFallback.textContent = (away?.trim()?.[0] || 'A').toUpperCase()
          analyzeAwayLogoFallback.hidden = false
        }
        if (analyzeHomeLogoFallback) {
          analyzeHomeLogoFallback.textContent = (home?.trim()?.[0] || 'H').toUpperCase()
          analyzeHomeLogoFallback.hidden = false
        }
        if (analyzeAwayLogo) analyzeAwayLogo.hidden = true
        if (analyzeHomeLogo) analyzeHomeLogo.hidden = true
        const sportKeyFromCard = typeof btn.dataset?.sportKey === 'string' ? btn.dataset.sportKey : null
        void loadEspnTeamLogos().then((maps) => {
          const awayLogoUrl = sportKeyFromCard
            ? resolveTeamLogoUrl(maps, sportKeyFromCard, away) || resolveTeamLogoAnySport(maps, away)
            : resolveTeamLogoAnySport(maps, away)
          const homeLogoUrl = sportKeyFromCard
            ? resolveTeamLogoUrl(maps, sportKeyFromCard, home) || resolveTeamLogoAnySport(maps, home)
            : resolveTeamLogoAnySport(maps, home)
          if (analyzeAwayLogo && awayLogoUrl) {
            analyzeAwayLogo.src = awayLogoUrl
            analyzeAwayLogo.alt = `${away} logo`
            analyzeAwayLogo.hidden = false
            if (analyzeAwayLogoFallback) analyzeAwayLogoFallback.hidden = true
          }
          if (analyzeHomeLogo && homeLogoUrl) {
            analyzeHomeLogo.src = homeLogoUrl
            analyzeHomeLogo.alt = `${home} logo`
            analyzeHomeLogo.hidden = false
            if (analyzeHomeLogoFallback) analyzeHomeLogoFallback.hidden = true
          }
        })
        if (analyzePage) analyzePage.hidden = false
        attachAnalyzeBackButton()
        if (analyzeLiveWrap) analyzeLiveWrap.hidden = true
        const streamHeadPast = root.querySelector('#apex-analyze-stream-head')
        if (streamHeadPast) streamHeadPast.hidden = true
        if (analyzeBets) {
          mountApexBetCardsInto(analyzeBets, loaded.betCards)
          analyzeBets.hidden = !loaded.betCards
        }
        if (analyzeReason && analyzeReasonBody) {
          fillAnalyzeQuickReasoning(analyzeReasonBody, loaded.betCards)
          analyzeReason.hidden = !loaded.betCards
        }
        void refreshAnalyzePropLadderPanel(root, { game: g, cards: loaded.betCards })
      } catch (err) {
        console.error(err)
        sn('Could not load saved game.')
      }
    }
    pastGamesListEl?.addEventListener('click', onPastGameCardClick)

    const appendError = (msg) => {
      const chatLog = root.querySelector('#chat-log')
      if (!chatLog) return
      const d = document.createElement('div')
      d.className = 'chat-msg a err'
      d.textContent = typeof msg === 'string' ? msg : formatUserFacingError(msg)
      chatLog.appendChild(d)
      chatLog.scrollTop = chatLog.scrollHeight
    }

    function setBusy(b) {
      const abtn = root.querySelector('#abtn')
      const chatIn = root.querySelector('#chat-input')
      const sendBtn = root.querySelector('#sendbtn')
      if (abtn) {
        if (b) abtn.disabled = true
        else applyAnalyzeButtonEnabledState(root)
      }
      if (chatIn) chatIn.disabled = b || !threadRef.current
      if (sendBtn) sendBtn.disabled = b || !threadRef.current
    }

    const applyTopRoute = (page) => {
      root.classList.remove('apex-route-analyze', 'apex-route-mygames', 'apex-route-today')
      const route = page === 'mygames' || page === 'today' ? page : 'analyze'
      root.classList.add(`apex-route-${route}`)
      root.querySelectorAll('.apex-top-nav-link').forEach((el) => {
        const isOn = el.getAttribute('data-page') === route
        el.classList.toggle('on', isOn)
      })
      if (route === 'mygames') setPrmSubTab(root, 'past')
    }

    const navigateTopRoute = (page, replace = false) => {
      const route = page === 'mygames' || page === 'today' ? page : 'analyze'
      const pathname = route === 'analyze' ? '/apex' : `/${route}`
      if (typeof window !== 'undefined') {
        const op = replace ? 'replaceState' : 'pushState'
        window.history[op]({}, '', pathname)
      }
      applyTopRoute(route)
    }

    const attachAnalyzeBackButton = () => {
      const analyzePage = root.querySelector('#apex-analyze-page')
      const analyzeBack = root.querySelector('#apex-analyze-page-back')
      if (analyzeBack) {
        analyzeBack.onclick = () => {
          clearAnalyzeSessionSnapshot()
          setThread(null)
          void refreshAnalyzePropLadderPanel(root, { game: {}, cards: null })
          if (analyzePage) analyzePage.hidden = true
        }
      }
    }

    const VALID_ANALYZE_SPORT_KEYS = new Set([
      'baseball_mlb',
      'icehockey_nhl',
      'basketball_nba',
      'americanfootball_nfl',
    ])

    const restoreAnalyzeSessionFromSnapshotIfAny = () => {
      const snap = readAnalyzeSessionSnapshot()
      if (!snap?.messages?.length) return false
      navigateTopRoute('analyze', true)
      const analyzePage = root.querySelector('#apex-analyze-page')
      const analyzeAwayName = root.querySelector('#apex-analyze-page-away-name')
      const analyzeHomeName = root.querySelector('#apex-analyze-page-home-name')
      const analyzeAwayLogo = root.querySelector('#apex-analyze-page-away-logo')
      const analyzeAwayLogoFallback = root.querySelector('#apex-analyze-page-away-logo-fallback')
      const analyzeHomeLogo = root.querySelector('#apex-analyze-page-home-logo')
      const analyzeHomeLogoFallback = root.querySelector('#apex-analyze-page-home-logo-fallback')
      const analyzeWhen = root.querySelector('#apex-analyze-page-when')
      const analyzeTime = root.querySelector('#apex-analyze-page-time')
      const analyzeAnalyzedAt = root.querySelector('#apex-analyze-page-analyzed-at')
      const analyzeLiveWrap = root.querySelector('#apex-analyze-page-live')
      const analyzeBets = root.querySelector('#apex-analyze-page-bets')
      const analyzeReason = root.querySelector('#apex-analyze-page-reason')
      const analyzeReasonBody = root.querySelector('#apex-analyze-page-reason-body')
      const streamHeadPast = root.querySelector('#apex-analyze-stream-head')
      const g = snap.game && typeof snap.game === 'object' ? snap.game : {}
      const home = typeof g.homeTeam === 'string' ? g.homeTeam : 'Home'
      const away = typeof g.awayTeam === 'string' ? g.awayTeam : 'Away'
      const gameDate = typeof g.date === 'string' ? g.date : '—'
      const gameTime = typeof g.gameTime === 'string' && g.gameTime ? g.gameTime : 'Time TBD'
      if (analyzeAwayName) analyzeAwayName.textContent = away
      if (analyzeHomeName) analyzeHomeName.textContent = home
      if (analyzeWhen) analyzeWhen.textContent = gameDate
      if (analyzeTime) analyzeTime.textContent = gameTime
      if (analyzeAnalyzedAt) {
        analyzeAnalyzedAt.textContent =
          snap.analyzedAtLabel && String(snap.analyzedAtLabel).trim()
            ? String(snap.analyzedAtLabel).trim()
            : 'Analyzed'
      }
      if (analyzeAwayLogoFallback) {
        analyzeAwayLogoFallback.textContent = (away?.trim()?.[0] || 'A').toUpperCase()
        analyzeAwayLogoFallback.hidden = false
      }
      if (analyzeHomeLogoFallback) {
        analyzeHomeLogoFallback.textContent = (home?.trim()?.[0] || 'H').toUpperCase()
        analyzeHomeLogoFallback.hidden = false
      }
      if (analyzeAwayLogo) analyzeAwayLogo.hidden = true
      if (analyzeHomeLogo) analyzeHomeLogo.hidden = true
      const sportKeyFromGame =
        typeof g.sportKey === 'string' && VALID_ANALYZE_SPORT_KEYS.has(g.sportKey) ? g.sportKey : null
      void loadEspnTeamLogos().then((maps) => {
        const awayLogoUrl = sportKeyFromGame
          ? resolveTeamLogoUrl(maps, sportKeyFromGame, away) || resolveTeamLogoAnySport(maps, away)
          : resolveTeamLogoAnySport(maps, away)
        const homeLogoUrl = sportKeyFromGame
          ? resolveTeamLogoUrl(maps, sportKeyFromGame, home) || resolveTeamLogoAnySport(maps, home)
          : resolveTeamLogoAnySport(maps, home)
        if (analyzeAwayLogo && awayLogoUrl) {
          analyzeAwayLogo.src = awayLogoUrl
          analyzeAwayLogo.alt = `${away} logo`
          analyzeAwayLogo.hidden = false
          if (analyzeAwayLogoFallback) analyzeAwayLogoFallback.hidden = true
        }
        if (analyzeHomeLogo && homeLogoUrl) {
          analyzeHomeLogo.src = homeLogoUrl
          analyzeHomeLogo.alt = `${home} logo`
          analyzeHomeLogo.hidden = false
          if (analyzeHomeLogoFallback) analyzeHomeLogoFallback.hidden = true
        }
      })
      if (analyzeLiveWrap) analyzeLiveWrap.hidden = true
      if (streamHeadPast) streamHeadPast.hidden = true
      if (analyzeBets) {
        mountApexBetCardsInto(analyzeBets, snap.betCards)
        analyzeBets.hidden = !snap.betCards
      }
      if (analyzeReason && analyzeReasonBody) {
        fillAnalyzeQuickReasoning(analyzeReasonBody, snap.betCards)
        analyzeReason.hidden = !snap.betCards
      }
      void refreshAnalyzePropLadderPanel(root, { game: g, cards: snap.betCards })
      if (analyzePage) analyzePage.hidden = false
      activePastGameIdRef.current =
        typeof snap.activePastGameId === 'string' ? snap.activePastGameId : null
      setThread(snap.messages)
      attachAnalyzeBackButton()
      return true
    }

    function readAnalyzeSportKey() {
      const sel = root.querySelector('#apex-analyze-sport')
      const v = sel?.value?.trim() ?? ''
      if (v && VALID_ANALYZE_SPORT_KEYS.has(v)) return v
      return 'baseball_mlb'
    }

    const closeLineReasoningPopover = () => {
      const pop = root.querySelector('#apex-line-reasoning-popover')
      const b = root.querySelector('#apex-line-reasoning-btn')
      if (pop) pop.hidden = true
      if (b) b.setAttribute('aria-expanded', 'false')
    }

    const closeMlbScopePopover = () => {
      const pop = root.querySelector('#apex-mlb-scope-popover')
      const b = root.querySelector('#apex-mlb-scope-btn')
      if (pop) pop.hidden = true
      if (b) b.setAttribute('aria-expanded', 'false')
    }

    const syncLineReasoningButtonLabel = () => {
      const btn = root.querySelector('#apex-line-reasoning-btn')
      if (!(btn instanceof HTMLElement)) return
      const isMlb = readAnalyzeSportKey() === 'baseball_mlb'
      const mlbScope = isMlb ? apexMlbBettingScopeRef.current : 'full_board'
      const lineReasoningOk = isMlb && mlbScope === 'full_board'
      if (!lineReasoningOk) {
        btn.textContent = 'Line reasoning'
        return
      }
      const mode = readSelectedLineReasoningMode()
      const { title } = formatLineReasoningModeUi(mode)
      btn.textContent = `${title} - reasoning`
    }

    const syncLineReasoningMlbDisabled = () => {
      const isMlb = readAnalyzeSportKey() === 'baseball_mlb'
      const mlbScope = isMlb ? apexMlbBettingScopeRef.current : 'full_board'
      const lineReasoningOk = isMlb && mlbScope === 'full_board'
      const wrap = root.querySelector('#apex-line-reasoning')
      const btn = root.querySelector('#apex-line-reasoning-btn')
      const popover = root.querySelector('#apex-line-reasoning-popover')
      if (wrap) wrap.classList.toggle('apex-line-reasoning--disabled', !lineReasoningOk)
      if (btn) {
        btn.disabled = !lineReasoningOk
        if (lineReasoningOk) {
          btn.title = ''
        } else if (!isMlb) {
          btn.title = 'Line reasoning (compact / balanced / full) is available for MLB only.'
        } else {
          btn.title =
            'Line reasoning depth applies to Full board only. Player props mode uses a dedicated analyzer prompt.'
        }
      }
      if (!lineReasoningOk && popover) popover.hidden = true
      if (btn && !lineReasoningOk) btn.setAttribute('aria-expanded', 'false')
      if (!isMlb) closeMlbScopePopover()
      syncLineReasoningButtonLabel()
      syncMlbBettingScopeUi()
    }

    const applyMlbScopeRadios = () => {
      const scope = apexMlbBettingScopeRef.current
      root.querySelectorAll('input[name="apex-mlb-betting-scope"]').forEach((r) => {
        if (r instanceof HTMLInputElement) r.checked = r.value === scope
      })
    }

    const readSelectedMlbBettingScope = () => {
      const sel = root.querySelector('input[name="apex-mlb-betting-scope"]:checked')
      const v = sel instanceof HTMLInputElement ? sel.value : ''
      if (v === 'full_board' || v === 'player_props') return v
      return apexMlbBettingScopeRef.current
    }

    const syncMlbScopeButtonLabel = () => {
      const btn = root.querySelector('#apex-mlb-scope-btn')
      if (!(btn instanceof HTMLElement)) return
      btn.textContent = 'Line type'
    }

    const syncMlbBettingScopeUi = () => {
      const wrap = root.querySelector('#apex-mlb-scope')
      const btn = root.querySelector('#apex-mlb-scope-btn')
      const popover = root.querySelector('#apex-mlb-scope-popover')
      const isMlb = readAnalyzeSportKey() === 'baseball_mlb'
      if (wrap) {
        wrap.hidden = false
        wrap.classList.toggle('apex-line-reasoning--disabled', !isMlb)
      }
      if (btn instanceof HTMLButtonElement) {
        btn.disabled = !isMlb
        btn.title = isMlb
          ? ''
          : 'Line type (full board vs player props) is available when Sport is set to MLB.'
      }
      if (!isMlb && popover) popover.hidden = true
      if (btn && !isMlb) btn.setAttribute('aria-expanded', 'false')
      if (isMlb) applyMlbScopeRadios()
      syncMlbScopeButtonLabel()
    }

    const onMlbScopeRadioChange = (e) => {
      const t = e.target
      if (!(t instanceof HTMLInputElement) || t.name !== 'apex-mlb-betting-scope') return
      if (t.value === 'full_board' || t.value === 'player_props') {
        apexMlbBettingScopeRef.current = t.value
        try {
          localStorage.setItem(APEX_MLB_BETTING_SCOPE_LS_KEY, t.value)
        } catch {
          /* ignore */
        }
      }
      closeMlbScopePopover()
      syncLineReasoningMlbDisabled()
    }

    const onMlbScopeMenuBtnClick = (e) => {
      e.stopPropagation()
      const mlbBtn = root.querySelector('#apex-mlb-scope-btn')
      const mlbPopover = root.querySelector('#apex-mlb-scope-popover')
      if (!mlbBtn || mlbBtn.disabled || !mlbPopover) return
      closeLineReasoningPopover()
      mlbPopover.hidden = !mlbPopover.hidden
      mlbBtn.setAttribute('aria-expanded', String(!mlbPopover.hidden))
    }

    const applyLineReasoningRadios = () => {
      const mode = apexPromptModeRef.current
      root.querySelectorAll('input[name="apex-line-reasoning"]').forEach((r) => {
        if (r instanceof HTMLInputElement) r.checked = r.value === mode
      })
    }

    const readSelectedLineReasoningMode = () => {
      const sel = root.querySelector('input[name="apex-line-reasoning"]:checked')
      const v = sel instanceof HTMLInputElement ? sel.value : ''
      if (v === 'compact' || v === 'mid' || v === 'full') return v
      return apexPromptModeRef.current
    }

    const onLineReasoningRadioChange = (e) => {
      const t = e.target
      if (!(t instanceof HTMLInputElement) || t.name !== 'apex-line-reasoning') return
      if (t.value === 'compact' || t.value === 'mid' || t.value === 'full') {
        apexPromptModeRef.current = t.value
        try {
          localStorage.setItem(APEX_LINE_REASONING_LS_KEY, t.value)
        } catch {
          /* ignore */
        }
      }
      syncLineReasoningButtonLabel()
      closeLineReasoningPopover()
    }

    const onLineReasoningDocPointerDown = (e) => {
      const lrWrap = root.querySelector('#apex-line-reasoning')
      const mlbWrap = root.querySelector('#apex-mlb-scope')
      if (!(e.target instanceof Node)) return
      if (lrWrap?.contains(e.target)) return
      if (mlbWrap?.contains(e.target)) return
      closeLineReasoningPopover()
      closeMlbScopePopover()
    }

    const onLineReasoningBtnClick = (e) => {
      e.stopPropagation()
      const lrBtn = root.querySelector('#apex-line-reasoning-btn')
      const lrPopover = root.querySelector('#apex-line-reasoning-popover')
      if (!lrBtn || lrBtn.disabled || !lrPopover) return
      closeMlbScopePopover()
      lrPopover.hidden = !lrPopover.hidden
      lrBtn.setAttribute('aria-expanded', String(!lrPopover.hidden))
    }

    applyLineReasoningRadios()
    syncLineReasoningMlbDisabled()
    root.querySelectorAll('input[name="apex-line-reasoning"]').forEach((el) => {
      el.addEventListener('change', onLineReasoningRadioChange)
    })
    const lineReasoningBtn = root.querySelector('#apex-line-reasoning-btn')
    lineReasoningBtn?.addEventListener('click', onLineReasoningBtnClick)
    document.addEventListener('pointerdown', onLineReasoningDocPointerDown, true)

    const analyzeSportForLineReasoning = root.querySelector('#apex-analyze-sport')
    analyzeSportForLineReasoning?.addEventListener('change', syncLineReasoningMlbDisabled)
    root.querySelectorAll('input[name="apex-mlb-betting-scope"]').forEach((el) => {
      el.addEventListener('change', onMlbScopeRadioChange)
    })
    const mlbScopeBtn = root.querySelector('#apex-mlb-scope-btn')
    mlbScopeBtn?.addEventListener('click', onMlbScopeMenuBtnClick)

    async function go() {
      const h = val(root, 'f1')
      const a = val(root, 'f2')
      const d = val(root, 'f3')
      const btn = root.querySelector('#abtn')
      if (!h || !a || !d) {
        if (btn) {
          btn.style.background = 'rgba(232,60,60,0.4)'
          btn.style.color = '#e83c3c'
          setTimeout(() => {
            btn.style.background = ''
            btn.style.color = ''
          }, 800)
        }
        return
      }
      const commenceMsEarly = readCommenceMsFromRoot(root)
      if (commenceMsEarly != null && Date.now() >= commenceMsEarly) {
        sn('Game already started — pre-game analysis is locked. Live betting may be offered separately.')
        return
      }
      navigateTopRoute('mygames')
      activePastGameIdRef.current = null
      clearAnalyzeSessionSnapshot()
      setThread(null)
      mountApexBetCards(root, null)
      const analyzePage = root.querySelector('#apex-analyze-page')
      const analyzeAwayName = root.querySelector('#apex-analyze-page-away-name')
      const analyzeHomeName = root.querySelector('#apex-analyze-page-home-name')
      const analyzeAwayLogo = root.querySelector('#apex-analyze-page-away-logo')
      const analyzeAwayLogoFallback = root.querySelector('#apex-analyze-page-away-logo-fallback')
      const analyzeHomeLogo = root.querySelector('#apex-analyze-page-home-logo')
      const analyzeHomeLogoFallback = root.querySelector('#apex-analyze-page-home-logo-fallback')
      const analyzeWhen = root.querySelector('#apex-analyze-page-when')
      const analyzeTime = root.querySelector('#apex-analyze-page-time')
      const analyzeAnalyzedAt = root.querySelector('#apex-analyze-page-analyzed-at')
      const analyzeStatus = root.querySelector('#apex-analyze-page-status')
      const analyzePre = root.querySelector('#apex-analyze-page-pre')
      const analyzeLiveWrap = root.querySelector('#apex-analyze-page-live')
      const analyzeLoadingText = root.querySelector('#apex-analyze-loading-text')
      const analyzeStreamHead = root.querySelector('#apex-analyze-stream-head')
      const analyzeModeBadge = root.querySelector('#apex-analyze-mode-badge')
      const analyzeLoadingMode = root.querySelector('#apex-analyze-loading-mode')
      const analyzeLoadingModeHint = root.querySelector('#apex-analyze-loading-mode-hint')
      const analyzeBets = root.querySelector('#apex-analyze-page-bets')
      const analyzeReason = root.querySelector('#apex-analyze-page-reason')
      const analyzeReasonBody = root.querySelector('#apex-analyze-page-reason-body')
      if (analyzeBets) mountApexBetCardsInto(analyzeBets, null)
      void refreshAnalyzePropLadderPanel(root, { game: {}, cards: null })
      if (analyzePage) analyzePage.hidden = false
      if (analyzeLiveWrap) analyzeLiveWrap.hidden = false
      analyzeLiveWrap?.classList.add('is-processing')
      if (analyzeBets) analyzeBets.hidden = true
      if (analyzeReason) analyzeReason.hidden = true
      if (analyzeAwayName) analyzeAwayName.textContent = a
      if (analyzeHomeName) analyzeHomeName.textContent = h
      if (analyzeAwayLogoFallback) analyzeAwayLogoFallback.textContent = (a?.trim()?.[0] || 'A').toUpperCase()
      if (analyzeHomeLogoFallback) analyzeHomeLogoFallback.textContent = (h?.trim()?.[0] || 'H').toUpperCase()
      if (analyzeAwayLogoFallback) analyzeAwayLogoFallback.hidden = false
      if (analyzeHomeLogoFallback) analyzeHomeLogoFallback.hidden = false
      if (analyzeAwayLogo) analyzeAwayLogo.hidden = true
      if (analyzeHomeLogo) analyzeHomeLogo.hidden = true
      if (analyzeWhen) analyzeWhen.textContent = d
      if (analyzeTime) analyzeTime.textContent = val(root, 'f4') || 'Time TBD'
      if (analyzeAnalyzedAt) {
        analyzeAnalyzedAt.textContent = `Analyzed at ${new Date().toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}`
      }
      const inferredSportKey = readAnalyzeSportKey()
      void loadEspnTeamLogos()
        .then((maps) => {
          const awayLogoUrl = inferredSportKey
            ? resolveTeamLogoUrl(maps, inferredSportKey, a) || resolveTeamLogoAnySport(maps, a)
            : resolveTeamLogoAnySport(maps, a)
          const homeLogoUrl = inferredSportKey
            ? resolveTeamLogoUrl(maps, inferredSportKey, h) || resolveTeamLogoAnySport(maps, h)
            : resolveTeamLogoAnySport(maps, h)
          if (analyzeAwayLogo && awayLogoUrl) {
            analyzeAwayLogo.src = awayLogoUrl
            analyzeAwayLogo.alt = `${a} logo`
            analyzeAwayLogo.hidden = false
            if (analyzeAwayLogoFallback) analyzeAwayLogoFallback.hidden = true
          }
          if (analyzeHomeLogo && homeLogoUrl) {
            analyzeHomeLogo.src = homeLogoUrl
            analyzeHomeLogo.alt = `${h} logo`
            analyzeHomeLogo.hidden = false
            if (analyzeHomeLogoFallback) analyzeHomeLogoFallback.hidden = true
          }
        })
        .catch(() => {
          /* keep fallback initials */
        })
      if (analyzeStatus) analyzeStatus.textContent = 'Connecting…'
      if (analyzePre) analyzePre.textContent = ''
      attachAnalyzeBackButton()
      const chatLog = root.querySelector('#chat-log')
      if (chatLog) chatLog.innerHTML = ''
      const statusEl = analyzeStatus
      const liveEl = analyzePre
      let liveText = ''
      const loadingPhrases = [
        'Please wait — your bets are being created…',
        'Thinking through lines and matchup edges…',
        'Weighing odds and building your parlay legs…',
        'Hang tight — SLCM is finishing the run…',
        'Almost there — locking in your bet cards…',
      ]
      let loadingPhraseIdx = 0
      let loadingPhraseTimer = 0
      const startLoadingOverlay = () => {
        if (analyzeLoadingText) analyzeLoadingText.textContent = loadingPhrases[0]
        loadingPhraseTimer = window.setInterval(() => {
          loadingPhraseIdx = (loadingPhraseIdx + 1) % loadingPhrases.length
          if (analyzeLoadingText) analyzeLoadingText.textContent = loadingPhrases[loadingPhraseIdx]
        }, 2400)
      }
      const stopLoadingOverlay = () => {
        if (loadingPhraseTimer) {
          window.clearInterval(loadingPhraseTimer)
          loadingPhraseTimer = 0
        }
        analyzeLiveWrap?.classList.remove('is-processing')
      }
      apexPromptModeRef.current = readSelectedLineReasoningMode()
      apexMlbBettingScopeRef.current = readSelectedMlbBettingScope()
      const analyzeSportKey = readAnalyzeSportKey()
      const isMlbAnalyze = analyzeSportKey === 'baseball_mlb'
      const streamUi = formatAnalyzeStreamUi(apexPromptModeRef.current, apexMlbBettingScopeRef.current, isMlbAnalyze)
      const analyzeStreamKicker = root.querySelector('#apex-analyze-stream-head-kicker')
      const analyzeLoadingModeLabel = root.querySelector('#apex-analyze-loading-mode-label')
      if (analyzeStreamKicker) analyzeStreamKicker.textContent = streamUi.streamKicker
      if (analyzeStreamHead) analyzeStreamHead.hidden = false
      if (analyzeModeBadge) analyzeModeBadge.textContent = streamUi.badge
      if (analyzeLoadingModeLabel) analyzeLoadingModeLabel.textContent = streamUi.loadingLabel
      if (analyzeLoadingMode) analyzeLoadingMode.textContent = streamUi.loadingMode
      if (analyzeLoadingModeHint) analyzeLoadingModeHint.textContent = streamUi.loadingHint
      startLoadingOverlay()

      if (btn) {
        btn.dataset.analyzing = '1'
        btn.disabled = true
        const label = btn.textContent
        btn.textContent = '… Analyzing'
        analyzePage?.scrollIntoView({ behavior: 'auto', block: 'start' })
        const chatIn = root.querySelector('#chat-input')
        if (chatIn) {
          chatIn.value = ''
          chatIn.disabled = true
        }
        const sendBtn = root.querySelector('#sendbtn')
        if (sendBtn) sendBtn.disabled = true

        try {
          const oddsEventId = val(root, 'apex-odds-event-id')
          const commenceIso = val(root, 'apex-odds-commence-iso')?.trim() || ''
          const gamePayload = {
            game: {
              homeTeam: h,
              awayTeam: a,
              date: d,
              gameTime: val(root, 'f4') || undefined,
              stadium: val(root, 'f5') || undefined,
              homeStarter: val(root, 'f6') || undefined,
              awayStarter: val(root, 'f7') || undefined,
              bankroll: val(root, 'f8') || undefined,
              mlOdds: val(root, 'f10') || undefined,
              totalOu: val(root, 'f11') || undefined,
              context: val(root, 'f9') || undefined,
              sportKey: inferredSportKey,
              ...(oddsEventId ? { oddsEventId } : {}),
              ...(commenceIso ? { commenceTimeIso: commenceIso } : {}),
            },
            apexPromptMode: apexPromptModeRef.current,
            apexMlbBettingScope: apexMlbBettingScopeRef.current,
          }
          const data = await postChatStream(gamePayload, {
            onEvent(ev) {
              if (ev.type === 'start' && statusEl) {
                statusEl.textContent = ev.webSearch ? 'Claude · web search enabled' : 'Claude'
              }
              if (ev.type === 'activity' && statusEl) {
                statusEl.textContent = ev.detail || ev.phase || '…'
              }
              if (ev.type === 'text_delta' && ev.text && liveEl) {
                liveText += ev.text
                liveEl.textContent = formatLiveStreamText(liveText)
                liveEl.scrollTop = liveEl.scrollHeight
                chatLog && (chatLog.scrollTop = chatLog.scrollHeight)
              }
              if (ev.type === 'stop_reason' && ev.stop_reason && statusEl) {
                statusEl.textContent = formatStopReasonForUi(ev.stop_reason)
              }
            },
          })
          let messagesOut = data.messages || null
          let betCardsForSave = null

          stopLoadingOverlay()
          if (analyzePre) analyzePre.textContent = ''
          if (analyzeLiveWrap) analyzeLiveWrap.hidden = true
          if (analyzeStreamHead) analyzeStreamHead.hidden = true

          if (Array.isArray(messagesOut) && messagesOut.length > 0) {
            const last = messagesOut[messagesOut.length - 1]
            if (last.role === 'assistant') {
              const contentStr = assistantMessageContentToString(last.content)
              const { stripped, cards } = stripBetCardsBlockAndParse(contentStr)
              messagesOut = [...messagesOut.slice(0, -1), { ...last, content: stripped }]
              betCardsForSave = cards
              if (analyzeBets) {
                mountApexBetCardsInto(analyzeBets, cards)
                analyzeBets.hidden = !cards
              }
              if (analyzeReason && analyzeReasonBody) {
                fillAnalyzeQuickReasoning(analyzeReasonBody, cards)
                analyzeReason.hidden = !cards
              }
              void refreshAnalyzePropLadderPanel(root, { game: gamePayload.game, cards })
            }
          } else {
            mountApexBetCards(root, null)
            void refreshAnalyzePropLadderPanel(root, { game: gamePayload.game, cards: null })
          }
          setThread(messagesOut)
          if (user?.uid && betCardsForSave) {
            try {
              const id = await createPastGame(user.uid, {
                game: gamePayload.game,
                betCards: betCardsForSave,
              })
              activePastGameIdRef.current = id
            } catch (err) {
              console.error('pastGames save:', err)
              sn('Analysis complete, but could not save to your account. Check Firestore rules and try again.')
            }
          } else if (adminDevSession && !user?.uid && betCardsForSave) {
            const row = buildAdminSessionPastGameRow(gamePayload.game, betCardsForSave)
            adminSessionPastGamesRef.current = [row, ...adminSessionPastGamesRef.current].slice(0, 50)
            activePastGameIdRef.current = row.id
            const merged = mergeAdminSessionPastRows(lastFirestorePastRowsRef.current)
            renderPastGamesList(root, merged, '__admin_session__')
          }
          if (Array.isArray(messagesOut) && messagesOut.length > 0) {
            persistAnalyzeSessionSnapshot(root, {
              messages: messagesOut,
              betCards: betCardsForSave,
              game: gamePayload.game,
              activePastGameId: activePastGameIdRef.current,
            })
          }
          if (data?.stop_reason === 'max_tokens') {
            sn('Output hit max length — answers are condensed by default; raise ANTHROPIC_MAX_TOKENS if you need more.')
          }
          showAnalyzerDoneToast()
        } catch (e) {
          stopLoadingOverlay()
          activePastGameIdRef.current = null
          clearAnalyzeSessionSnapshot()
          setThread(null)
          mountApexBetCards(root, null)
          if (chatLog) chatLog.innerHTML = ''
          appendError(formatUserFacingError(e))
        } finally {
          stopLoadingOverlay()
          btn.removeAttribute('data-analyzing')
          btn.textContent = label
          syncPreGameAnalyzeUi(root)
        }
      }
    }

    async function sendFollowUp() {
      const chatIn = root.querySelector('#chat-input')
      const text = chatIn?.value?.trim() ?? ''
      if (!text || !threadRef.current) return
      const next = [...threadRef.current, { role: 'user', content: text }]
      if (chatIn) chatIn.value = ''
      setBusy(true)
      const chatLog = root.querySelector('#chat-log')
      const streamWrap = document.createElement('div')
      streamWrap.className = 'apex-stream-wrap'
      streamWrap.id = 'apex-chat-stream'
      streamWrap.innerHTML =
        '<div class="apex-stream-status">Follow-up…</div><p class="apex-stream-hint">Latest part of the stream — full reply replaces this when done.</p><pre class="apex-stream-live" aria-live="polite"></pre>'
      chatLog?.appendChild(streamWrap)
      const statusEl = streamWrap.querySelector('.apex-stream-status')
      const liveEl = streamWrap.querySelector('.apex-stream-live')
      let liveText = ''
      chatLog && (chatLog.scrollTop = chatLog.scrollHeight)

      try {
        const data = await postChatStream(
          {
            messages: next,
            sportKey: readAnalyzeSportKey(),
            apexPromptMode: apexPromptModeRef.current,
            apexMlbBettingScope: apexMlbBettingScopeRef.current,
          },
          {
          onEvent(ev) {
            if (ev.type === 'start' && statusEl) {
              statusEl.textContent = ev.webSearch ? 'Claude · web search' : 'Claude'
            }
            if (ev.type === 'activity' && statusEl) {
              statusEl.textContent = ev.detail || ev.phase || '…'
            }
            if (ev.type === 'text_delta' && ev.text && liveEl) {
              liveText += ev.text
              liveEl.textContent = formatLiveStreamText(liveText)
              liveEl.scrollTop = liveEl.scrollHeight
              chatLog && (chatLog.scrollTop = chatLog.scrollHeight)
            }
            if (ev.type === 'stop_reason' && ev.stop_reason && statusEl) {
              statusEl.textContent = formatStopReasonForUi(ev.stop_reason)
            }
          },
        })
        streamWrap.remove()
        let messagesOut = data.messages || threadRef.current
        let betCardsMaybe = null
        if (Array.isArray(messagesOut) && messagesOut.length > 0) {
          const last = messagesOut[messagesOut.length - 1]
          if (last.role === 'assistant') {
            const contentStr = assistantMessageContentToString(last.content)
            const { stripped, cards } = stripBetCardsBlockAndParse(contentStr)
            messagesOut = [...messagesOut.slice(0, -1), { ...last, content: stripped }]
            betCardsMaybe = cards
          }
        }
        setThread(messagesOut)
        const prevSnap = readAnalyzeSessionSnapshot()
        if (prevSnap && Array.isArray(messagesOut) && messagesOut.length > 0) {
          persistAnalyzeSessionSnapshot(root, {
            messages: messagesOut,
            betCards: betCardsMaybe != null ? betCardsMaybe : prevSnap.betCards,
            game: prevSnap.game && typeof prevSnap.game === 'object' ? prevSnap.game : {},
            activePastGameId: activePastGameIdRef.current,
          })
        }
        if (betCardsMaybe && prevSnap?.game && typeof prevSnap.game === 'object') {
          void refreshAnalyzePropLadderPanel(root, { game: prevSnap.game, cards: betCardsMaybe })
        }
        const uid = user?.uid
        const docId = activePastGameIdRef.current
        if (uid && docId && betCardsMaybe) {
          try {
            await updatePastGameBetCards(uid, docId, betCardsMaybe)
          } catch (err) {
            console.error('pastGames update:', err)
            sn('Could not update saved game — your reply is still in chat.')
          }
        } else if (
          !uid &&
          adminDevSession &&
          docId &&
          docId.startsWith(ADMIN_SESSION_ID_PREFIX) &&
          betCardsMaybe
        ) {
          const idx = adminSessionPastGamesRef.current.findIndex((r) => r.id === docId)
          if (idx !== -1) {
            const prev = adminSessionPastGamesRef.current[idx]
            adminSessionPastGamesRef.current[idx] = {
              ...prev,
              data: { ...prev.data, betCards: betCardsMaybe },
            }
            const merged = mergeAdminSessionPastRows(lastFirestorePastRowsRef.current)
            renderPastGamesList(root, merged, '__admin_session__')
          }
        }
        if (data?.stop_reason === 'max_tokens') {
          sn('Output hit max length — try a shorter question or raise ANTHROPIC_MAX_TOKENS.')
        }
      } catch (e) {
        streamWrap.remove()
        appendError(formatUserFacingError(e))
      } finally {
        setBusy(false)
      }
    }

    function copyChat() {
      const t = threadRef.current
      if (!t || t.length === 0) {
        sn('Nothing to copy yet')
        return
      }
      const text = t.map((m) => `[${m.role}]\n${m.content}`).join('\n\n---\n\n')
      navigator.clipboard.writeText(text).then(
        () => sn('✓ COPIED CHAT'),
        () => {
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
          sn('✓ COPIED CHAT')
        },
      )
    }

    const advToggle = root.querySelector('#apex-game-input-advanced-toggle')
    const advPanel = root.querySelector('#apex-game-input-advanced')
    const onAdvToggle = () => {
      if (!advPanel || !advToggle) return
      const open = advToggle.getAttribute('aria-expanded') === 'true'
      if (open) {
        advPanel.setAttribute('hidden', '')
        advToggle.setAttribute('aria-expanded', 'false')
      } else {
        advPanel.removeAttribute('hidden')
        advToggle.setAttribute('aria-expanded', 'true')
      }
    }
    advToggle?.addEventListener('click', onAdvToggle)

    /** The Odds API — team search → upcoming matchups (quota-free events endpoint). */
    const searchInput = root.querySelector('#apex-team-search')
    const sportSel = root.querySelector('#apex-odds-sport')
    const resultsEl = root.querySelector('#apex-team-search-results')
    const searchPh = root.querySelector('.apex-team-search-ph')

    let oddsDebounceId = 0
    let oddsAbort = null

    const clearOddsDebounce = () => {
      if (oddsDebounceId) window.clearTimeout(oddsDebounceId)
      oddsDebounceId = 0
    }

    const hideOddsResults = () => {
      if (!resultsEl) return
      resultsEl.hidden = true
      resultsEl.replaceChildren()
      searchInput?.setAttribute('aria-expanded', 'false')
    }

    const applyOddsEvent = (ev) => {
      if (isOddsEventFinished(ev)) {
        sn('Game over')
        return
      }
      if (isOddsEventPastCommence(ev)) {
        sn('Game already started — pre-game analysis is locked')
        return
      }
      const oddsEventIdEl = root.querySelector('#apex-odds-event-id')
      if (oddsEventIdEl instanceof HTMLInputElement) {
        oddsEventIdEl.value = typeof ev.id === 'string' ? ev.id : ''
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
      const analyzeSportSel = root.querySelector('#apex-analyze-sport')
      if (
        analyzeSportSel instanceof HTMLSelectElement &&
        typeof ev?.sport_key === 'string' &&
        VALID_ANALYZE_SPORT_KEYS.has(ev.sport_key)
      ) {
        analyzeSportSel.value = ev.sport_key
      }
      syncLineReasoningMlbDisabled()
      if (searchInput) searchInput.value = ''
      hideOddsResults()
      void showPickedGameStrip(root, {
        awayTeam: typeof ev.away_team === 'string' ? ev.away_team : '',
        homeTeam: typeof ev.home_team === 'string' ? ev.home_team : '',
        sportKey: typeof ev.sport_key === 'string' ? ev.sport_key : 'baseball_mlb',
      })
      sn('Matchup filled from schedule')
    }


    const onAnalyzeFillEvent = (e) => {
      const sportKey = e?.detail?.sportKey
      const analyzeSportSel = root.querySelector('#apex-analyze-sport')
      if (
        analyzeSportSel instanceof HTMLSelectElement &&
        typeof sportKey === 'string' &&
        VALID_ANALYZE_SPORT_KEYS.has(sportKey)
      ) {
        analyzeSportSel.value = sportKey
      }
      syncLineReasoningMlbDisabled()
    }
    root.addEventListener('apex:analyze-fill', onAnalyzeFillEvent)

    const onTopNavClick = (e) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const link = t.closest('.apex-top-nav-link')
      if (!link) return
      e.preventDefault()
      const page = link.getAttribute('data-page') || 'analyze'
      navigateTopRoute(page)
      if (page === 'today') {
        window.requestAnimationFrame(() => {
          void renderTodayRows()
        })
      }
    }

    const onPopState = () => {
      if (typeof window === 'undefined') return
      const page = topPageFromPathname(window.location.pathname)
      applyTopRoute(page)
      if (page === 'today') {
        window.requestAnimationFrame(() => {
          void renderTodayRows()
        })
      }
    }

    const TODAY_LAYOUT_STORAGE_KEY = 'apex_today_layout'
    const readTodayLayoutMode = () => {
      try {
        const v = localStorage.getItem(TODAY_LAYOUT_STORAGE_KEY)
        return v === 'grid' ? 'grid' : 'carousel'
      } catch {
        return 'carousel'
      }
    }

    const syncTodayLayoutUi = () => {
      const page = root.querySelector('#apex-today-page')
      if (!page) return
      const mode = readTodayLayoutMode()
      const isGrid = mode === 'grid'
      page.classList.toggle('apex-today-page--grid', isGrid)
      root.querySelector('#apex-today-toggle-carousel')?.classList.toggle('on', mode === 'carousel')
      root.querySelector('#apex-today-toggle-grid')?.classList.toggle('on', mode === 'grid')

      page.querySelectorAll('.apex-today-league').forEach((sec) => {
        const head = sec.querySelector('.apex-today-league-head')
        if (!(head instanceof HTMLElement)) return
        if (!isGrid) {
          sec.classList.remove('apex-today-league--collapsed')
          head.setAttribute('aria-expanded', 'true')
          head.setAttribute('aria-disabled', 'true')
          head.tabIndex = -1
        } else {
          head.removeAttribute('aria-disabled')
          head.tabIndex = 0
        }
      })
    }

    const onTodayLayoutClick = (e) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const btn = t.closest('[data-today-layout]')
      if (!btn) return
      const layout = btn.getAttribute('data-today-layout')
      if (layout !== 'grid' && layout !== 'carousel') return
      try {
        localStorage.setItem(TODAY_LAYOUT_STORAGE_KEY, layout)
      } catch {
        /* ignore */
      }
      void renderTodayRows()
    }

    const onTodayPageClick = (e) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const head = t.closest('.apex-today-league-head')
      if (head instanceof HTMLElement) {
        if (readTodayLayoutMode() !== 'grid') return
        const sec = head.closest('.apex-today-league')
        if (!sec) return
        const collapsed = sec.classList.toggle('apex-today-league--collapsed')
        head.setAttribute('aria-expanded', String(!collapsed))
        if (!collapsed) {
          window.requestAnimationFrame(() => {
            void renderTodayRows({ skipLoading: true })
          })
        }
        return
      }
      onTodayLayoutClick(e)
    }

    const renderTodayRows = async (opts = {}) => {
      const page = root.querySelector('#apex-today-page')
      if (!page) return
      syncTodayLayoutUi()
      const isGrid = readTodayLayoutMode() === 'grid'
      const sections = page.querySelectorAll('.apex-today-league')
      if (!sections.length) return
      const desktopSlots = 3
      const TICKER_GAP_PX = 12
      const TICKER_PX_PER_SEC = 32
      const MOBILE_TICKER_SPEED_MULTIPLIER = 2
      const MIN_TICKER_DURATION_SEC = 45

      const setEmptyCarousel = (track, viewport, msg) => {
        track.classList.remove('apex-qg-carousel-track--ticker')
        viewport.classList.remove('apex-qg-carousel-viewport--ticker')
        track.style.animation = 'none'
        track.style.width = ''
        track.style.transform = ''
        track.style.removeProperty('--apex-qg-ticker-duration')
        track.replaceChildren()
        const slide = document.createElement('div')
        slide.className = 'apex-qg-slide apex-qg-slide--empty'
        const p = document.createElement('p')
        p.className = 'apex-qg-empty-msg'
        p.textContent = msg
        slide.appendChild(p)
        track.appendChild(slide)
      }

      const setEmptyGrid = (gridEl, msg) => {
        gridEl.replaceChildren()
        const slide = document.createElement('div')
        slide.className = 'apex-qg-slide apex-qg-slide--empty'
        const p = document.createElement('p')
        p.className = 'apex-qg-empty-msg'
        p.textContent = msg
        slide.appendChild(p)
        gridEl.appendChild(slide)
      }

      function hideTodayOffSeason(sec) {
        const msg = sec.querySelector('.apex-today-offseason')
        if (msg) {
          msg.hidden = true
          msg.textContent = ''
        }
      }

      function showTodayOffSeason(sec, leagueTitle) {
        const title = typeof leagueTitle === 'string' && leagueTitle.trim() ? leagueTitle.trim() : 'This league'
        const msg = sec.querySelector('.apex-today-offseason')
        const wrap = sec.querySelector('.apex-today-carousel-wrap')
        const gridEl = sec.querySelector('[data-role="grid"]')
        const viewport = sec.querySelector('.apex-qg-carousel-viewport')
        const track = sec.querySelector('[data-role="row-track"]')
        if (msg) {
          msg.textContent = `${title} — no games scheduled for the next two days (today & tomorrow).`
          msg.hidden = false
        }
        if (wrap) wrap.hidden = true
        if (gridEl) {
          gridEl.hidden = true
          gridEl.replaceChildren()
        }
        if (track && viewport) {
          track.classList.remove('apex-qg-carousel-track--ticker')
          viewport.classList.remove('apex-qg-carousel-viewport--ticker')
          track.style.animation = 'none'
          track.style.width = ''
          track.style.transform = ''
          track.style.removeProperty('--apex-qg-ticker-duration')
          track.replaceChildren()
        }
      }

      const applySectionLayout = (sec, gridMode) => {
        const viewport = sec.querySelector('.apex-qg-carousel-viewport')
        const track = sec.querySelector('[data-role="row-track"]')
        const gridEl = sec.querySelector('[data-role="grid"]')
        const wrap = sec.querySelector('.apex-today-carousel-wrap')
        if (!(viewport instanceof HTMLElement) || !(track instanceof HTMLElement)) return false
        if (!(gridEl instanceof HTMLElement)) return false
        if (wrap instanceof HTMLElement) wrap.hidden = gridMode
        gridEl.hidden = !gridMode
        return true
      }

      if (!opts.skipLoading) {
        sections.forEach((sec) => {
          hideTodayOffSeason(sec)
          if (!applySectionLayout(sec, isGrid)) return
          const viewport = sec.querySelector('.apex-qg-carousel-viewport')
          const track = sec.querySelector('[data-role="row-track"]')
          const gridEl = sec.querySelector('[data-role="grid"]')
          if (!(viewport instanceof HTMLElement) || !(track instanceof HTMLElement)) return
          if (!(gridEl instanceof HTMLElement)) return
          if (isGrid) setEmptyGrid(gridEl, 'Loading games...')
          else setEmptyCarousel(track, viewport, 'Loading games...')
        })
      }

      const createTodayGameSlide = (ev, sport, logoMaps, sec) => {
        const slide = document.createElement('div')
        slide.className = 'apex-qg-slide'
        slide.dataset.sport = sport
        slide.tabIndex = 0
        slide.setAttribute('role', 'button')
        slide.setAttribute('aria-roledescription', 'button')

        const away = typeof ev.away_team === 'string' ? ev.away_team : 'Away'
        const home = typeof ev.home_team === 'string' ? ev.home_team : 'Home'
        const { day, time } = formatDayTime(ev.commence_time)

        const buildTeam = (name) => {
          const abbr = teamAbbr(name)
          const col = document.createElement('div')
          col.className = 'apex-qg-team'
          const logoWrap = document.createElement('div')
          logoWrap.className = 'apex-qg-logo'
          const url = resolveTeamLogoUrl(logoMaps, sport, name)
          if (url) {
            const img = document.createElement('img')
            img.className = 'apex-qg-logo-img'
            img.src = url
            img.alt = ''
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
          nameEl.textContent = name
          col.appendChild(logoWrap)
          col.appendChild(nameEl)
          return col
        }

        const league = document.createElement('span')
        league.className = 'apex-qg-league'
        league.textContent = sec.querySelector('.apex-today-league-title')?.textContent || sport
        const mid = document.createElement('div')
        mid.className = 'apex-qg-mid'
        const dayEl = document.createElement('span')
        dayEl.className = 'apex-qg-day'
        dayEl.textContent = day
        const timeEl = document.createElement('span')
        timeEl.className = 'apex-qg-time'
        timeEl.textContent = time ? `at ${time}` : ''
        mid.appendChild(dayEl)
        mid.appendChild(timeEl)

        slide.appendChild(league)
        slide.appendChild(buildTeam(away))
        slide.appendChild(mid)
        slide.appendChild(buildTeam(home))

        const finished = isOddsEventFinished(ev)
        const pastCommence = isOddsEventPastCommence(ev)
        const lockedPick = finished || pastCommence
        if (lockedPick) {
          slide.classList.add('apex-qg-slide--finished')
          slide.setAttribute('aria-disabled', 'true')
          appendGameOverOverlay(slide, finished ? 'Game over' : 'Started')
        }
        const flashFinished = () => {
          slide.classList.add('apex-qg-slide--finished-flash')
          window.setTimeout(() => slide.classList.remove('apex-qg-slide--finished-flash'), 420)
        }
        const onPick = () => {
          if (lockedPick) {
            flashFinished()
            if (pastCommence && !finished) sn('Game already started — pre-game analysis is locked')
            return
          }
          const flySources = captureFlySourcesFromSlide(slide)
          const sportGlowKey = typeof ev?.sport_key === 'string' ? ev.sport_key : sport
          const rm = prefersReducedMotion()
          playCarouselPickAnimation(slide)
          const goAnalyze = () => {
            applyOddsEvent(ev)
            navigateTopRoute('analyze')
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
            const scrollDelay = rm ? 0 : 540
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                playFlyToAnalyzeFromCaptured(root, flySources, sportGlowKey)
                const inp = root.querySelector('.inp-panel')
                if (inp && typeof window !== 'undefined') {
                  window.setTimeout(() => {
                    inp.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }, scrollDelay)
                }
              })
            })
          }
          if (rm) goAnalyze()
          else window.setTimeout(goAnalyze, 220)
        }
        slide.addEventListener('click', onPick)
        slide.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onPick()
          }
        })
        return slide
      }

      try {
        const [logoMaps, events] = await (async () => {
          const logosPromise = loadEspnTeamLogos()
          const cached = readTodayScheduleCache()
          if (cached) return [await logosPromise, cached]
          const upcomingUrl = `${apiUrl('/api/odds/upcoming')}?${new URLSearchParams({
            sport: 'all',
            perSportLimit: '120',
          })}`
          const fetchUpcoming = async () => {
            const r = await fetch(upcomingUrl, { cache: 'no-store' })
            const data = await r.json().catch(() => ({}))
            if (!r.ok) {
              throw new Error(
                typeof data?.error === 'string' ? data.error : `Request failed (${r.status})`,
              )
            }
            return data
          }
          let data = await fetchUpcoming()
          if (Array.isArray(data.errors) && data.errors.length > 0) {
            await new Promise((r) => setTimeout(r, 500))
            data = await fetchUpcoming()
          }
          const evs = Array.isArray(data.events) ? data.events : []
          const hasLeagueErrors = Array.isArray(data.errors) && data.errors.length > 0
          writeTodayScheduleCache(evs, { complete: !hasLeagueErrors })
          return [await logosPromise, evs]
        })()

        const gridModeNow = readTodayLayoutMode() === 'grid'

        sections.forEach((sec) => {
          const sport = sec.getAttribute('data-sport') || ''
          const viewport = sec.querySelector('.apex-qg-carousel-viewport')
          const track = sec.querySelector('[data-role="row-track"]')
          const gridEl = sec.querySelector('[data-role="grid"]')
          if (!(viewport instanceof HTMLElement) || !(track instanceof HTMLElement)) return
          if (!(gridEl instanceof HTMLElement)) return
          applySectionLayout(sec, gridModeNow)

          const leagueTitle = sec.querySelector('.apex-today-league-title')?.textContent?.trim() || sport
          const filtered = events
            .filter(
              (ev) =>
                ev?.sport_key === sport &&
                isCommenceWithinLocalCalendarDayWindow(
                  ev.commence_time,
                  TODAY_SECTION_CALENDAR_DAY_SPAN,
                ),
            )
            .sort(
              (a, b) =>
                new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime(),
            )
            .slice(0, 50)
          if (!filtered.length) {
            showTodayOffSeason(sec, leagueTitle)
            return
          }

          hideTodayOffSeason(sec)

          if (gridModeNow) {
            gridEl.replaceChildren()
            filtered.forEach((ev) => {
              gridEl.appendChild(createTodayGameSlide(ev, sport, logoMaps, sec))
            })
            gridEl.querySelectorAll('.apex-qg-slide').forEach((slide) => {
              slide.style.flex = ''
              slide.style.width = ''
            })
            return
          }

          track.replaceChildren()
          filtered.forEach((ev) => {
            track.appendChild(createTodayGameSlide(ev, sport, logoMaps, sec))
          })

          const n = filtered.length
          for (let i = 0; i < n; i++) {
            const clone = track.children[i].cloneNode(true)
            clone.setAttribute('aria-hidden', 'true')
            track.appendChild(clone)
          }
          track.classList.add('apex-qg-carousel-track--ticker')
          viewport.classList.add('apex-qg-carousel-viewport--ticker')

          let layoutAttempts = 0
          const layout = () => {
            const vw = Math.max(0, viewport.clientWidth)
            if (!vw) {
              layoutAttempts += 1
              if (layoutAttempts <= 10) window.requestAnimationFrame(layout)
              return
            }
            const mobileSlots =
              typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? 1 : desktopSlots
            const cw = (vw - (mobileSlots - 1) * TICKER_GAP_PX) / mobileSlots
            const slides = track.querySelectorAll('.apex-qg-slide:not(.apex-qg-slide--empty)')
            slides.forEach((slide) => {
              slide.style.flex = `0 0 ${cw}px`
              slide.style.width = `${cw}px`
            })
            const oneSetPx = n * cw + Math.max(0, n - 1) * TICKER_GAP_PX
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
          window.requestAnimationFrame(layout)
        })
      } catch (e) {
        const gridModeNow = readTodayLayoutMode() === 'grid'
        const msg = humanizeOddsScheduleError(e)
        sections.forEach((sec) => {
          hideTodayOffSeason(sec)
          const viewport = sec.querySelector('.apex-qg-carousel-viewport')
          const track = sec.querySelector('[data-role="row-track"]')
          const gridEl = sec.querySelector('[data-role="grid"]')
          if (!(viewport instanceof HTMLElement) || !(track instanceof HTMLElement)) return
          if (!(gridEl instanceof HTMLElement)) return
          applySectionLayout(sec, gridModeNow)
          if (gridModeNow) setEmptyGrid(gridEl, msg)
          else setEmptyCarousel(track, viewport, msg)
        })
      }
    }

    const runOddsSearch = async () => {
      const q = searchInput?.value?.trim() ?? ''
      const sport = sportSel?.value ?? 'all'
      if (q.length < 2) {
        hideOddsResults()
        return
      }
      if (oddsAbort) oddsAbort.abort()
      oddsAbort = new AbortController()
      const ac = oddsAbort

      if (resultsEl) {
        resultsEl.hidden = false
        resultsEl.replaceChildren()
        const loading = document.createElement('div')
        loading.className = 'apex-team-search-status'
        loading.textContent = 'Loading games…'
        resultsEl.appendChild(loading)
        searchInput?.setAttribute('aria-expanded', 'true')
      }

      try {
        const url = `${apiUrl('/api/odds/events')}?${new URLSearchParams({ q, sport })}`
        const r = await fetch(url, { signal: ac.signal, cache: 'no-store' })
        const data = await r.json().catch(() => ({}))
        if (ac.signal.aborted) return
        if (!r.ok) {
          const msg =
            typeof data.error === 'string'
              ? data.error
              : typeof data.hint === 'string'
                ? data.hint
                : `Request failed (${r.status})`
          throw new Error(msg)
        }
        const events = Array.isArray(data.events) ? data.events : []
        if (!resultsEl) return
        resultsEl.replaceChildren()
        resultsEl.hidden = false
        searchInput?.setAttribute('aria-expanded', 'true')
        if (events.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'apex-team-search-status'
          empty.textContent =
            Array.isArray(data.errors) && data.errors.length > 0
              ? 'No matches. Some schedules may be unavailable right now.'
              : 'No upcoming games match that search.'
          resultsEl.appendChild(empty)
          return
        }
        for (const ev of events) {
          const btn = document.createElement('button')
          btn.type = 'button'
          const finished = isOddsEventFinished(ev)
          const pastCommence = isOddsEventPastCommence(ev)
          const lockedHit = finished || pastCommence
          btn.className = lockedHit ? 'apex-team-search-hit apex-team-search-hit--finished' : 'apex-team-search-hit'
          if (lockedHit) btn.setAttribute('aria-disabled', 'true')
          const title = document.createElement('div')
          title.className = 'apex-team-search-hit-title'
          const away = typeof ev.away_team === 'string' ? ev.away_team : 'Away'
          const home = typeof ev.home_team === 'string' ? ev.home_team : 'Home'
          title.textContent = `${away} @ ${home}`
          const meta = document.createElement('div')
          meta.className = 'apex-team-search-hit-meta'
          const when = new Date(ev.commence_time)
          const league = typeof ev.sport_title === 'string' ? ev.sport_title : ''
          const timeStr = Number.isNaN(when.getTime())
            ? ''
            : when.toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
          const baseMeta = league ? `${league} · ${timeStr}` : timeStr
          if (finished) {
            meta.textContent = baseMeta ? `${baseMeta} · Game over` : 'Game over'
          } else if (pastCommence) {
            meta.textContent = baseMeta ? `${baseMeta} · Started` : 'Started'
          } else {
            meta.textContent = baseMeta
          }
          btn.appendChild(title)
          btn.appendChild(meta)
          btn.addEventListener('click', () => {
            if (lockedHit) {
              btn.classList.add('apex-team-search-hit--flash')
              window.setTimeout(() => btn.classList.remove('apex-team-search-hit--flash'), 420)
              sn(finished ? 'Game over' : 'Game already started — pre-game analysis is locked')
              return
            }
            applyOddsEvent(ev)
          })
          resultsEl.appendChild(btn)
        }
      } catch (e) {
        if (ac.signal.aborted || (e && e.name === 'AbortError')) return
        if (!resultsEl) return
        resultsEl.replaceChildren()
        resultsEl.hidden = false
        const err = document.createElement('div')
        err.className = 'apex-team-search-status apex-team-search-status--err'
        err.textContent = humanizeOddsScheduleError(e)
        resultsEl.appendChild(err)
        searchInput?.setAttribute('aria-expanded', 'true')
      }
    }

    const scheduleOddsSearch = () => {
      clearOddsDebounce()
      const q = searchInput?.value?.trim() ?? ''
      if (q.length < 2) {
        if (oddsAbort) oddsAbort.abort()
        oddsAbort = null
        hideOddsResults()
        return
      }
      oddsDebounceId = window.setTimeout(() => {
        oddsDebounceId = 0
        void runOddsSearch()
      }, 350)
    }

    /** Native <select> sizes to the widest option; shrink width to the current label so “MLB” isn’t drowned in empty space. */
    const syncOddsSportSelectWidth = () => {
      const sel = root.querySelector('#apex-odds-sport')
      const measure = root.querySelector('#apex-odds-sport-measure')
      if (!(sel instanceof HTMLSelectElement) || !measure) return
      const opt = sel.options[sel.selectedIndex]
      measure.textContent = opt?.text ?? ''
      const textW = measure.getBoundingClientRect().width
      const horizontalPad = 2 + 22
      sel.style.width = `${Math.ceil(textW + horizontalPad)}px`
    }

    const onOddsInput = () => scheduleOddsSearch()
    const onOddsSportChange = () => {
      syncOddsSportSelectWidth()
      scheduleOddsSearch()
    }

    /** Close dropdown when clicking outside the search block (blur breaks row clicks). */
    const onDocPointerDown = (e) => {
      if (!(e.target instanceof Node) || !searchPh) return
      if (searchPh.contains(e.target)) return
      hideOddsResults()
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)

    searchInput?.addEventListener('input', onOddsInput)
    sportSel?.addEventListener('change', onOddsSportChange)
    syncOddsSportSelectWidth()
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => syncOddsSportSelectWidth())
    }
    root.querySelector('.apex-top-nav')?.addEventListener('click', onTopNavClick)
    window.addEventListener('popstate', onPopState)
    if (!restoreAnalyzeSessionFromSnapshotIfAny()) {
      if (typeof window !== 'undefined') {
        applyTopRoute(topPageFromPathname(window.location.pathname))
      } else {
        applyTopRoute('analyze')
      }
    }

    const ANALYZE_FORM_FIELD_IDS = [
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
      'f6',
      'f7',
      'f8',
      'f9',
      'f10',
      'f11',
    ]

    const clearAnalyzeBtn = root.querySelector('#apex-analyze-clear-btn')
    const onClearAnalyze = () => {
      for (const id of ANALYZE_FORM_FIELD_IDS) {
        const el = root.querySelector(`#${id}`)
        if (el) el.value = ''
      }
      const oddsEventIdEl = root.querySelector('#apex-odds-event-id')
      if (oddsEventIdEl instanceof HTMLInputElement) oddsEventIdEl.value = ''
      clearCommenceIsoOnRoot(root)
      syncPreGameAnalyzeUi(root)
      const analyzeSportSel = root.querySelector('#apex-analyze-sport')
      if (analyzeSportSel instanceof HTMLSelectElement) analyzeSportSel.value = 'baseball_mlb'
      if (searchInput) searchInput.value = ''
      hideOddsResults()
      mountApexBetCards(root, null)
      void refreshAnalyzePropLadderPanel(root, { game: {}, cards: null })
      clearAnalyzeButtonSportGlow(root)
      hidePickedGameStrip(root)
    }
    clearAnalyzeBtn?.addEventListener('click', onClearAnalyze)

    const cleanupQuickGames = setupQuickGamesCarousel(root)
    const cleanupPlayerPropsCarousel = setupPlayerPropsCarousel(root)
    const todayPageEl = root.querySelector('#apex-today-page')
    todayPageEl?.addEventListener('click', onTodayPageClick)
    void renderTodayRows()

    const abtn = root.querySelector('#abtn')
    const cbtn = root.querySelector('#cbtn')
    const sendbtn = root.querySelector('#sendbtn')
    const chatInput = root.querySelector('#chat-input')

    const onIcEnter = (e) => {
      if (e.key === 'Enter') go()
    }

    const stopPreGameTicker = startPreGameCountdownTicker(root)

    abtn?.addEventListener('click', go)
    cbtn?.addEventListener('click', copyChat)
    sendbtn?.addEventListener('click', sendFollowUp)
    const onKeyDown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendFollowUp()
      }
    }
    chatInput?.addEventListener('keydown', onKeyDown)
    const icellInputs = root.querySelectorAll('.icell input, .icell select')
    icellInputs.forEach((i) => i.addEventListener('keydown', onIcEnter))

    return () => {
      unsubPastGames()
      subChatBtn?.removeEventListener('click', onSubChat)
      subPastBtn?.removeEventListener('click', onSubPast)
      pastGamesListEl?.removeEventListener('click', onPastGameCardClick)
      abtn?.removeEventListener('click', go)
      cbtn?.removeEventListener('click', copyChat)
      sendbtn?.removeEventListener('click', sendFollowUp)
      chatInput?.removeEventListener('keydown', onKeyDown)
      icellInputs.forEach((i) => i.removeEventListener('keydown', onIcEnter))
      root.querySelectorAll('.tab').forEach((tab) => {
        tab.removeEventListener('click', onTab)
      })
      sidebarToggle?.removeEventListener('click', onSidebarToggle)
      sidebarScrim?.removeEventListener('click', onScrimClick)
      advToggle?.removeEventListener('click', onAdvToggle)
      clearAnalyzeBtn?.removeEventListener('click', onClearAnalyze)
      analyzeSportForLineReasoning?.removeEventListener('change', syncLineReasoningMlbDisabled)
      mlbScopeBtn?.removeEventListener('click', onMlbScopeMenuBtnClick)
      root.querySelectorAll('input[name="apex-mlb-betting-scope"]').forEach((el) => {
        el.removeEventListener('change', onMlbScopeRadioChange)
      })
      root.querySelectorAll('input[name="apex-line-reasoning"]').forEach((el) => {
        el.removeEventListener('change', onLineReasoningRadioChange)
      })
      lineReasoningBtn?.removeEventListener('click', onLineReasoningBtnClick)
      document.removeEventListener('pointerdown', onLineReasoningDocPointerDown, true)
      clearOddsDebounce()
      if (oddsAbort) oddsAbort.abort()
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      searchInput?.removeEventListener('input', onOddsInput)
      sportSel?.removeEventListener('change', onOddsSportChange)
      root.removeEventListener('apex:analyze-fill', onAnalyzeFillEvent)
      root.querySelector('.apex-top-nav')?.removeEventListener('click', onTopNavClick)
      root.querySelector('#apex-today-page')?.removeEventListener('click', onTodayPageClick)
      window.removeEventListener('popstate', onPopState)
      cleanupQuickGames()
      cleanupPlayerPropsCarousel()
      stopPreGameTicker()
    }
  }, [
    adminDevSession,
    signOutUser,
    sn,
    user?.uid,
    showAnalyzerDoneToast,
    setColorMode,
    colorMode,
  ])

  useEffect(() => {
    renderChat()
  }, [thread, renderChat])

  useEffect(() => {
    const root = wrapRef.current
    if (!root?.querySelector('#apex-analyze-sport')) return
    applySportAvailabilityToRoot(root, disabledSportKeys)
  }, [disabledSportKeys])

  return (
    <>
      <ApiConfigBanner />
      <div
        ref={wrapRef}
        className={`apex-html-root apex-ios apex-theme-${colorMode}`}
      />
      <div
        id="apex-analyzer-toast"
        className="apex-analyzer-toast"
        role="status"
        aria-live="polite"
      />
    </>
  )
}

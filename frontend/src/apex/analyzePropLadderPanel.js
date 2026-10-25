/**
 * Analyze results: full MLB player prop board for each certified player (all O/U markets + Yes/No,
 * main lines merged with alternate lines per market — same as Odds API event odds).
 * Requires `game.oddsEventId` from schedule selection. Dedupes players across single lock + parlay legs.
 */

import { apiUrl } from './apiConfig.js'
import './analyzePropLadderPanel.css'

const MLB_HEADSHOT = (id) =>
  `https://img.mlbstatic.com/mlb-photos/image/upload/w_160,q_auto:best,f_auto/v1/people/${id}/headshot/silo/current`

/** Browser cache for `/api/odds/mlb-player-props-board` responses. */
const BOARD_CLIENT_CACHE_PREFIX = 'apex-mlb-props-board-v1'
const BOARD_CLIENT_TTL_MS = 6 * 60 * 60 * 1000

function normalizePlayerNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function boardClientCacheKey(eventId, playerNames, book) {
  const sorted = [...playerNames].map(normalizePlayerNameKey).filter(Boolean).sort()
  return `${BOARD_CLIENT_CACHE_PREFIX}:${eventId}:${book}:${sorted.join('\u0001')}`
}

/** @returns {object | null} */
function readBoardClientCache(key) {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (typeof o.at !== 'number' || !o.payload || Date.now() - o.at > BOARD_CLIENT_TTL_MS) return null
    return o.payload
  } catch {
    return null
  }
}

/** @param {object} payload */
function writeBoardClientCache(key, payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.players)) return
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), payload }))
  } catch {
    /* quota / private mode */
  }
}

/**
 * Strip common model cruft so the OVER/UNDER regex can match.
 * @param {string} raw
 */
function sanitizeLockPickString(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  s = s.replace(/^[\s*•·]+/u, '').trim()
  s = s.replace(/^\*+\s*|\s*\*+$/g, '').trim()
  s = s.replace(/^["'`]|["'`]$/g, '').trim()
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/^(?:my\s+lock:?|best\s+lock:?|lock:?|pick:?|play:?|single\s+leg:?)\s+/i, '').trim()
  return s
}

/** Turn vulgar fractions in the line number into decimal text before matching. */
function normalizeLineFractions(s) {
  return String(s || '')
    .replace(/\b(\d+)½\b/gi, '$1.5')
    .replace(/\b(\d+)¼\b/gi, '$1.25')
    .replace(/\b(\d+)¾\b/gi, '$1.75')
}

/**
 * Remove trailing odds / book shout-outs from the market tail (keep phrase Odds API keys map to).
 * @param {string} tail
 */
function trimLockMarketTail(tail) {
  let t = String(tail || '').trim()
  while (/\([^)]*\)\s*$/.test(t)) t = t.replace(/\s*\([^)]*\)\s*$/, '').trim()
  t = t.replace(/\s+[\u2013\u2014–-]\s+.+$/u, '').trim()
  t = t.replace(/[.!?,;:]+$/u, '').trim()
  return t
}

/**
 * Parse primary lock string from bet cards (player prop).
 * @param {string} lockStr
 * @returns {{ name: string, marketKey: string, marketTitle: string } | null}
 */
export function parsePrimaryPlayerPropPick(lockStr) {
  let s = normalizeLineFractions(sanitizeLockPickString(lockStr))
  if (!s) return null
  s = s.replace(/[.!?]+$/u, '').trim()

  const tryMatch = (str) => {
    const patterns = [
      /^(.+?)\s*(?:[—–-]\s*)?(OVER|UNDER)\s+([\d.]+)\s+(.+?)(?:\s*\([^)]*\))?\s*$/i,
      /^(.+?)\s*(?:[—–-]\s*)?(OVER|UNDER)\s+([\d.]+)\s+(.+)$/i,
    ]
    for (const re of patterns) {
      const mm = str.match(re)
      if (mm) return mm
    }
    return null
  }

  let m = tryMatch(s)
  if (!m) {
    const oneLine = s.split(/\n+/)[0].trim()
    if (oneLine !== s) m = tryMatch(oneLine)
  }
  if (!m) return null

  const name = m[1].replace(/\*+/g, '').trim()
  const tailRaw = m[4].trim()
  const tail = trimLockMarketTail(tailRaw)
  const mk = mapTailToMlbMarketKey(tail)
  if (!mk) return null
  const marketTitle = marketTitleForKey(mk)
  return { name, marketKey: mk, marketTitle }
}

/** @param {string} s */
function stripLegLabelPrefix(s) {
  return String(s).replace(/^\s*leg\s*\d+\s*:\s*/i, '').trim()
}

/**
 * @param {{ singleLegLock?: string, twoLegParlay?: string[], threeLegParlay?: string[] }} cards
 * @returns {string[]}
 */
function collectLegStrings(cards) {
  const out = []
  const single = typeof cards.singleLegLock === 'string' ? cards.singleLegLock.trim() : ''
  if (single) out.push(single)
  const two = Array.isArray(cards.twoLegParlay) ? cards.twoLegParlay : []
  for (const x of two) {
    const t = typeof x === 'string' ? stripLegLabelPrefix(x.trim()) : ''
    if (t) out.push(t)
  }
  const three = Array.isArray(cards.threeLegParlay) ? cards.threeLegParlay : []
  for (const x of three) {
    const t = typeof x === 'string' ? stripLegLabelPrefix(x.trim()) : ''
    if (t) out.push(t)
  }
  return out
}

/**
 * @param {string} leg
 * @returns {string}
 */
function extractPlayerNameFromLeg(leg) {
  const p = parsePrimaryPlayerPropPick(leg)
  if (p?.name) return p.name.trim()
  let s = sanitizeLockPickString(leg)
  s = normalizeLineFractions(s)
  const m = s.match(/^(.+?)\s+(?:OVER|UNDER)\s+/i)
  if (m) return m[1].replace(/\*+/g, '').trim()
  return ''
}

/**
 * Unique player names from bet cards (single lock + parlay legs).
 * @param {{ singleLegLock?: string, twoLegParlay?: string[], threeLegParlay?: string[] }} cards
 * @returns {string[]}
 */
function collectUniquePlayerNamesFromCards(cards) {
  const legs = collectLegStrings(cards)
  const seen = new Set()
  /** @type {string[]} */
  const names = []
  for (const leg of legs) {
    const n = extractPlayerNameFromLeg(leg)
    if (!n) continue
    const key = normalizePlayerNameKey(n)
    if (seen.has(key)) continue
    seen.add(key)
    names.push(n)
  }
  return names
}

/** @param {string} tail */
function mapTailToMlbMarketKey(tail) {
  const t = tail.toLowerCase()
  if (/strikeout|strike\s*outs|punchouts?|\bk\b|\bso\b|pitcher\s*k/i.test(t)) return 'pitcher_strikeouts'
  if (/total\s*bases|\btb\b/i.test(t)) return 'batter_total_bases'
  if (/home\s*run|\bhr\b|\bdinger/i.test(t)) return 'batter_home_runs'
  if (/rbi/i.test(t)) return 'batter_rbis'
  if (/run\s*scored|^runs$/i.test(t) || /\bruns\b/i.test(t)) return 'batter_runs_scored'
  if (/hit/i.test(t) && !/strikeout/i.test(t)) return 'batter_hits'
  return null
}

/** @param {string} key */
function marketTitleForKey(key) {
  const labels = {
    pitcher_strikeouts: 'Pitcher strikeouts',
    batter_total_bases: 'Total bases',
    batter_home_runs: 'Home runs',
    batter_rbis: 'RBIs',
    batter_runs_scored: 'Runs scored',
    batter_hits: 'Hits',
  }
  return labels[key] || key
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatPoint(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '—'
  return Number.isInteger(p) ? String(p) : String(p)
}

/**
 * Full ladder + implied line (same logic as player-props carousel): book “fair” rung = smallest |O−U| spread.
 * @param {{ ouLadder?: object[], impliedPoint?: number }} row
 */
function ladderRowsHtml(row) {
  const ladder = Array.isArray(row.ouLadder) ? row.ouLadder : []
  if (ladder.length === 0) return ''
  const implied =
    typeof row.impliedPoint === 'number' && Number.isFinite(row.impliedPoint) ? row.impliedPoint : null
  return ladder
    .map((rung) => {
      const isImplied = implied != null && rung.point === implied
      const rowCls = isImplied ? 'apex-apl-ou-row apex-apl-ou-row--implied' : 'apex-apl-ou-row'
      const pt = formatPoint(rung.point)
      const oL = typeof rung.overLabel === 'string' ? rung.overLabel : '—'
      const uL = typeof rung.underLabel === 'string' ? rung.underLabel : '—'
      const impliedBar = isImplied
        ? '<div class="apex-apl-implied-bar"><span class="apex-apl-implied-bar-text">Implied line</span></div>'
        : ''
      return `${impliedBar}<div class="${rowCls}">
        <div class="apex-apl-ou-cell"><span class="apex-apl-ou-main"><span class="apex-apl-ou-side">O</span> ${esc(pt)}</span><span class="apex-apl-ou-price">${esc(oL)}</span></div>
        <div class="apex-apl-ou-cell"><span class="apex-apl-ou-main"><span class="apex-apl-ou-side">U</span> ${esc(pt)}</span><span class="apex-apl-ou-price">${esc(uL)}</span></div>
      </div>`
    })
    .join('')
}

/**
 * @param {object} playerRow — one entry from `players` in mlb-player-props-board response
 * @param {string} bookTitle
 */
function playerBoardSectionHtml(playerRow, bookTitle) {
  const name = typeof playerRow.player === 'string' ? playerRow.player : ''
  const pid = typeof playerRow.mlbPlayerId === 'number' && playerRow.mlbPlayerId > 0 ? playerRow.mlbPlayerId : null
  const imgBlock = pid
    ? `<img class="apex-apl-img" src="${MLB_HEADSHOT(pid)}" alt="${esc(name)}" width="72" height="72" loading="lazy" decoding="async" />`
    : `<div class="apex-apl-img-fallback" aria-hidden="true">${esc(name.slice(0, 2).toUpperCase())}</div>`

  const bookChip = bookTitle ? `<span class="apex-apl-book">${esc(bookTitle)}</span>` : ''

  const ou = Array.isArray(playerRow.ouMarkets) ? playerRow.ouMarkets : []
  const yn = Array.isArray(playerRow.yesNoMarkets) ? playerRow.yesNoMarkets : []

  const ouBlocks = ou
    .map(
      (m) => `
    <div class="apex-apl-submarket">
      <div class="apex-apl-title-row">
        <span class="apex-apl-market">${esc(typeof m.marketTitle === 'string' ? m.marketTitle : '')}</span>
      </div>
      <div class="apex-apl-grid" aria-label="${esc(name)} ${esc(typeof m.marketTitle === 'string' ? m.marketTitle : '')}">
        ${ladderRowsHtml({
          ouLadder: m.ouLadder,
          impliedPoint: typeof m.impliedPoint === 'number' ? m.impliedPoint : undefined,
        })}
      </div>
    </div>`,
    )
    .join('')

  const ynBlocks = yn
    .map(
      (m) => `
    <div class="apex-apl-submarket apex-apl-submarket--yesno">
      <div class="apex-apl-title-row">
        <span class="apex-apl-market">${esc(typeof m.marketTitle === 'string' ? m.marketTitle : '')}</span>
      </div>
      <div class="apex-apl-yesno-grid" role="group" aria-label="${esc(typeof m.marketTitle === 'string' ? m.marketTitle : '')}">
        <span class="apex-apl-yesno-cell"><span class="apex-apl-ou-side">Yes</span> ${esc(typeof m.yesLabel === 'string' ? m.yesLabel : '—')}</span>
        <span class="apex-apl-yesno-cell"><span class="apex-apl-ou-side">No</span> ${esc(typeof m.noLabel === 'string' ? m.noLabel : '—')}</span>
      </div>
    </div>`,
    )
    .join('')

  const empty =
    ouBlocks === '' && ynBlocks === ''
      ? `<p class="apex-apl-msg apex-apl-msg--inline">No posted lines for this player in this book’s MLB player prop markets yet.</p>`
      : ''

  return `
      <div class="apex-apl-inner apex-apl-inner--player-board">
        <div class="apex-apl-head">
          <div class="apex-apl-img-wrap">${imgBlock}</div>
          <div class="apex-apl-head-text">
            <div class="apex-apl-title-row">
              <span class="apex-apl-market">All MLB player props</span>
              ${bookChip}
            </div>
            <div class="apex-apl-player">${esc(name)}</div>
          </div>
        </div>
        <div class="apex-apl-submarkets">${ouBlocks}${ynBlocks}${empty}</div>
      </div>
    `
}

/**
 * @param {string} eventId
 * @param {string[]} playerNames
 * @param {string} book
 */
async function fetchPlayerPropsBoardPayload(eventId, playerNames, book) {
  const cacheKey = boardClientCacheKey(eventId, playerNames, book)
  const cached = readBoardClientCache(cacheKey)
  if (cached && cached.ok === true && Array.isArray(cached.players)) {
    return { ok: true, data: cached }
  }

  const params = new URLSearchParams({
    eventId,
    players: playerNames.join(','),
    book,
  })
  const res = await fetch(apiUrl(`/api/odds/mlb-player-props-board?${params.toString()}`))
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return {
      ok: false,
      message: typeof data.error === 'string' ? data.error : `Error ${res.status}`,
    }
  }
  if (!data.ok || !Array.isArray(data.players)) {
    return {
      ok: false,
      message: typeof data.message === 'string' ? data.message : 'Could not load player prop board.',
    }
  }
  writeBoardClientCache(cacheKey, data)
  return { ok: true, data }
}

/**
 * @param {HTMLElement | null} root
 * @param {{ game?: Record<string, unknown>, cards?: object | null }} opts
 */
export async function refreshAnalyzePropLadderPanel(root, opts) {
  const section = root?.querySelector('#apex-analyze-page-prop-ladder')
  const body = root?.querySelector('#apex-analyze-page-prop-ladder-body')
  if (!section || !body) return

  const game = opts.game && typeof opts.game === 'object' ? opts.game : {}
  const cards = opts.cards && typeof opts.cards === 'object' ? opts.cards : null

  if (!cards) {
    section.hidden = true
    body.replaceChildren()
    return
  }

  const sportKey = typeof game.sportKey === 'string' ? game.sportKey : ''
  const eventId = typeof game.oddsEventId === 'string' ? game.oddsEventId.trim() : ''

  section.hidden = true
  body.innerHTML = ''

  if (sportKey !== 'baseball_mlb') {
    return
  }

  const playerNames = collectUniquePlayerNamesFromCards(cards)
  if (playerNames.length === 0) {
    section.hidden = false
    body.innerHTML = `<p class="apex-apl-msg">Live MLB player prop boards load for each player named on your certified picks. We could not read a player name from the bet-card legs — use OVER/UNDER phrasing (e.g. <strong>Player OVER 0.5 HR</strong>).</p>`
    return
  }

  if (!eventId) {
    section.hidden = false
    const names = playerNames.join(', ')
    body.innerHTML = `<p class="apex-apl-msg">Pick a game from the <strong>schedule search</strong> above (not only typed teams) so we can load all main + alt player prop lines for: <strong>${esc(names)}</strong>.</p>`
    return
  }

  const book = 'draftkings'

  try {
    const fetched = await fetchPlayerPropsBoardPayload(eventId, playerNames, book)
    if (!fetched.ok || !fetched.data) {
      section.hidden = false
      body.innerHTML = `<p class="apex-apl-msg">${esc(fetched.message || 'Could not load lines.')}</p>`
      return
    }

    const bookTitle =
      typeof fetched.data.bookTitle === 'string' && fetched.data.bookTitle.trim()
        ? fetched.data.bookTitle.trim()
        : 'Sportsbook'

    const blocks = (fetched.data.players || []).map((row) => playerBoardSectionHtml(row, bookTitle))
    section.hidden = false
    body.innerHTML = `<div class="apex-apl-stack">${blocks.join('')}</div>`
  } catch (e) {
    section.hidden = false
    body.innerHTML = `<p class="apex-apl-msg">${esc(e?.message || 'Network error loading lines.')}</p>`
  }
}

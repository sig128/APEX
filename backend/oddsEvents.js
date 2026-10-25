/** The Odds API — big-4 schedule search (events endpoint does not use monthly quota). */

import { getDisabledSportKeys, filterEnabledSportKeys } from './sportsConfig.js'

const ODDS_BASE = 'https://api.the-odds-api.com/v4'

/**
 * Turn Odds API JSON error bodies into a short string (avoids raw JSON in API responses).
 * @param {string} text
 * @param {number} [httpStatus]
 */
function parseOddsApiErrorMessage(text, httpStatus) {
  const raw = typeof text === 'string' ? text.trim() : ''
  try {
    const j = JSON.parse(raw)
    if (j && typeof j === 'object') {
      if (j.error_code === 'EXCEEDED_FREQ_LIMIT' || /too frequent/i.test(String(j.message || ''))) {
        return 'Odds API rate limit — try again in a few minutes.'
      }
      if (typeof j.message === 'string' && j.message.trim()) return j.message.trim()
    }
  } catch {
    /* not JSON */
  }
  if (httpStatus === 429) return 'Odds API rate limit — try again in a few minutes.'
  return raw ? raw.slice(0, 200) : `HTTP ${httpStatus || 'error'}`
}

// ---- spend guards ---------------------------------------------------------------------------
/** Odds API event ids are 32 hex characters. */
const EVENT_ID_RE = /^[a-f0-9]{32}$/
const EVENT_ODDS_TTL_MS = 10 * 60 * 1000
const EVENT_ODDS_WINDOW_MS = 48 * 3600 * 1000
const SCHEDULE_TTL_MS = 60 * 1000
const eventOddsCache = new Map() // eventId -> { at, promise }
const scheduleCache = new Map() // sportKey -> { at, promise }
/**
 * async (credits, { req }) => boolean | { ok, reason: 'caller' | 'pool' }. Set by the app to draw
 * from the shared daily budget (and each caller's share of it); a negative amount refunds.
 */
let oddsBudget = null
export function setOddsBudget(fn) {
  oddsBudget = typeof fn === 'function' ? fn : null
}
export function _resetOddsCaches() {
  eventOddsCache.clear()
  scheduleCache.clear()
}

export const BIG4_KEYS = {
  nfl: 'americanfootball_nfl',
  nba: 'basketball_nba',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
}

/**
 * @param {string} sport - `all` | `nfl` | `nba` | `mlb` | `nhl`
 * @returns {string[]}
 */
export function resolveSportsParam(sport) {
  const s = (sport || 'all').toLowerCase().trim()
  if (s === 'all') return Object.values(BIG4_KEYS)
  if (BIG4_KEYS[s]) return [BIG4_KEYS[s]]
  const err = new Error('Invalid sport. Use all, nfl, nba, mlb, or nhl.')
  /** @type {{ status?: number }} */ (err).status = 400
  throw err
}

/**
 * @param {string} apiKey
 * @param {string[]} sportKeys
 * @returns {Promise<{ events: object[], errors: { sport: string, message: string }[] }>}
 */
export async function fetchOddsEventsSafe(apiKey, sportKeys) {
  const oddsKey = typeof apiKey === 'string' ? apiKey.trim() : ''
  const errors = []
  const settled = await Promise.allSettled(
    sportKeys.map((sportKey) => {
      // listing events costs no credits, but there's no reason to ask more than once a minute
      const hit = scheduleCache.get(sportKey)
      if (hit && Date.now() - hit.at < SCHEDULE_TTL_MS) return hit.promise
      const p = (async () => {
        const url = new URL(`${ODDS_BASE}/sports/${encodeURIComponent(sportKey)}/events`)
        url.searchParams.set('apiKey', oddsKey)
        url.searchParams.set('dateFormat', 'iso')
        const res = await fetch(url, { headers: { Accept: 'application/json' } })
        const text = await res.text()
        if (!res.ok) {
          throw new Error(parseOddsApiErrorMessage(text, res.status))
        }
        try {
          const data = JSON.parse(text)
          return Array.isArray(data) ? data : []
        } catch {
          throw new Error('Invalid JSON from Odds API')
        }
      })()
      scheduleCache.set(sportKey, { at: Date.now(), promise: p })
      p.catch(() => {
        if (scheduleCache.get(sportKey)?.promise === p) scheduleCache.delete(sportKey)
      })
      return p
    }),
  )

  const events = []
  for (let i = 0; i < settled.length; i++) {
    const sportKey = sportKeys[i]
    const r = settled[i]
    if (r.status === 'fulfilled') {
      for (const ev of r.value) {
        events.push({ ...ev, sport_key: ev.sport_key || sportKey })
      }
    } else {
      const msg = r.reason?.message || String(r.reason)
      errors.push({ sport: sportKey, message: msg })
    }
  }
  return { events, errors }
}

/**
 * @param {object[]} events
 * @param {string} q
 */
export function filterEventsByQuery(events, q) {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []
  return events.filter((ev) => {
    const h = typeof ev.home_team === 'string' ? ev.home_team.toLowerCase() : ''
    const a = typeof ev.away_team === 'string' ? ev.away_team.toLowerCase() : ''
    return h.includes(needle) || a.includes(needle)
  })
}

/**
 * Express handler: GET ?q=&sport=
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string | undefined} apiKey
 */
export async function handleOddsEventsRequest(req, res, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) {
    res.status(503).json({
      error: 'THE_ODDS_API_KEY is not set (backend/.env or Cloud Function secret).',
    })
    return
  }

  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const sport = typeof req.query.sport === 'string' ? req.query.sport : 'all'

  if (q.trim().length < 2) {
    res.json({
      events: [],
      hint: 'Type at least 2 characters to search by team name.',
    })
    return
  }

  try {
    let keys = resolveSportsParam(sport)
    const disabled = await getDisabledSportKeys()
    keys = filterEnabledSportKeys(keys, disabled)
    if (keys.length === 0) {
      res.json({ events: [] })
      return
    }
    const { events: raw, errors } = await fetchOddsEventsSafe(key, keys)
    if (raw.length === 0 && errors.length === keys.length) {
      const hint = errors[0]?.message || 'Odds API returned no data.'
      res.status(502).json({
        error:
          'Could not load schedules from The Odds API. Set THE_ODDS_API_KEY in Firebase (functions:secrets:set) to the same key as local backend/.env, or fix an invalid/expired key.',
        details: errors,
        hint,
      })
      return
    }
    const filtered = filterEventsByQuery(raw, q)
    filtered.sort((a, b) => {
      const ta = new Date(a.commence_time).getTime()
      const tb = new Date(b.commence_time).getTime()
      return ta - tb
    })
    const events = filtered.slice(0, 50)
    res.json({
      events,
      ...(errors.length ? { errors } : {}),
    })
  } catch (e) {
    const code = typeof e?.status === 'number' ? e.status : 502
    const status = code >= 400 && code < 500 ? code : 502
    res.status(status).json({ error: e?.message || String(e) })
  }
}

/**
 * GET /api/odds/upcoming — merged upcoming games (no search filter), for carousel.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string | undefined} apiKey
 */
export async function handleOddsUpcomingRequest(req, res, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) {
    res.status(503).json({
      error: 'THE_ODDS_API_KEY is not set (backend/.env or Cloud Function secret).',
    })
    return
  }

  const sport = typeof req.query.sport === 'string' ? req.query.sport : 'all'

  try {
    let keys = resolveSportsParam(sport)
    const disabled = await getDisabledSportKeys()
    keys = filterEnabledSportKeys(keys, disabled)
    if (keys.length === 0) {
      res.json({ events: [] })
      return
    }
    const { events: raw, errors } = await fetchOddsEventsSafe(key, keys)
    if (raw.length === 0 && errors.length === keys.length) {
      const hint = errors[0]?.message || 'Odds API returned no data.'
      res.status(502).json({
        error:
          'Could not load schedules from The Odds API. Set THE_ODDS_API_KEY in Firebase (functions:secrets:set) to the same key as local backend/.env.',
        details: errors,
        hint,
      })
      return
    }
    raw.sort((a, b) => {
      const ta = new Date(a.commence_time).getTime()
      const tb = new Date(b.commence_time).getTime()
      return ta - tb
    })
    /** When merging multiple leagues, a single global slice starves sports that sort later (e.g. MLB/NFL). */
    let events
    if (keys.length > 1) {
      const perSport = Math.min(
        200,
        Math.max(10, parseInt(String(req.query.perSportLimit || '120'), 10) || 120),
      )
      const buckets = {}
      for (const k of keys) buckets[k] = []
      for (const ev of raw) {
        const sk = ev.sport_key
        if (sk && buckets[sk]) buckets[sk].push(ev)
      }
      for (const k of keys) {
        buckets[k].sort((a, b) => {
          const ta = new Date(a.commence_time).getTime()
          const tb = new Date(b.commence_time).getTime()
          return ta - tb
        })
      }
      events = []
      for (const k of keys) {
        events.push(...buckets[k].slice(0, perSport))
      }
      events.sort((a, b) => {
        const ta = new Date(a.commence_time).getTime()
        const tb = new Date(b.commence_time).getTime()
        return ta - tb
      })
    } else {
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '60'), 10) || 60))
      events = raw.slice(0, limit)
    }
    res.json({
      events,
      ...(errors.length ? { errors } : {}),
    })
  } catch (e) {
    const code = typeof e?.status === 'number' ? e.status : 502
    const status = code >= 400 && code < 500 ? code : 502
    res.status(status).json({ error: e?.message || String(e) })
  }
}

/* —— MLB player props showcase (event odds; cached server-side to limit Odds API quota) —— */

/**
 * All MLB player prop market keys (main lines) — The Odds API player props docs.
 * Alternate lines are requested separately and merged per base key below.
 */
const MLB_MAIN_PLAYER_PROP_KEYS = [
  'batter_home_runs',
  'batter_first_home_run',
  'batter_hits',
  'batter_total_bases',
  'batter_rbis',
  'batter_runs_scored',
  'batter_hits_runs_rbis',
  'batter_singles',
  'batter_doubles',
  'batter_triples',
  'batter_walks',
  'batter_strikeouts',
  'batter_stolen_bases',
  'batter_fantasy_score',
  'pitcher_strikeouts',
  'pitcher_record_a_win',
  'pitcher_hits_allowed',
  'pitcher_walks',
  'pitcher_earned_runs',
  'pitcher_outs',
]

const MLB_YESNO_PLAYER_PROP_KEYS = new Set(['batter_first_home_run', 'pitcher_record_a_win'])

/** Markets that use Over/Under ladders (everything in main list except Yes/No player props). */
const MLB_OU_PLAYER_PROP_KEYS = MLB_MAIN_PLAYER_PROP_KEYS.filter((k) => !MLB_YESNO_PLAYER_PROP_KEYS.has(k))

/**
 * The Odds API splits “main” vs alt thresholds; merge with base for full ladders (e.g. 4.5 / 5.5 / 6.5 Ks).
 * Only pairs listed in the Alternate MLB Player Props API table have an alt key.
 */
const MLB_ALT_MARKET_BY_BASE = {
  batter_hits: 'batter_hits_alternate',
  batter_home_runs: 'batter_home_runs_alternate',
  batter_total_bases: 'batter_total_bases_alternate',
  batter_rbis: 'batter_rbis_alternate',
  batter_runs_scored: 'batter_runs_scored_alternate',
  batter_singles: 'batter_singles_alternate',
  batter_doubles: 'batter_doubles_alternate',
  batter_triples: 'batter_triples_alternate',
  batter_walks: 'batter_walks_alternate',
  batter_strikeouts: 'batter_strikeouts_alternate',
  batter_fantasy_score: 'batter_fantasy_score_alternate',
  pitcher_strikeouts: 'pitcher_strikeouts_alternate',
  pitcher_hits_allowed: 'pitcher_hits_allowed_alternate',
  pitcher_walks: 'pitcher_walks_alternate',
  pitcher_earned_runs: 'pitcher_earned_runs_alternate',
  pitcher_outs: 'pitcher_outs_alternate',
}

function mlbAltMarketKey(baseKey) {
  return MLB_ALT_MARKET_BY_BASE[baseKey] || null
}

/** @returns {string[]} all main + alternate keys for one `/events/{id}/odds` request */
function mlbEventOddsMarketKeysForFetch() {
  const keys = new Set()
  for (const base of MLB_MAIN_PLAYER_PROP_KEYS) {
    keys.add(base)
    const alt = mlbAltMarketKey(base)
    if (alt) keys.add(alt)
  }
  return [...keys]
}

/** Homepage ticker samples a small set of markets (full fetch still loads all keys above). */
const MLB_SHOWCASE_CAROUSEL_MARKETS = [
  'batter_hits',
  'batter_home_runs',
  'pitcher_strikeouts',
  'batter_total_bases',
  'batter_runs_scored',
  'batter_rbis',
]

/**
 * @param {Map<string, object>} marketsByKey
 * @param {string} baseKey - e.g. pitcher_strikeouts
 * @returns {{ outcomes: object[] } | null}
 */
function mergeMainAndAlternateMarkets(marketsByKey, baseKey) {
  const main = marketsByKey.get(baseKey)
  const altK = mlbAltMarketKey(baseKey)
  const alt = altK ? marketsByKey.get(altK) : null
  const outcomes = []
  if (main && Array.isArray(main.outcomes)) outcomes.push(...main.outcomes)
  if (alt && Array.isArray(alt.outcomes)) outcomes.push(...alt.outcomes)
  if (outcomes.length === 0) return null
  return { outcomes }
}

const MLB_SHOWCASE_MARKET_LABEL = {
  batter_home_runs: 'Home runs',
  batter_first_home_run: 'First home run',
  batter_hits: 'Hits',
  batter_total_bases: 'Total bases',
  batter_rbis: 'RBIs',
  batter_runs_scored: 'Runs scored',
  batter_hits_runs_rbis: 'Hits + runs + RBIs',
  batter_singles: 'Singles',
  batter_doubles: 'Doubles',
  batter_triples: 'Triples',
  batter_walks: 'Walks',
  batter_strikeouts: 'Batter strikeouts',
  batter_stolen_bases: 'Stolen bases',
  batter_fantasy_score: 'Batter fantasy (DFS)',
  pitcher_strikeouts: 'Pitcher strikeouts',
  pitcher_record_a_win: 'Pitcher to record a win',
  pitcher_hits_allowed: 'Pitcher hits allowed',
  pitcher_walks: 'Pitcher walks',
  pitcher_earned_runs: 'Pitcher earned runs',
  pitcher_outs: 'Pitcher outs',
}

/** Known names → MLB Stats API `people.id` for headshot CDN (optional). */
const MLB_NAME_TO_PEOPLE_ID = new Map(
  [
    ['juan soto', 665742],
    ['aaron judge', 592450],
    ['gerrit cole', 543037],
    /** Bobby Witt Jr. — 677951 (677950 is a different player; wrong id = wrong headshot). */
    ['bobby witt jr', 677951],
    ['bobby witt', 677951],
    ['robert witt jr', 677951],
    ['maikel garcia', 672580],
    ['salvador perez', 521692],
    ['shohei ohtani', 660271],
    ['corbin burnes', 669134],
    ['mookie betts', 605141],
    ['freddie freeman', 518692],
    ['ronald acuna jr', 660670],
    ['ronald acuna', 660670],
    ['vladimir guerrero jr', 665489],
    ['kyle tucker', 663656],
    ['jose ramirez', 608070],
    ['fernando tatis jr', 665487],
    ['matt olson', 621566],
    ['paul goldschmidt', 502671],
    ['pete alonso', 624413],
    ['yordan alvarez', 670541],
    ['kyle schwarber', 656941],
    ['corey seager', 608369],
    ['marcus semien', 543760],
    ['jacob degrom', 594798],
    ['spencer strider', 675911],
    ['zack wheeler', 554430],
    ['tarik skubal', 669373],
    ['randy arozarena', 668227],
    ['jose altuve', 514888],
    ['alex bregman', 608324],
    ['francisco lindor', 596019],
    ['vinnie pasquantino', 686474],
  ].map(([a, b]) => [a, b]),
)

let mlbShowcaseCache = {
  at: 0,
  /** @type {object | null} */
  payload: null,
}

/** Successful live props — long TTL to stay under The Odds API frequency limits. */
const MLB_SHOWCASE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Odds API event-odds calls are one per game; try several upcoming games because the
 * nearest scheduled game may not have player props posted yet for the showcase books.
 */
const MLB_SHOWCASE_MAX_EVENT_ATTEMPTS = 3
/** Empty / no lines — retry sooner without hammering the API. */
const MLB_SHOWCASE_EMPTY_TTL_MS = 30 * 60 * 1000
/** Bump when headshot IDs / payload shape changes so in-memory cache refreshes. */
const SHOWCASE_PAYLOAD_VERSION = 6

function mlbShowcaseCacheIsValid() {
  const { at, payload } = mlbShowcaseCache
  if (!payload || !at) return false
  if (Number(payload.showcasePayloadVersion) !== SHOWCASE_PAYLOAD_VERSION) return false
  const age = Date.now() - at
  if (payload.source === 'live' && Array.isArray(payload.props) && payload.props.length > 0) {
    return age < MLB_SHOWCASE_TTL_MS
  }
  if (payload.source === 'empty') {
    return age < MLB_SHOWCASE_EMPTY_TTL_MS
  }
  return false
}

function normalizePlayerNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveMlbPeopleId(playerName) {
  const k = normalizePlayerNameKey(playerName)
  if (!k) return null
  if (MLB_NAME_TO_PEOPLE_ID.has(k)) return MLB_NAME_TO_PEOPLE_ID.get(k)
  const noSuffix = k.replace(/\b(jr|sr|ii|iii|iv)\b/g, '').trim()
  if (noSuffix !== k && MLB_NAME_TO_PEOPLE_ID.has(noSuffix)) return MLB_NAME_TO_PEOPLE_ID.get(noSuffix)
  return null
}

const MLB_STATS_PEOPLE_SEARCH = 'https://statsapi.mlb.com/api/v1/people/search'

/** In-memory: at most one MLB Stats search per normalized name per day (per server process). */
const MLB_PEOPLE_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const mlbPeopleSearchDayCache = new Map()

/**
 * @param {string} normKey
 * @returns {undefined | number | null} undefined = miss; number = id; null = cached "not found"
 */
function peekMlbPeopleSearchCache(normKey) {
  if (!normKey) return undefined
  const e = mlbPeopleSearchDayCache.get(normKey)
  if (!e) return undefined
  if (Date.now() - e.at > MLB_PEOPLE_SEARCH_CACHE_TTL_MS) {
    mlbPeopleSearchDayCache.delete(normKey)
    return undefined
  }
  return e.id
}

/**
 * @param {string} normKey
 * @param {number | null} id
 */
function putMlbPeopleSearchCache(normKey, id) {
  if (!normKey) return
  mlbPeopleSearchDayCache.set(normKey, { id, at: Date.now() })
}

/**
 * Batch-resolve MLB Stats `people.id` for headshots (free, no key). Names come from Odds API strings.
 * Uses a 24h in-memory cache so repeat showcase loads do not call MLB Stats again for the same player.
 * @param {string[]} names
 * @returns {Promise<Map<string, number>>} normalized fullName key → id
 */
async function fetchMlbPeopleIdMapByNames(names) {
  const clean = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))]
  const out = new Map()
  if (clean.length === 0) return out

  const needFetch = []
  for (const name of clean) {
    const k = normalizePlayerNameKey(name)
    if (!k) continue
    const cached = peekMlbPeopleSearchCache(k)
    if (cached !== undefined) {
      if (typeof cached === 'number' && cached > 0) out.set(k, cached)
      continue
    }
    needFetch.push(name)
  }

  if (needFetch.length === 0) return out

  const CHUNK = 14
  for (let i = 0; i < needFetch.length; i += CHUNK) {
    const chunk = needFetch.slice(i, i + CHUNK)
    const url = new URL(MLB_STATS_PEOPLE_SEARCH)
    url.searchParams.set('names', chunk.join(','))
    try {
      const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
      if (!res.ok) continue
      const data = await res.json()
      for (const p of data.people || []) {
        const id = p.id
        const full = typeof p.fullName === 'string' ? p.fullName.trim() : ''
        if (!Number.isFinite(id) || !full) continue
        const k = normalizePlayerNameKey(full)
        if (!out.has(k)) out.set(k, id)
        putMlbPeopleSearchCache(k, id)
      }
    } catch {
      /* no negative cache — transient errors can retry next request */
    }
  }
  return out
}

/**
 * Resolve `mlbPlayerId` for every prop row: MLB Stats search first (accurate for any active player), then static map.
 * @param {Map<string, number>} idByNorm
 * @param {string} displayName
 * @returns {number | null}
 */
function resolveMlbIdForPlayerName(idByNorm, displayName) {
  const k = normalizePlayerNameKey(displayName)
  if (!k) return null
  if (idByNorm.has(k)) return idByNorm.get(k)
  const noSuf = k.replace(/\b(jr|sr|ii|iii|iv)\b/g, '').trim()
  if (noSuf !== k && idByNorm.has(noSuf)) return idByNorm.get(noSuf)
  const staticId = resolveMlbPeopleId(displayName)
  return typeof staticId === 'number' && staticId > 0 ? staticId : null
}

/**
 * Fill `mlbPlayerId` on prop rows using MLB Stats search (covers roster names from Odds API copy).
 * @param {{ key: string, title: string, props: object[] }[]} bookOptions
 */
async function enrichBookOptionsWithMlbPeopleIds(bookOptions) {
  const allNames = new Set()
  for (const bo of bookOptions) {
    for (const row of bo.props || []) {
      if (row && typeof row.name === 'string' && row.name.trim()) {
        allNames.add(row.name.trim())
      }
    }
  }
  if (allNames.size === 0) return bookOptions

  const idByNorm = await fetchMlbPeopleIdMapByNames([...allNames])

  return bookOptions.map((bo) => ({
    ...bo,
    props: (bo.props || []).map((row) => {
      const pid = resolveMlbIdForPlayerName(idByNorm, row.name)
      const next = { ...row }
      if (pid) next.mlbPlayerId = pid
      else delete next.mlbPlayerId
      return next
    }),
  }))
}

function formatAmericanOdds(price) {
  const n = Number(price)
  if (!Number.isFinite(n)) return '—'
  const r = Math.round(n)
  return r > 0 ? `+${r}` : `${r}`
}

/**
 * Implied win probability from American odds (ignores vig when shown per side).
 * @param {number} price
 * @returns {number | null}
 */
function impliedPercentFromAmerican(price) {
  const n = Number(price)
  if (!Number.isFinite(n) || n === 0) return null
  if (n > 0) return (100 / (n + 100)) * 100
  const a = Math.abs(n)
  return (a / (a + 100)) * 100
}

/**
 * @param {number} price
 * @returns {string} e.g. "+500 (16.7%)" or "-110 (52.4%)"
 */
function formatAmericanOddsWithImpliedPercent(price) {
  const label = formatAmericanOdds(price)
  const pct = impliedPercentFromAmerican(price)
  if (pct == null) return label
  const s = pct >= 99.95 ? pct.toFixed(0) : pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)
  return `${label} (${s}%)`
}

/**
 * @param {string} apiKey
 * @param {string} eventId
 */
async function fetchMlbEventPlayerPropsOdds(apiKey, eventId, req = null) {
  const id = String(eventId || '')
  if (!EVENT_ID_RE.test(id)) throw Object.assign(new Error('That event id is not valid.'), { status: 400 })
  // One upstream call per event per 10 minutes, whatever players, books or markets callers
  // ask about; every call is paid for out of the analyzer's daily credit budget.
  const hit = eventOddsCache.get(id)
  if (hit && Date.now() - hit.at < EVENT_ODDS_TTL_MS) return hit.promise
  const markets = mlbEventOddsMarketKeysForFetch()
  const p = (async () => {
    // Only games on the schedule (listing it is free) that start within two days can cost
    // credits: books post props late anyway, and it keeps the set of payable games small.
    const { events } = await fetchOddsEventsSafe(apiKey, ['baseball_mlb'])
    const ev = events.find((x) => x.id === id)
    if (!ev) throw Object.assign(new Error('That game isn’t on the MLB schedule right now.'), { status: 404, code: 'no_event' })
    const starts = Date.parse(ev.commence_time)
    if (!(starts < Date.now() + EVENT_ODDS_WINDOW_MS && starts > Date.now() - 6 * 3600_000)) {
      throw Object.assign(new Error('Player prop odds open up two days before a game.'), { status: 404, code: 'not_soon' })
    }
    const cost = markets.length
    // the budget hook says why when it refuses: this caller's share, or the whole day's pool
    const spend = oddsBudget ? await oddsBudget(cost, { req }) : { ok: true }
    const verdict = typeof spend === 'boolean' ? { ok: spend, reason: spend ? null : 'pool' } : spend
    if (!verdict.ok && verdict.reason === 'caller') {
      throw Object.assign(new Error('You’ve opened odds for several new games today. Games that are already open still load; this one opens for you tomorrow.'), { status: 429, code: 'odds_caller' })
    }
    if (!verdict.ok) {
      throw Object.assign(new Error('Live odds are paused until tomorrow: today’s Odds API budget is used up.'), { status: 503, code: 'odds_budget' })
    }
    // a call that didn't return odds gives its credits back
    const refund = () => (oddsBudget ? Promise.resolve(oddsBudget(-cost, { req })).catch(() => {}) : null)
    let res
    let text
    try {
      const url = new URL(`${ODDS_BASE}/sports/baseball_mlb/events/${encodeURIComponent(id)}/odds`)
      url.searchParams.set('apiKey', apiKey)
      url.searchParams.set('regions', 'us')
      url.searchParams.set('oddsFormat', 'american')
      url.searchParams.set('markets', markets.join(','))
      res = await fetch(url, { headers: { Accept: 'application/json' } })
      text = await res.text()
    } catch (e) {
      await refund()
      throw e
    }
    if (!res.ok) {
      await refund()
      throw new Error(parseOddsApiErrorMessage(text, res.status))
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Invalid JSON from Odds API (event odds)')
    }
  })()
  eventOddsCache.set(id, { at: Date.now(), promise: p })
  if (eventOddsCache.size > 300) eventOddsCache.delete(eventOddsCache.keys().next().value)
  // failures aren't cached (a budget refusal or an upstream error can clear up)
  p.catch(() => {
    if (eventOddsCache.get(id)?.promise === p) eventOddsCache.delete(id)
  })
  return p
}

/** Showcase dropdown: five popular US books (API `bookmaker.key`). */
const SHOWCASE_POPULAR_BOOK_KEYS = [
  'draftkings',
  'fanduel',
  'betmgm',
  'williamhill_us',
  'espnbet',
]

function bookDisplayTitle(bm, key) {
  if (bm && typeof bm.title === 'string' && bm.title.trim()) return bm.title.trim()
  const fallback = {
    draftkings: 'DraftKings',
    fanduel: 'FanDuel',
    betmgm: 'BetMGM',
    williamhill_us: 'Caesars',
    espnbet: 'ESPN Bet',
  }
  return fallback[key] || key
}

function playerNameFromOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return ''
  const d = outcome.description
  if (typeof d === 'string' && d.trim()) return d.trim()
  const n = outcome.name
  if (typeof n === 'string' && n.trim() && !/^(over|under)$/i.test(n.trim())) return n.trim()
  return ''
}

/**
 * Odds API `description` can differ slightly from model text (suffixes, spacing).
 * @param {object[]} outcomes
 * @param {string} playerDisplayName
 * @returns {string | null}
 */
function findBestMatchingPlayerNameFromOutcomes(outcomes, playerDisplayName) {
  if (!Array.isArray(outcomes) || !playerDisplayName) return null
  const want = normalizePlayerNameKey(playerDisplayName)
  if (!want) return null
  const unique = new Set()
  for (const o of outcomes) {
    const p = playerNameFromOutcome(o)
    if (p) unique.add(p)
  }
  for (const p of unique) {
    if (normalizePlayerNameKey(p) === want) return p
  }
  const lastTok = want.split(/\s+/).filter(Boolean).pop() || ''
  if (lastTok.length >= 3) {
    for (const p of unique) {
      const n = normalizePlayerNameKey(p)
      if (n.endsWith(lastTok)) return p
    }
  }
  for (const p of unique) {
    const n = normalizePlayerNameKey(p)
    if (n.includes(want) || want.includes(n)) return p
  }
  return null
}

/**
 * @param {object} m - Odds API market object
 * @param {string} wantKey - normalized player key
 * @returns {{ point: number, overPrice: number, underPrice: number }[]}
 */
function collectOuPairsForPlayerKey(m, wantKey) {
  if (!m || !Array.isArray(m.outcomes) || !wantKey) return []
  /** @type {Map<number, { over?: number, under?: number }>} */
  const points = new Map()
  for (const o of m.outcomes) {
    if (!o || typeof o !== 'object') continue
    const player = playerNameFromOutcome(o)
    if (!player || normalizePlayerNameKey(player) !== wantKey) continue
    const point = typeof o.point === 'number' && Number.isFinite(o.point) ? o.point : null
    if (point === null) continue
    const side = String(o.name || '').toLowerCase()
    if (side !== 'over' && side !== 'under') continue
    const price = Number(o.price)
    if (!Number.isFinite(price)) continue
    if (!points.has(point)) points.set(point, {})
    const cell = points.get(point)
    if (side === 'over') cell.over = price
    else cell.under = price
  }
  const pairs = []
  for (const [pt, cell] of points) {
    if (cell.over != null && cell.under != null) {
      pairs.push({ point: pt, overPrice: cell.over, underPrice: cell.under })
    }
  }
  return pairs
}

/**
 * All O/U points for one player in a player-prop market (Over + Under per point).
 * Implied line = point where |overAmerican − underAmerican| is smallest.
 * @param {object} m - Odds API market object
 * @param {string} playerDisplayName
 * @returns {{ ouLadder: { point: number, overPrice: number, underPrice: number, overLabel: string, underLabel: string }[], impliedPoint: number } | null}
 */
function extractSinglePlayerOuLadderFromMarket(m, playerDisplayName) {
  if (!m || !Array.isArray(m.outcomes) || !playerDisplayName) return null
  let want = normalizePlayerNameKey(playerDisplayName)
  if (!want) return null

  let pairs = collectOuPairsForPlayerKey(m, want)
  if (pairs.length === 0) {
    const resolved = findBestMatchingPlayerNameFromOutcomes(m.outcomes, playerDisplayName)
    if (resolved) {
      want = normalizePlayerNameKey(resolved)
      pairs = collectOuPairsForPlayerKey(m, want)
    }
  }
  if (pairs.length === 0) return null
  pairs.sort((a, b) => a.point - b.point)

  let impliedPoint = pairs[0].point
  let bestDiff = Infinity
  for (const p of pairs) {
    const d = Math.abs(p.overPrice - p.underPrice)
    if (d < bestDiff) {
      bestDiff = d
      impliedPoint = p.point
    }
  }

  return {
    ouLadder: pairs.map((p) => ({
      point: p.point,
      overPrice: p.overPrice,
      underPrice: p.underPrice,
      overLabel: formatAmericanOddsWithImpliedPercent(p.overPrice),
      underLabel: formatAmericanOddsWithImpliedPercent(p.underPrice),
    })),
    impliedPoint,
  }
}

/**
 * Yes/No player props (e.g. first HR, pitcher win) — Odds API uses outcome names Yes/No.
 * @param {object} m - market object
 * @param {string} playerDisplayName
 * @returns {{ yesLabel: string, noLabel: string } | null}
 */
function extractYesNoPricesForPlayer(m, playerDisplayName) {
  if (!m || !Array.isArray(m.outcomes) || !playerDisplayName) return null
  let want = normalizePlayerNameKey(playerDisplayName)
  const resolved = findBestMatchingPlayerNameFromOutcomes(m.outcomes, playerDisplayName)
  if (resolved) want = normalizePlayerNameKey(resolved)
  let yesPrice
  let noPrice
  for (const o of m.outcomes) {
    const p = playerNameFromOutcome(o)
    if (!p) continue
    if (normalizePlayerNameKey(p) !== want) continue
    const side = String(o.name || '').toLowerCase()
    const price = Number(o.price)
    if (!Number.isFinite(price)) continue
    if (side === 'yes') yesPrice = price
    if (side === 'no') noPrice = price
  }
  if (yesPrice == null && noPrice == null) return null
  return {
    yesLabel: yesPrice != null ? formatAmericanOddsWithImpliedPercent(yesPrice) : '—',
    noLabel: noPrice != null ? formatAmericanOddsWithImpliedPercent(noPrice) : '—',
  }
}

/**
 * @param {Map<string, object>} marketsByKey
 * @param {string} playerName
 * @returns {{ ouMarkets: object[], yesNoMarkets: object[] }}
 */
function collectAllMlbPlayerPropLinesForPlayer(marketsByKey, playerName) {
  /** @type {object[]} */
  const ouMarkets = []
  for (const baseKey of MLB_OU_PLAYER_PROP_KEYS) {
    const merged = mergeMainAndAlternateMarkets(marketsByKey, baseKey)
    if (!merged) continue
    const pack = extractSinglePlayerOuLadderFromMarket(merged, playerName)
    if (!pack || !Array.isArray(pack.ouLadder) || pack.ouLadder.length === 0) continue
    ouMarkets.push({
      marketKey: baseKey,
      marketTitle: `${MLB_SHOWCASE_MARKET_LABEL[baseKey] || baseKey} (O/U)`,
      ouLadder: pack.ouLadder,
      impliedPoint: pack.impliedPoint,
    })
  }
  ouMarkets.sort((a, b) => String(a.marketTitle).localeCompare(String(b.marketTitle)))

  /** @type {object[]} */
  const yesNoMarkets = []
  for (const ynKey of MLB_YESNO_PLAYER_PROP_KEYS) {
    const m = marketsByKey.get(ynKey)
    if (!m) continue
    const yn = extractYesNoPricesForPlayer(m, playerName)
    if (!yn) continue
    yesNoMarkets.push({
      marketKey: ynKey,
      marketTitle: MLB_SHOWCASE_MARKET_LABEL[ynKey] || ynKey,
      yesLabel: yn.yesLabel,
      noLabel: yn.noLabel,
    })
  }
  yesNoMarkets.sort((a, b) => String(a.marketTitle).localeCompare(String(b.marketTitle)))

  return { ouMarkets, yesNoMarkets }
}

/**
 * Pitcher K market: collect every O/U point with both sides (alts + main). Implied line = point
 * where American Over and Under are closest (book’s fairish rung).
 * @param {object} m - Odds API market object
 * @param {string} matchupShort
 * @param {Set<string>} seen
 * @param {number} maxPlayers
 */
function buildPitcherStrikeoutLadderRowsFromMarket(m, matchupShort, seen, maxPlayers = 3) {
  if (!m || !Array.isArray(m.outcomes)) return []

  const displayNames = new Set()
  for (const o of m.outcomes) {
    const player = playerNameFromOutcome(o)
    if (player) displayNames.add(player)
  }

  const ranked = []
  for (const display of displayNames) {
    const pack = extractSinglePlayerOuLadderFromMarket(m, display)
    if (pack && pack.ouLadder.length > 0) {
      ranked.push({ display, n: pack.ouLadder.length, pack })
    }
  }
  ranked.sort((a, b) => b.n - a.n)

  const rows = []
  for (const { display, pack } of ranked) {
    if (rows.length >= maxPlayers) break
    const pk = normalizePlayerNameKey(display)
    const dedupe = `${pk}|pitcher_strikeouts|ladder`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)

    const pid = resolveMlbPeopleId(display)
    rows.push({
      name: display,
      meta: matchupShort,
      prop: 'Pitcher strikeouts (O/U)',
      propMarketKey: 'pitcher_strikeouts',
      ouLadder: pack.ouLadder,
      impliedPoint: pack.impliedPoint,
      ...(pid ? { mlbPlayerId: pid } : {}),
    })
  }
  return rows
}

/** In-memory ladder responses — avoids repeat Odds API event-odds calls for the same analyzed game. */
const MLB_PROP_LADDER_CACHE_TTL_OK_MS = 6 * 60 * 60 * 1000
const MLB_PROP_LADDER_CACHE_TTL_MISS_MS = 20 * 60 * 1000
const MLB_PROP_LADDER_CACHE_MAX = 280
/** @type {Map<string, { at: number, ok: boolean, payload: object }>} */
const mlbPropLadderCache = new Map()

const MLB_PROPS_BOARD_CACHE_TTL_OK_MS = 6 * 60 * 60 * 1000
const MLB_PROPS_BOARD_CACHE_TTL_MISS_MS = 20 * 60 * 1000
const MLB_PROPS_BOARD_CACHE_MAX = 120
/** @type {Map<string, { at: number, ok: boolean, payload: object }>} */
const mlbPropsBoardCache = new Map()

function propLadderCacheKey(eventId, playerNorm, market, bookKey) {
  return `${eventId}|${playerNorm}|${market}|${bookKey}`
}

function rememberPropLadder(ck, ok, payload) {
  mlbPropLadderCache.set(ck, { at: Date.now(), ok, payload })
  while (mlbPropLadderCache.size > MLB_PROP_LADDER_CACHE_MAX) {
    const first = mlbPropLadderCache.keys().next().value
    mlbPropLadderCache.delete(first)
  }
}

function propsBoardCacheKey(eventId, bookKey, sortedPlayerNormKeys) {
  return `${eventId}|${bookKey}|${sortedPlayerNormKeys.join('\u0001')}`
}

function rememberPropsBoard(ck, ok, payload) {
  mlbPropsBoardCache.set(ck, { at: Date.now(), ok, payload })
  while (mlbPropsBoardCache.size > MLB_PROPS_BOARD_CACHE_MAX) {
    const first = mlbPropsBoardCache.keys().next().value
    mlbPropsBoardCache.delete(first)
  }
}

/**
 * GET /api/odds/mlb-player-props-board — all MLB O/U + Yes/No player props for named players (main + alt lines merged per market).
 * One Odds API event-odds call per request (cached).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string | undefined} apiKey
 */
export async function handleMlbPlayerPropsBoardRequest(req, res, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) {
    res.status(503).json({
      error: 'THE_ODDS_API_KEY is not set (backend/.env or Cloud Function secret).',
    })
    return
  }

  const disabled = await getDisabledSportKeys()
  if (disabled.includes('baseball_mlb')) {
    res.status(403).json({ error: 'MLB is temporarily unavailable.' })
    return
  }

  const eventId = typeof req.query.eventId === 'string' ? req.query.eventId.trim() : ''
  const playersRaw = typeof req.query.players === 'string' ? req.query.players : ''
  const bookKey =
    typeof req.query.book === 'string' && req.query.book.trim() ? req.query.book.trim() : 'draftkings'

  /** @type {string[]} */
  const playerList = []
  const seen = new Set()
  for (const part of playersRaw.split(',')) {
    const t = part.trim()
    if (!t) continue
    const nk = normalizePlayerNameKey(t)
    if (seen.has(nk)) continue
    seen.add(nk)
    playerList.push(t)
    if (playerList.length >= 12) break
  }

  if (!eventId) {
    res.status(400).json({ error: 'Missing eventId (select a game from the schedule first).' })
    return
  }
  if (playerList.length === 0) {
    res.status(400).json({ error: 'Missing players (comma-separated names from certified picks).' })
    return
  }

  const normSorted = [...playerList].map(normalizePlayerNameKey).filter(Boolean).sort()
  const ck = propsBoardCacheKey(eventId, bookKey, normSorted)
  const hit = mlbPropsBoardCache.get(ck)
  if (hit) {
    const ttl = hit.ok ? MLB_PROPS_BOARD_CACHE_TTL_OK_MS : MLB_PROPS_BOARD_CACHE_TTL_MISS_MS
    if (Date.now() - hit.at < ttl) {
      res.set('Cache-Control', 'public, max-age=3600')
      return res.json({ ...hit.payload, cached: true })
    }
    mlbPropsBoardCache.delete(ck)
  }

  try {
    const oddsJson = await fetchMlbEventPlayerPropsOdds(key, eventId, req)
    const byKey = new Map((oddsJson.bookmakers || []).map((b) => [b.key, b]))
    const bm = byKey.get(bookKey) || byKey.get('draftkings')
    if (!bm) {
      const miss = {
        ok: false,
        players: [],
        message: 'That sportsbook has no lines for this game yet.',
      }
      rememberPropsBoard(ck, false, miss)
      res.set('Cache-Control', 'public, max-age=600')
      return res.json(miss)
    }

    const marketsByKey = new Map((bm.markets || []).map((mm) => [mm.key, mm]))
    const idMap = await fetchMlbPeopleIdMapByNames(playerList)

    const players = playerList.map((player) => {
      const { ouMarkets, yesNoMarkets } = collectAllMlbPlayerPropLinesForPlayer(marketsByKey, player)
      const mlbPlayerId = resolveMlbIdForPlayerName(idMap, player)
      return {
        player,
        ...(typeof mlbPlayerId === 'number' && mlbPlayerId > 0 ? { mlbPlayerId } : {}),
        ouMarkets,
        yesNoMarkets,
      }
    })

    const okPayload = {
      ok: true,
      eventId,
      bookKey,
      bookTitle: bookDisplayTitle(bm, bookKey),
      players,
    }
    rememberPropsBoard(ck, true, okPayload)
    res.set('Cache-Control', 'public, max-age=3600')
    res.json(okPayload)
  } catch (e) {
    res.status(e?.status || 502).json({ error: e?.message || String(e), ...(e?.code ? { code: e.code } : {}) })
  }
}

/**
 * GET /api/odds/mlb-prop-ladder — O/U ladder for one player + market + book (analyze page panel).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string | undefined} apiKey
 */
export async function handleMlbPropLadderRequest(req, res, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) {
    res.status(503).json({
      error: 'THE_ODDS_API_KEY is not set (backend/.env or Cloud Function secret).',
    })
    return
  }

  const disabled = await getDisabledSportKeys()
  if (disabled.includes('baseball_mlb')) {
    res.status(403).json({ error: 'MLB is temporarily unavailable.' })
    return
  }

  const eventId = typeof req.query.eventId === 'string' ? req.query.eventId.trim() : ''
  const player = typeof req.query.player === 'string' ? req.query.player.trim() : ''
  const market =
    typeof req.query.market === 'string' && req.query.market.trim()
      ? req.query.market.trim()
      : 'pitcher_strikeouts'
  const bookKey =
    typeof req.query.book === 'string' && req.query.book.trim() ? req.query.book.trim() : 'draftkings'

  if (!eventId) {
    res.status(400).json({ error: 'Missing eventId (select a game from the schedule first).' })
    return
  }
  if (!player) {
    res.status(400).json({ error: 'Missing player name.' })
    return
  }
  if (!MLB_OU_PLAYER_PROP_KEYS.includes(market)) {
    res.status(400).json({ error: `Invalid market. Use one of: ${MLB_OU_PLAYER_PROP_KEYS.join(', ')}` })
    return
  }

  const ck = propLadderCacheKey(eventId, normalizePlayerNameKey(player), market, bookKey)
  const hit = mlbPropLadderCache.get(ck)
  if (hit) {
    const ttl = hit.ok ? MLB_PROP_LADDER_CACHE_TTL_OK_MS : MLB_PROP_LADDER_CACHE_TTL_MISS_MS
    if (Date.now() - hit.at < ttl) {
      res.set('Cache-Control', 'public, max-age=3600')
      return res.json({ ...hit.payload, cached: true })
    }
    mlbPropLadderCache.delete(ck)
  }

  try {
    const oddsJson = await fetchMlbEventPlayerPropsOdds(key, eventId, req)
    const byKey = new Map((oddsJson.bookmakers || []).map((b) => [b.key, b]))
    const bm = byKey.get(bookKey) || byKey.get('draftkings')
    if (!bm) {
      const miss = {
        ok: false,
        ouLadder: null,
        message: 'That sportsbook has no lines for this game yet.',
      }
      rememberPropLadder(ck, false, miss)
      res.set('Cache-Control', 'public, max-age=600')
      return res.json(miss)
    }

    const marketsByKey = new Map((bm.markets || []).map((mm) => [mm.key, mm]))
    const merged = mergeMainAndAlternateMarkets(marketsByKey, market)
    if (!merged) {
      const miss = {
        ok: false,
        ouLadder: null,
        message: 'Market not posted for this game yet.',
      }
      rememberPropLadder(ck, false, miss)
      res.set('Cache-Control', 'public, max-age=600')
      return res.json(miss)
    }

    const pack = extractSinglePlayerOuLadderFromMarket(merged, player)
    if (!pack) {
      const miss = {
        ok: false,
        ouLadder: null,
        message: 'No paired Over/Under lines found for that player in this market.',
      }
      rememberPropLadder(ck, false, miss)
      res.set('Cache-Control', 'public, max-age=600')
      return res.json(miss)
    }

    const idMap = await fetchMlbPeopleIdMapByNames([player])
    const mlbPlayerId = resolveMlbIdForPlayerName(idMap, player)

    const okPayload = {
      ok: true,
      bookKey,
      bookTitle: bookDisplayTitle(bm, bookKey),
      marketKey: market,
      marketTitle: `${MLB_SHOWCASE_MARKET_LABEL[market] || market} (O/U)`,
      player,
      ...(typeof mlbPlayerId === 'number' && mlbPlayerId > 0 ? { mlbPlayerId } : {}),
      ouLadder: pack.ouLadder,
      impliedPoint: pack.impliedPoint,
    }
    rememberPropLadder(ck, true, okPayload)
    res.set('Cache-Control', 'public, max-age=3600')
    res.json(okPayload)
  } catch (e) {
    res.status(e?.status || 502).json({ error: e?.message || String(e), ...(e?.code ? { code: e.code } : {}) })
  }
}

/**
 * @param {object} bm - single bookmaker object from event odds
 * @param {string} matchupShort
 * @param {number} maxProps
 */
function buildMlbShowcasePropsFromBookmaker(bm, matchupShort, maxProps = 8) {
  if (!bm || !Array.isArray(bm.markets)) return []

  const marketsByKey = new Map(bm.markets.map((m) => [m.key, m]))
  const out = []
  const seen = new Set()

  const ksMerged = mergeMainAndAlternateMarkets(marketsByKey, 'pitcher_strikeouts')
  if (ksMerged) {
    const ladderCap = Math.min(3, maxProps)
    const ladderRows = buildPitcherStrikeoutLadderRowsFromMarket(
      ksMerged,
      matchupShort,
      seen,
      ladderCap,
    )
    for (const row of ladderRows) {
      if (out.length >= maxProps) break
      out.push(row)
    }
  }

  for (const key of MLB_SHOWCASE_CAROUSEL_MARKETS) {
    if (key === 'pitcher_strikeouts') continue
    if (out.length >= maxProps) break
    const m = marketsByKey.get(key)
    if (!m || !Array.isArray(m.outcomes)) continue
    const label = MLB_SHOWCASE_MARKET_LABEL[key] || key
    for (const o of m.outcomes) {
      if (out.length >= maxProps) break
      if (!o || String(o.name).toLowerCase() !== 'over') continue
      const player = playerNameFromOutcome(o)
      if (!player) continue
      const point = o.point
      const pointStr = typeof point === 'number' && Number.isFinite(point) ? String(point) : '—'
      const dedupe = `${normalizePlayerNameKey(player)}|${key}|${pointStr}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const pid = resolveMlbPeopleId(player)
      out.push({
        name: player,
        meta: matchupShort,
        prop: `${label} O/U ${pointStr}`,
        odds: 'Over',
        line: formatAmericanOddsWithImpliedPercent(o.price),
        ...(pid ? { mlbPlayerId: pid } : {}),
      })
    }
  }

  return out
}

/**
 * Build props for each popular book that has lines (one Odds API response — no extra requests).
 * @param {object} eventOdds
 * @param {number} maxProps
 */
function buildMlbShowcaseBookOptionsFromEventOdds(eventOdds, maxProps = 8) {
  const away = typeof eventOdds.away_team === 'string' ? eventOdds.away_team : 'Away'
  const home = typeof eventOdds.home_team === 'string' ? eventOdds.home_team : 'Home'
  const matchupShort = `${away.slice(0, 22)}${away.length > 22 ? '…' : ''} @ ${home.slice(0, 22)}${home.length > 22 ? '…' : ''}`

  const byKey = new Map((eventOdds.bookmakers || []).map((b) => [b.key, b]))
  const bookOptions = []
  for (const bookKey of SHOWCASE_POPULAR_BOOK_KEYS) {
    const bm = byKey.get(bookKey)
    if (!bm) continue
    const props = buildMlbShowcasePropsFromBookmaker(bm, matchupShort, maxProps)
    if (props.length === 0) continue
    bookOptions.push({
      key: bookKey,
      title: bookDisplayTitle(bm, bookKey),
      props,
    })
  }

  // Prefer DraftKings as default tab when that book has lines (matches ladder test / common US flow).
  bookOptions.sort((a, b) => {
    if (a.key === 'draftkings') return -1
    if (b.key === 'draftkings') return 1
    return 0
  })

  return { matchup: matchupShort, bookOptions }
}

/**
 * GET /api/odds/mlb-player-props-showcase — real MLB player prop lines for the featured ticker.
 * Server cache (~10m) avoids repeated Odds API event-odds calls (each call costs quota).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string | undefined} apiKey
 */
export async function handleMlbPlayerPropsShowcaseRequest(req, res, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) {
    res.status(503).json({
      error: 'THE_ODDS_API_KEY is not set (backend/.env or Cloud Function secret).',
    })
    return
  }

  const disabled = await getDisabledSportKeys()
  if (disabled.includes('baseball_mlb')) {
    res.set('Cache-Control', 'public, max-age=120')
    res.json({
      showcasePayloadVersion: SHOWCASE_PAYLOAD_VERSION,
      source: 'empty',
      cached: false,
      props: [],
      message: 'MLB is temporarily unavailable.',
    })
    return
  }

  if (mlbShowcaseCacheIsValid()) {
    res.set('Cache-Control', 'public, max-age=3600')
    res.json({ ...mlbShowcaseCache.payload, cached: true })
    return
  }

  try {
    const { events: raw, errors } = await fetchOddsEventsSafe(key, ['baseball_mlb'])
    if (raw.length === 0 && errors.length > 0) {
      const hint = errors[0]?.message || 'Odds API returned no MLB events.'
      const rateLimited = /rate limit/i.test(hint)
      const payload = {
        showcasePayloadVersion: SHOWCASE_PAYLOAD_VERSION,
        source: 'empty',
        cached: false,
        props: [],
        message: rateLimited
          ? 'Odds feed is busy — showing sample lines. Try again shortly.'
          : `${hint} Showing samples.`,
      }
      mlbShowcaseCache = { at: Date.now(), payload }
      res.set('Cache-Control', 'public, max-age=300')
      res.status(200).json(payload)
      return
    }

    const t0 = Date.now()
    const upcoming = raw
      .filter((ev) => {
        const t = new Date(ev.commence_time).getTime()
        return Number.isFinite(t) && t > t0 - 120_000
      })
      .sort((a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime())

    if (upcoming.length === 0) {
      const payload = {
        showcasePayloadVersion: SHOWCASE_PAYLOAD_VERSION,
        source: 'empty',
        cached: false,
        props: [],
        message: 'No upcoming MLB games with props right now.',
      }
      mlbShowcaseCache = { at: Date.now(), payload }
      res.set('Cache-Control', 'public, max-age=60')
      res.json(payload)
      return
    }

    let lastErr = null
    /** Up to N event-odds calls per refresh until we find lines (quota vs reliability). */
    for (let i = 0; i < Math.min(MLB_SHOWCASE_MAX_EVENT_ATTEMPTS, upcoming.length); i++) {
      const ev = upcoming[i]
      const eventId = typeof ev.id === 'string' ? ev.id : ''
      if (!eventId) continue
      try {
        const oddsJson = await fetchMlbEventPlayerPropsOdds(key, eventId, req)
        let { matchup, bookOptions } = buildMlbShowcaseBookOptionsFromEventOdds(oddsJson, 8)
        if (bookOptions.length > 0) {
          bookOptions = await enrichBookOptionsWithMlbPeopleIds(bookOptions)
          const dk = bookOptions.find((b) => b.key === 'draftkings')
          const first = dk || bookOptions[0]
          const payload = {
            showcasePayloadVersion: SHOWCASE_PAYLOAD_VERSION,
            source: 'live',
            cached: false,
            eventId,
            commenceTime: oddsJson.commence_time || ev.commence_time || null,
            matchup,
            bookOptions,
            defaultBookKey: first.key,
            bookmaker: first.key,
            props: first.props,
          }
          mlbShowcaseCache = { at: Date.now(), payload }
          res.set('Cache-Control', 'public, max-age=3600')
          res.json({ ...payload, cached: false })
          return
        }
      } catch (e) {
        lastErr = e
        if (e?.code === 'odds_budget' || e?.code === 'odds_caller') break
      }
    }

    const payload = {
      showcasePayloadVersion: SHOWCASE_PAYLOAD_VERSION,
      source: 'empty',
      cached: false,
      props: [],
      message:
        typeof lastErr?.message === 'string' && lastErr.message.trim()
          ? lastErr.message.trim()
          : 'No live player props for the games we tried — the carousel uses sample lines.',
    }
    mlbShowcaseCache = { at: Date.now(), payload }
    res.set('Cache-Control', 'public, max-age=60')
    res.json(payload)
  } catch (e) {
    const msg =
      typeof e?.message === 'string' && e.message.length < 300
        ? e.message
        : 'Could not load live player props right now.'
    const payload = {
      showcasePayloadVersion: SHOWCASE_PAYLOAD_VERSION,
      source: 'empty',
      cached: false,
      props: [],
      message: /rate limit/i.test(msg)
        ? 'Odds feed is busy — showing sample lines. Try again shortly.'
        : `${msg} Showing samples.`,
    }
    mlbShowcaseCache = { at: Date.now(), payload }
    res.set('Cache-Control', 'public, max-age=300')
    res.status(200).json(payload)
  }
}

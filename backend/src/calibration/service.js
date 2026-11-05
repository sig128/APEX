// The public calibration page: when the model gives a prop 70%, does it hit 70% of the time?
//
// Everything comes from the prop log (src/nfl/proplog.js), which this module only reads:
//   proplog-<league> / index        { all, open }: the days on file, and the ones still waiting
//   proplog-<league> / YYYY-MM-DD   one game day (US Eastern): every row, `done` once all are graded
//   propsum-<league> / YYYY-MM      the monthly summaries (read through proplog.summaries): which
//                                   days were closed, and their totals to reconcile against
// The summaries alone can't draw this page: their probability buckets stop at "85 or more",
// don't split by prop type, have no first-look basis, count no voids per bucket, and put yes-only
// props under 50% (anytime scorer) in the 50 bucket. So each closed day is read once, raw, and
// boiled down to counts this module keeps in namespaces of its own:
//   calday-<league> / YYYY-MM       { days: { day: counts } }: per basis, prop type and band:
//                                   wins, losses, pushes, voids, postponed, and the ratings summed.
//                                   Derived data: rebuilt from the raw day whenever it's missing.
//   calfp-<league>  / YYYY-MM       { days: { day: fingerprint }, mismatch: { day: ... } }: the
//                                   SHA-256 of the closed day's graded rows, written once and never
//                                   replaced. A later read that hashes differently is kept beside
//                                   it (first one only) and reported, never written over it.
//
// Fingerprint format "propify-calibration-v1" (the same text GET /day/:league/:day?format=text
// returns):
//   1. Every row of the closed day. All of them are graded: res is w, l, p (push) or v (void).
//   2. Each row is one line: JSON.stringify([id, p, p0, t0, t1, res, val]). Compact JSON, no
//      spaces; numbers as JavaScript writes them (p and p0 have at most three decimals, t0 and t1
//      are whole milliseconds since 1970 UTC, val is the stat); a missing value is null.
//   3. The lines are sorted as plain strings. Each starts with the id, so this is id order (ids are
//      digits, letters, '.', '-' and 't'); two rows with the same id fall back on the rest of the line.
//   4. Joined with "\n", with a "\n" after the last line. SHA-256 over the UTF-8 bytes, written as
//      64 lowercase hex digits. A day with no rows is the empty text.
import crypto from 'node:crypto'
import { COLS, dayET } from '../nfl/proplog.js'
import { parsePropId } from '../nfl/analytics/core.js'
import { MARKETS, TEAM_MARKETS } from '../nfl/markets.js'
import { SPORTS } from '../sports/index.js'
import { marketLabels } from '../admin/metrics.js'
import { ApiError } from '../lib/router.js'
import { mapLimit } from '../lib/util.js'
import { log, errText } from '../lib/log.js'

export const FORMAT = 'propify-calibration-v1'
export const FIELDS = ['id', 'p', 'p0', 't0', 't1', 'res', 'val']
/** A band needs this many graded props (wins plus losses) before its hit rate means much. */
export const SMALL = 30
/** Bands of the probability, by their lower edge: 50-55, 55-60, ... 85-90, and 90 or more. */
export const BANDS = ['50', '55', '60', '65', '70', '75', '80', '85', '90']
export const WINDOWS = ['30d', '90d', 'season', 'all']
export const BASES = {
  p: 'The final pre-game probability: the last look before the game started.',
  p0: 'The first probability seen: the first look at the line.',
}

const C = Object.fromEntries(COLS.map((k, i) => [k, i]))
const DAY = 86_400_000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/
const DIGEST_V = 1
const TTL = 60_000
const PER_REQUEST = 24 // closed days one request may boil down on the spot; the rest wait for the next
const RETRY_MS = 10 * 60_000 // a day that turned out not closed is looked at again after this
const NS_LOG = (s) => `proplog-${s}`
const NS_SUM = (s) => `propsum-${s}`
const NS_DAY = (s) => `calday-${s}`
const NS_FP = (s) => `calfp-${s}`
// winter leagues write a season as two years (the frontend's seasonLabel does the same)
const SPANS = new Set(['nba', 'nhl', 'ncaab'])
const MARKET_LABELS = marketLabels()

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : null)
const pad2 = (n) => String(n).padStart(2, '0')
const zero = () => [0, 0, 0, 0, 0, 0]
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const dayText = (d) => dayFmt.format(new Date(`${d}T12:00:00Z`))

export const shiftDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
export const isDay = (d) => typeof d === 'string' && DAY_RE.test(d) && Number.isFinite(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d

function monthsBetween(from, to) {
  const out = []
  let [y, m] = from.slice(0, 7).split('-').map(Number)
  const [ty, tm] = to.slice(0, 7).split('-').map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad2(m)}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

// ---- seasons ---------------------------------------------------------------------------------

/** The month a league's season year starts: the first month after its usual off months. */
export function seasonStartMonth(sport) {
  const off = new Set(SPORTS[sport]?.offseason || [])
  for (let m = 1; m <= 12; m++) if (off.has(m) && !off.has((m % 12) + 1)) return (m % 12) + 1
  return 1
}
/** The season a day belongs to, named by the year it started (NBA 2026-27 is 2026). */
export function seasonOf(sport, day) {
  const s = seasonStartMonth(sport)
  const y = Number(day.slice(0, 4))
  return Number(day.slice(5, 7)) >= s ? y : y - 1
}
/** A season's days: twelve months from its start month (the off months included, empty). */
export function seasonRange(sport, year) {
  const s = seasonStartMonth(sport)
  return { from: `${year}-${pad2(s)}-01`, to: shiftDay(`${year + 1}-${pad2(s)}-01`, -1) }
}
export const seasonLabel = (sport, year) => (SPANS.has(sport) ? `${year}-${String((year + 1) % 100).padStart(2, '0')}` : String(year))

// ---- one closed day --------------------------------------------------------------------------

/** The band a probability falls in ('50' ... '90'), 'lo' under 50%, null when there is none. */
export function bandOf(p) {
  if (!Number.isFinite(p)) return null
  const pm = Math.round(p * 1000) // the log keeps three decimals: whole thousandths, no float edges
  if (pm < 500) return 'lo'
  if (pm >= 900) return '90'
  return String(Math.floor(pm / 50) * 5)
}
export function bandLabel(key) {
  if (key === '90') return '90% or more'
  if (key === 'lo') return 'Under 50%'
  if (BANDS.includes(key)) return `${key} to ${Number(key) + 5}%`
  return { all: '50% or more', mv: 'First look at another line', na: 'No probability' }[key] || String(key)
}

const asRow = (r) => (Array.isArray(r) ? Object.fromEntries(COLS.map((k, i) => [k, r[i] ?? null])) : r)
const GRADED = new Set(['w', 'l', 'p', 'v'])

/** The fingerprint's lines for a day's rows (log arrays or row objects), in order. */
export function canonicalLines(rows) {
  return rows
    .map(asRow)
    .filter((r) => GRADED.has(r.res))
    .map((r) => JSON.stringify(FIELDS.map((k) => r[k] ?? null)))
    .sort()
}
export const canonicalText = (lines) => (lines.length ? `${lines.join('\n')}\n` : '')
export const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** Games where every row came back void never had a final we could read: postponed or called off. */
function postponedGames(rows) {
  const by = new Map()
  for (const r of rows) {
    const s = by.get(r[C.game]) || { n: 0, v: 0 }
    s.n++
    if (r[C.res] === 'v') s.v++
    by.set(r[C.game], s)
  }
  return new Set([...by].filter(([, s]) => s.n === s.v).map(([g]) => g))
}

/** w, l, p, v (void) or pp (void because the game had no final), as a counts index. */
function slotOf(r, postponed) {
  const res = r[C.res]
  if (res === 'w') return 0
  if (res === 'l') return 1
  if (res === 'p') return 2
  if (res === 'v') return postponed.has(r[C.game]) ? 4 : 3
  return -1
}

function addCell(tree, market, band, slot, p) {
  const m = (tree[market] ||= {})
  const c = (m[band] ||= zero())
  c[slot]++
  if (slot <= 1 && Number.isFinite(p)) c[5] += Math.round(p * 1000)
}

/**
 * A closed day in counts. For each basis (p: final probability, p0: first look), prop type and
 * band: [wins, losses, pushes, voids, postponed, sum of the ratings over wins and losses in
 * thousandths]. Bands: '50'...'90', 'lo' (under 50%), 'na' (no probability), and for the first look
 * 'mv' (the line moved after it, so that probability was for another bet). totals: the same five
 * counts over every row, to reconcile with the log's own summary.
 */
export function digestDay(doc) {
  const rows = Object.values(doc?.rows || {})
  const postponed = postponedGames(rows)
  const out = { v: DIGEST_V, rows: rows.length, totals: [0, 0, 0, 0, 0], p: {}, p0: {} }
  for (const r of rows) {
    const slot = slotOf(r, postponed)
    if (slot < 0) continue
    out.totals[slot]++
    const id = parsePropId(r[C.id])
    const market = id?.market || 'other'
    addCell(out.p, market, bandOf(r[C.p]) ?? 'na', slot, r[C.p])
    const sameLine = id != null && r[C.line0] != null && Number(r[C.line0]) === id.line
    addCell(out.p0, market, sameLine ? (bandOf(r[C.p0]) ?? 'na') : 'mv', slot, r[C.p0])
  }
  return out
}

/** The day's rows as the public sees them, each with its fingerprint line, in fingerprint order. */
function publicRows(doc) {
  const rows = Object.values(doc?.rows || {})
  const postponed = postponedGames(rows)
  return rows
    .filter((a) => GRADED.has(a[C.res]))
    .map((a) => {
      const r = asRow(a)
      const id = parsePropId(r.id)
      const subject = id?.playerId || (id?.teamId ? `t${id.teamId}` : null)
      const pl = doc.pl?.[subject] || []
      const g = doc.games?.[r.game] || {}
      const mk = MARKETS[id?.market] || TEAM_MARKETS[id?.market] || {}
      return {
        ser: JSON.stringify(FIELDS.map((k) => r[k] ?? null)),
        row: {
          ...Object.fromEntries(FIELDS.map((k) => [k, r[k] ?? null])),
          band: bandOf(r.p),
          postponed: r.res === 'v' && postponed.has(a[C.game]),
          gameId: r.game,
          game: g.n || null,
          kickoff: g.k || null,
          name: pl[0] || null,
          team: pl[1] || null,
          opp: pl[2] || null,
          market: id?.market || null,
          marketLabel: MARKET_LABELS[id?.market] || mk.label || id?.market || null,
          side: mk.oneSided ? 'yes' : id?.side === 'u' ? 'under' : id ? 'over' : null,
          line: id?.line ?? null,
        },
      }
    })
    .sort((a, b) => (a.ser < b.ser ? -1 : a.ser > b.ser ? 1 : 0))
}

// ---- numbers for the page --------------------------------------------------------------------

/** 95% Wilson interval for a hit rate. */
function wilson(w, n, z = 1.959964) {
  const p = w / n
  const z2 = z * z
  const d = 1 + z2 / n
  const c = p + z2 / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]
}

/** One band's numbers. n counts wins and losses only: pushes, voids and postponed sit beside it. */
export function bandStats(key, cell) {
  const [w, l, push, v, pp, sum] = cell || zero()
  const n = w + l
  const hit = n ? w / n : null
  const avg = n ? sum / 1000 / n : null
  const [low, high] = n ? wilson(w, n) : [null, null]
  const edges = key === 'lo' ? [0, 0.5] : key === '90' ? [0.9, 1] : BANDS.includes(key) ? [Number(key) / 100, Number(key) / 100 + 0.05] : [null, null]
  return {
    key,
    label: bandLabel(key),
    from: r4(edges[0]),
    to: r4(edges[1]),
    n,
    wins: w,
    losses: l,
    pushes: push,
    voids: v,
    postponed: pp,
    hit: r4(hit),
    avg: r4(avg),
    gap: n ? r4(hit - avg) : null,
    low: r4(low),
    high: r4(high),
    small: n < SMALL,
  }
}

const addInto = (into, cell) => {
  for (let i = 0; i < 6; i++) into[i] += cell?.[i] || 0
  return into
}

/** The band the headline speaks for, chosen by size alone (never by how it did). */
export const HEADLINE_RULE = `The band with the most graded props among those rated 60% or more, with at least ${SMALL} graded; when none has ${SMALL}, the band with the most graded props that does.`
export function pickHeadline(bands) {
  const ok = bands.filter((b) => !b.small)
  const bySize = (a, b) => b.n - a.n || Number(b.key) - Number(a.key)
  return [...ok.filter((b) => Number(b.key) >= 60)].sort(bySize)[0] || [...ok].sort(bySize)[0] || null
}

const pct1 = (x) => `${(x * 100).toFixed(1)}%`

// ---- the service -----------------------------------------------------------------------------

export function createCalibration({ engines, store, now = () => Date.now(), perRequest = PER_REQUEST }) {
  const leagues = () => Object.keys(engines || {}).filter((k) => engines[k]?.proplog)
  const cache = new Map() // key -> { at, ttl, value }
  const loading = new Map() // key -> promise
  const working = new Map() // `${sport}:${day}` -> promise (one boil-down per day at a time)
  const notClosed = new Map() // `${sport}:${day}` -> retry after

  function remember(key, value, ttl = TTL) {
    cache.set(key, { at: Date.now(), ttl, value })
    if (cache.size > 800) cache.delete(cache.keys().next().value)
    return value
  }
  async function memo(key, fn, ttl = TTL) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value
    if (loading.has(key)) return loading.get(key)
    const p = (async () => remember(key, await fn(), ttl))().finally(() => loading.delete(key))
    loading.set(key, p)
    return p
  }

  const indexOf = (sport) => memo(`i:${sport}`, () => engines[sport].proplog.index())
  const sumMonth = (sport, m) => memo(`s:${sport}:${m}`, () => engines[sport].proplog.summaries([m]))
  const dayMonth = (sport, m) => memo(`d:${sport}:${m}`, async () => (await store.get(NS_DAY(sport), m)) || null)
  const fpMonth = (sport, m) => memo(`f:${sport}:${m}`, async () => (await store.get(NS_FP(sport), m)) || null)
  const keysOf = (ns) => memo(`k:${ns}`, async () => (typeof store.keys === 'function' ? (await store.keys(ns).catch(() => [])).filter((k) => MONTH_RE.test(k)) : []))

  /** Every month this league has anything on file for. */
  async function monthsOnFile(sport) {
    const [idx, sums, days] = await Promise.all([indexOf(sport), keysOf(NS_SUM(sport)), keysOf(NS_DAY(sport))])
    return [...new Set([...idx.all.map((d) => d.slice(0, 7)), ...sums, ...days])].sort()
  }

  /** The fingerprint for a closed day, written the first time and never again. */
  async function keepFingerprint(sport, day, fresh) {
    const month = day.slice(0, 7)
    const known = await fpMonth(sport, month)
    const have = known?.days?.[day]
    if (have && have.sha256 === fresh.sha256) return { stored: have, match: true, mismatch: known?.mismatch?.[day] || null }
    const saved = await store.update(NS_FP(sport), month, (cur) => {
      const days = cur?.days || {}
      const first = days[day]
      if (!first) return { ...(cur || {}), days: { ...days, [day]: { ...fresh, at: now(), v: 1 } } }
      // never written over: the first different hash is noted beside it, once
      if (first.sha256 === fresh.sha256 || cur?.mismatch?.[day]) return undefined
      return { ...cur, mismatch: { ...(cur?.mismatch || {}), [day]: { ...fresh, at: now() } } }
    })
    remember(`f:${sport}:${month}`, saved || null)
    const stored = saved?.days?.[day] || null
    const match = stored?.sha256 === fresh.sha256
    if (!match) log.warn('calibration: a closed day no longer matches its fingerprint', { sport, day, kept: stored?.sha256 || null, now: fresh.sha256 })
    return { stored, match, mismatch: saved?.mismatch?.[day] || null }
  }

  /**
   * Boil a closed day down to its counts and fingerprint it (the fingerprint once, ever). null
   * when the day isn't closed or isn't on file. `doc` saves a read when the caller has it.
   */
  function processDay(sport, day, doc = null) {
    const key = `${sport}:${day}`
    if (working.has(key)) return working.get(key)
    const run = (async () => {
      const d = doc || (await store.get(NS_LOG(sport), day))
      if (!d?.done) {
        notClosed.set(key, Date.now() + RETRY_MS)
        return null
      }
      notClosed.delete(key)
      const lines = canonicalLines(Object.values(d.rows || {}))
      const digest = digestDay(d)
      const [w, l, p, v, pp] = digest.totals
      const fp = await keepFingerprint(sport, day, { sha256: sha256Hex(canonicalText(lines)), rows: lines.length, counts: { w, l, p, v: v + pp }, gradedAt: d.gradedAt || null })
      const month = day.slice(0, 7)
      const had = (await dayMonth(sport, month))?.days?.[day]
      let kept = had
      if (had?.v !== DIGEST_V) {
        const saved = await store.update(NS_DAY(sport), month, (cur) => (cur?.days?.[day]?.v === DIGEST_V ? undefined : { ...(cur || {}), days: { ...(cur?.days || {}), [day]: { ...digest, at: now() } } }))
        remember(`d:${sport}:${month}`, saved || null)
        kept = saved?.days?.[day] || digest
      }
      // digest: the counts kept (what the page sums); fresh: the rows on file right now
      return { doc: d, lines, digest: kept, fresh: digest, fp }
    })().finally(() => working.delete(key))
    working.set(key, run)
    return run
  }
  const waiting = (sport, day) => (notClosed.get(`${sport}:${day}`) || 0) > Date.now()

  /** The days a filter covers in one league: from/to (inclusive, US Eastern), and its season. */
  function planFor(sport, { window, season }, today) {
    const yesterday = shiftDay(today, -1)
    if (window === '30d' || window === '90d') return { from: shiftDay(today, window === '30d' ? -30 : -90), to: yesterday, season: null }
    if (window === 'season') {
      const year = season ?? seasonOf(sport, today)
      const r = seasonRange(sport, year)
      return { from: r.from, to: r.to < yesterday ? r.to : yesterday, season: { key: year, label: seasonLabel(sport, year), from: r.from, to: r.to } }
    }
    return { from: null, to: yesterday, season: null }
  }

  /** One league's closed days in a plan, boiled down (as far as the budget goes), with what's left out. */
  async function gather(sport, plan, today, budget) {
    const idx = await indexOf(sport)
    const open = new Set(idx.open)
    const inRange = (d) => DAY_RE.test(d) && d < today && d <= plan.to && (!plan.from || d >= plan.from)
    const lo = plan.from ? plan.from.slice(0, 7) : '0000-00'
    const months = plan.to < (plan.from || '') ? [] : (await monthsOnFile(sport)).filter((m) => m >= lo && m <= plan.to.slice(0, 7))
    const [sumDocs, dayDocs] = await Promise.all([Promise.all(months.map((m) => sumMonth(sport, m))), Promise.all(months.map((m) => dayMonth(sport, m)))])
    const sums = Object.assign({}, ...sumDocs)
    const digests = Object.assign({}, ...dayDocs.map((d) => d?.days || {}))
    for (const [d, dg] of Object.entries(digests)) if (dg?.v !== DIGEST_V) delete digests[d]
    // closed for sure: folded into the log's summary, or boiled down here already
    const closed = new Set([...Object.keys(sums), ...Object.keys(digests)].filter(inRange))
    // on file, not waiting on results, not summarized: closed if its raw day says so
    const maybe = idx.all.filter((d) => inRange(d) && !open.has(d) && !closed.has(d) && !waiting(sport, d))
    const lacking = [...closed].filter((d) => !digests[d])
    // summarized but looked at a moment ago and not there to count: say so without reading it again
    const missing = lacking.filter((d) => waiting(sport, d))
    const todo = [...lacking.filter((d) => !waiting(sport, d)), ...maybe].sort().reverse()
    const batch = todo.slice(0, Math.max(0, budget.left))
    budget.left -= batch.length
    const failed = []
    await mapLimit(batch, 4, async (d) => {
      try {
        const r = await processDay(sport, d)
        if (r) {
          digests[d] = r.digest
          closed.add(d)
        } else if (closed.has(d)) missing.push(d) // summarized, but the raw day isn't there to count
      } catch (e) {
        failed.push(d)
        log.warn('calibration: could not read a closed day', { sport, day: d, err: errText(e) })
      }
    })
    const days = [...closed].filter((d) => digests[d]).sort()
    return {
      sport,
      plan,
      days,
      digests,
      sums,
      pending: idx.open.filter((d) => inRange(d) && !closed.has(d)).sort(),
      missing: missing.sort(),
      unprocessed: todo.length - batch.length + failed.length,
    }
  }

  function phraseOf({ window, season, league }, first) {
    if (window === '30d') return 'in the last 30 days'
    if (window === '90d') return 'in the last 90 days'
    if (window === 'season') {
      if (season == null) return 'this season'
      return league === 'all' ? `in the seasons that started in ${season}` : `in the ${seasonLabel(league, season)} season`
    }
    return first ? `since ${dayText(first)}` : 'so far'
  }

  /**
   * The page's numbers. filters: { league ('all' or a key), market ('all' or a key), window
   * ('30d' | '90d' | 'season' | 'all'), season (start year, with window 'season'), basis ('p' | 'p0') }.
   */
  async function summary(filters) {
    const f = { league: 'all', market: 'all', window: 'season', season: null, basis: 'p', ...filters }
    const t = now()
    const today = dayET(t)
    const key = `sum|${f.league}|${f.market}|${f.window}|${f.season ?? ''}|${f.basis}|${today}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value
    const value = await build(f, t, today)
    // an answer still adding closed days isn't kept: the next request picks up where it left off
    return value.range.complete ? remember(key, value) : value
  }

  async function build(f, t, today) {
    const sports = f.league === 'all' ? leagues() : [f.league]
    const budget = { left: perRequest }
    const gathered = await Promise.all(sports.map((s) => gather(s, planFor(s, f, today), today, budget)))
    const cells = {}
    const markets = new Map()
    const reconciled = { days: 0, differ: [] }
    for (const g of gathered) {
      for (const d of g.days) {
        const dg = g.digests[d]
        for (const [mk, bands] of Object.entries(dg[f.basis] || {})) {
          if (f.market !== 'all' && mk !== f.market) continue
          for (const [b, c] of Object.entries(bands)) addInto((cells[b] ||= zero()), c)
        }
        for (const [mk, bands] of Object.entries(dg.p || {})) {
          const m = markets.get(mk) || { key: mk, label: MARKET_LABELS[mk] || (mk === 'other' ? 'Other' : mk), n: 0, leagues: new Set() }
          for (const c of Object.values(bands)) m.n += c[0] + c[1]
          m.leagues.add(g.sport)
          markets.set(mk, m)
        }
        // the log's own summary of the day should count the same rows the same way
        const s = g.sums[d]
        if (s?.all) {
          reconciled.days++
          const [w, l, p, v, pp] = dg.totals
          if (s.all[1] !== w || s.all[2] !== l || s.all[3] !== p || (s.voids ?? 0) !== v + pp || (s.rows != null && s.rows !== dg.rows)) reconciled.differ.push({ league: g.sport, day: d })
        }
      }
    }
    const bands = BANDS.map((b) => bandStats(b, cells[b]))
    const overall = bandStats('all', BANDS.reduce((a, b) => addInto(a, cells[b]), zero()))
    const below = cells.lo ? bandStats('lo', cells.lo) : null
    const allDays = gathered.flatMap((g) => g.days)
    const first = allDays.length ? allDays.reduce((a, b) => (a < b ? a : b)) : null
    const last = allDays.length ? allDays.reduce((a, b) => (a > b ? a : b)) : null
    const unprocessed = gathered.reduce((s, g) => s + g.unprocessed, 0)
    const pick = pickHeadline(bands)
    const phrase = phraseOf(f, first)
    const withData = gathered.filter((g) => g.days.length)
    const plans = gathered.map((g) => g.plan)
    const froms = plans.map((p) => p.from).filter(Boolean)
    const range = {
      window: f.window,
      season: f.window === 'season' ? (f.league === 'all' ? { key: f.season ?? null, label: f.season != null ? `Seasons that started in ${f.season}` : 'Each league’s current season' } : plans[0]?.season || null) : null,
      from: froms.length ? froms.reduce((a, b) => (a < b ? a : b)) : first,
      to: plans.length ? plans.map((p) => p.to).reduce((a, b) => (a > b ? a : b)) : shiftDay(today, -1),
      first,
      last,
      days: allDays.length,
      leagues: Object.fromEntries(gathered.map((g) => [g.sport, { from: g.plan.from, to: g.plan.to, season: g.plan.season, days: g.days.length, first: g.days[0] || null, last: g.days[g.days.length - 1] || null }])),
      pending: gathered.flatMap((g) => g.pending.map((day) => ({ league: g.sport, day }))),
      missing: gathered.flatMap((g) => g.missing.map((day) => ({ league: g.sport, day }))),
      unprocessed,
      complete: unprocessed === 0,
      reconciled,
      today,
      note: '',
    }
    // with several leagues, days are counted per league ("8 NBA, 4 NHL and 3 NFL"): a calendar day can hold three
    const perLeague = [...withData].sort((a, b) => b.days.length - a.days.length).map((g) => `${g.days.length} ${SPORTS[g.sport]?.name || g.sport.toUpperCase()}`)
    const howMany = withData.length > 1 ? `${perLeague.slice(0, -1).join(', ')} and ${perLeague[perLeague.length - 1]}` : `${allDays.length} ${allDays.length === 1 ? 'day' : 'days'}`
    range.note = allDays.length
      ? `Closed game days (US Eastern) from ${dayText(first)} to ${dayText(last)}: ${howMany}. Today’s games and days still waiting on results are not counted.`
      : 'No closed game days in this range yet. Today’s games and days still waiting on results are not counted.'
    if (unprocessed) range.note += ` ${unprocessed} more closed ${unprocessed === 1 ? 'day is' : 'days are'} still being added.`
    if (f.league === 'all' && f.window === 'season') range.note += f.season != null ? ` Each league counts its own season that started in ${f.season}.` : ' Each league counts its own current season.'
    const seasonKeys = new Set()
    for (const s of sports) {
      const idx = await indexOf(s)
      for (const d of idx.all) seasonKeys.add(seasonOf(s, d))
      seasonKeys.add(seasonOf(s, today))
    }
    return {
      v: 1,
      at: t,
      filters: { league: f.league, market: f.market, window: f.window, season: f.season ?? null, basis: f.basis },
      basis: { key: f.basis, label: BASES[f.basis] },
      range,
      headline: pick
        ? { band: pick.key, label: pick.label, n: pick.n, hit: pick.hit, avg: pick.avg, phrase, text: `Props rated ${pick.label} hit ${pct1(pick.hit)} ${phrase}`, sub: `${pick.n.toLocaleString('en-US')} graded props, average rating ${pct1(pick.avg)}`, rule: HEADLINE_RULE }
        : null,
      overall,
      bands,
      outside: { below50: below, unrated: (cells.na?.[0] || 0) + (cells.na?.[1] || 0) + (cells.na?.[2] || 0) + (cells.na?.[3] || 0) + (cells.na?.[4] || 0) },
      excluded: f.basis === 'p0' ? { lineMoved: bandStats('mv', cells.mv) } : null,
      markets: [...markets.values()].map((m) => ({ key: m.key, label: m.label, n: m.n, leagues: [...m.leagues].sort() })).sort((a, b) => a.label.localeCompare(b.label)),
      leagues: leagues().map((k) => ({ key: k, name: SPORTS[k]?.name || k.toUpperCase() })),
      seasons: [...seasonKeys].sort((a, b) => b - a).map((y) => ({ key: y, label: f.league === 'all' ? String(y) : seasonLabel(f.league, y) })),
      small: SMALL,
      method: {
        counted: 'Only wins and losses count toward the hit rate. Pushes, voids (the player didn’t play) and props on games that were postponed or never finished are left out and counted on their own.',
        bands: 'Bands of the probability the model gave the side it backed: 50 to 55%, 55 to 60% and so on up to 85 to 90%, then 90% or more. Yes-only props rated under 50% (anytime scorer and the like) are shown on their own.',
        small: `A band with fewer than ${SMALL} graded props is marked small: its hit rate can swing a long way by chance.`,
        interval: 'low and high: the 95% range for the true hit rate given the results (Wilson).',
        headline: HEADLINE_RULE,
      },
      verify: verifyInfo(),
    }
  }

  /** The fingerprints of the closed days a filter covers, newest first. */
  async function fingerprints(filters) {
    const f = { league: 'all', window: 'season', season: null, ...filters }
    const t = now()
    const today = dayET(t)
    const key = `fp|${f.league}|${f.window}|${f.season ?? ''}|${today}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value
    const sports = f.league === 'all' ? leagues() : [f.league]
    const budget = { left: perRequest }
    const gathered = await Promise.all(sports.map((s) => gather(s, planFor(s, f, today), today, budget)))
    const list = []
    for (const g of gathered) {
      const months = [...new Set(g.days.map((d) => d.slice(0, 7)))]
      const docs = Object.fromEntries(await Promise.all(months.map(async (m) => [m, await fpMonth(g.sport, m)])))
      // another instance may have fingerprinted a day since this one last read the month
      for (const m of months) {
        if (g.days.some((d) => d.startsWith(m) && !docs[m]?.days?.[d])) {
          cache.delete(`f:${g.sport}:${m}`)
          docs[m] = await fpMonth(g.sport, m)
        }
      }
      for (const d of g.days) {
        const doc = docs[d.slice(0, 7)]
        const fp = doc?.days?.[d]
        if (!fp) continue
        list.push({ league: g.sport, day: d, sha256: fp.sha256, rows: fp.rows, counts: fp.counts || null, gradedAt: fp.gradedAt || null, at: fp.at, mismatch: doc?.mismatch?.[d] || null, url: `/api/calibration/day/${g.sport}/${d}` })
      }
    }
    list.sort((a, b) => b.day.localeCompare(a.day) || a.league.localeCompare(b.league))
    const MAX = 400
    const unprocessed = gathered.reduce((s, g) => s + g.unprocessed, 0)
    const value = {
      v: 1,
      at: t,
      filters: { league: f.league, window: f.window, season: f.season ?? null },
      total: list.length,
      truncated: list.length > MAX,
      days: list.slice(0, MAX),
      complete: unprocessed === 0,
      unprocessed,
      verify: verifyInfo(),
    }
    return value.complete ? remember(key, value) : value
  }

  /**
   * One closed day's graded rows for one league, its fingerprint, and the fingerprint worked out
   * again from the rows on file now. Open days (today's among them) are refused.
   * Returns { body, text } (text: the exact bytes the fingerprint is taken over).
   */
  async function closedDay(league, day) {
    if (!leagues().includes(league)) throw new ApiError(404, 'unknown_league', 'There’s no such league here.')
    if (!isDay(day)) throw new ApiError(400, 'bad_day', 'Write the day as YYYY-MM-DD.')
    const today = dayET(now())
    if (day >= today) throw new ApiError(409, 'day_open', 'That day isn’t closed yet. Its rows are published once every game on it is graded.')
    const doc = await store.get(NS_LOG(league), day)
    if (!doc) throw new ApiError(404, 'not_found', 'Nothing on file for that day.')
    if (!doc.done) throw new ApiError(409, 'day_open', 'That day isn’t closed yet. Its rows are published once every game on it is graded.')
    const res = await processDay(league, day, doc)
    if (!res) throw new ApiError(409, 'day_open', 'That day isn’t closed yet. Its rows are published once every game on it is graded.')
    const rows = publicRows(res.doc)
    const text = canonicalText(res.lines)
    const computed = { sha256: sha256Hex(text), rows: res.lines.length }
    const stored = res.fp.stored
    // the counts of the rows handed out here, as they are on file now
    const [w, l, p, v, pp] = res.fresh.totals
    const day1 = {}
    for (const bands of Object.values(res.fresh.p || {})) for (const [b, c] of Object.entries(bands)) addInto((day1[b] ||= zero()), c)
    return {
      text,
      body: {
        v: 1,
        league,
        day,
        closed: true,
        gradedAt: res.doc.gradedAt || null,
        counts: { rows: rows.length, wins: w, losses: l, pushes: p, voids: v, postponed: pp },
        bands: BANDS.map((b) => bandStats(b, day1[b])),
        below50: day1.lo ? bandStats('lo', day1.lo) : null,
        fingerprint: stored ? { sha256: stored.sha256, rows: stored.rows, at: stored.at, gradedAt: stored.gradedAt || null } : null,
        computed,
        match: Boolean(stored && stored.sha256 === computed.sha256),
        mismatch: res.fp.mismatch || null,
        verify: verifyInfo(),
        rows: rows.map((r) => r.row),
      },
    }
  }

  /**
   * After the daily run: boil down and fingerprint the days it just closed (and any closed day not
   * yet done), newest first, for at most budgetMs. Never throws.
   */
  async function sweep({ budgetMs = 20_000 } = {}) {
    const until = Date.now() + budgetMs
    const out = {}
    for (const sport of leagues()) {
      try {
        cache.delete(`i:${sport}`)
        const today = dayET(now())
        const idx = await indexOf(sport)
        const open = new Set(idx.open)
        const months = [...new Set(idx.all.map((d) => d.slice(0, 7)))]
        for (const m of months) cache.delete(`d:${sport}:${m}`)
        const have = Object.assign({}, ...(await Promise.all(months.map((m) => dayMonth(sport, m)))).map((d) => d?.days || {}))
        const todo = idx.all.filter((d) => d < today && !open.has(d) && have[d]?.v !== DIGEST_V && !waiting(sport, d)).sort().reverse()
        let done = 0
        for (const d of todo) {
          if (Date.now() > until) break
          if (await processDay(sport, d)) done++
        }
        out[sport] = { done, left: Math.max(0, todo.length - done) }
      } catch (e) {
        out[sport] = { error: errText(e) }
        log.warn('calibration sweep failed', { sport, err: errText(e) })
      }
    }
    return out
  }

  /** The admin metrics with a daily run that also fingerprints what it closed (for the cron). */
  function afterDaily(metrics, { budgetMs = 20_000 } = {}) {
    return {
      ...metrics,
      daily: async (opts) => {
        const ran = await metrics.daily(opts)
        await sweep({ budgetMs }).catch(() => null)
        return ran
      },
    }
  }

  return { summary, fingerprints, closedDay, sweep, afterDaily, leagues, processDay }
}

/** How to check a day yourself, for API readers. */
export function verifyInfo() {
  return {
    format: FORMAT,
    algorithm: 'sha256',
    fields: FIELDS,
    rows: 'GET /api/calibration/day/{league}/{day}: the rows field (or ?format=text for the exact text)',
    steps: [
      'Take every row of the day: each one is graded (res is w, l, p for a push, or v for a void).',
      'Write each row as compact JSON of [id, p, p0, t0, t1, res, val], numbers as JavaScript writes them, null for a missing value.',
      'Sort the lines as plain strings (each starts with the id, so this is id order).',
      'Join them with a newline and end with one. Hash the UTF-8 text with SHA-256 and compare the hex with the published fingerprint.',
    ],
  }
}

/** Query string -> filters, or a 400 that says what's wrong. */
export function parseFilters(q = {}, leagueKeys = []) {
  const one = (v) => (Array.isArray(v) ? v[0] : v)
  const league = String(one(q.league) ?? 'all').toLowerCase()
  if (league !== 'all' && !leagueKeys.includes(league)) throw new ApiError(400, 'bad_league', `League is all or one of ${leagueKeys.join(', ')}.`)
  const market = String(one(q.market) ?? 'all')
  if (market !== 'all' && !(/^[a-zA-Z0-9]{2,16}$/.test(market) && (MARKETS[market] || TEAM_MARKETS[market]))) throw new ApiError(400, 'bad_market', 'That prop type isn’t one we log.')
  const rawSeason = one(q.season)
  let window = one(q.window)
  if (window == null || window === '') window = 'season'
  window = String(window)
  if (!WINDOWS.includes(window)) throw new ApiError(400, 'bad_window', 'Window is 30d, 90d, season or all.')
  let season = null
  if (rawSeason != null && rawSeason !== '') {
    if (!/^\d{4}$/.test(String(rawSeason)) || Number(rawSeason) < 2000 || Number(rawSeason) > 2100) throw new ApiError(400, 'bad_season', 'Season is the year it started, like 2026.')
    if (window !== 'season') throw new ApiError(400, 'bad_season', 'A season only goes with window=season.')
    season = Number(rawSeason)
  }
  const basis = String(one(q.basis) ?? 'p')
  if (!BASES[basis]) throw new ApiError(400, 'bad_basis', 'Basis is p (the final pre-game probability) or p0 (the first one seen).')
  return { league, market, window, season, basis }
}

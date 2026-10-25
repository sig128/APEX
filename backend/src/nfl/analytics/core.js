// Hit rates, projections and the APEX probability for one player prop.
import { MARKETS, marketOf } from '../markets.js'
import { wilsonLower, ewma, normalOver, poissonAtLeast, shrink } from '../../lib/stats.js'
import { probToAmerican, americanToProb } from '../../lib/odds.js'
import { clamp, mean, median, round, sd } from '../../lib/util.js'

export const MAX_LINE = 800

// ---- prop ids: "<player>.<market>.<o|u>.<line>" for players, "t<team>.<market>.<o|u>.<line>" for teams
const ID_RE = /^(t?\d{1,12})\.([a-zA-Z0-9]{2,16})\.([ou])\.(-?\d{1,3}(?:\.\d{1,2})?)$/

export function propId(subject, market, side, line) {
  return `${subject}.${market}.${side === 'u' ? 'u' : 'o'}.${Number(line)}`
}

/** Strict: unknown markets, odd lines and junk are rejected (ids come from shared links). */
export function parsePropId(id) {
  if (typeof id !== 'string' || id.length > 48) return null
  const m = ID_RE.exec(id.trim())
  if (!m) return null
  const [, subject, market, side, lineStr] = m
  const mk = marketOf(market)
  if (!mk) return null
  const team = subject.startsWith('t')
  if (team !== Boolean(market === 'teamPts')) return null
  const line = Number(lineStr)
  if (!Number.isFinite(line) || line < 0 || line > MAX_LINE) return null
  if (Math.round(line * 4) !== line * 4) return null
  if (mk.oneSided && (side !== 'o' || line !== mk.fixedLine)) return null
  return { id: propId(subject, market, side, line), subject, playerId: team ? null : subject, teamId: team ? subject.slice(1) : null, market, side, line }
}

// ---- hit tests --------------------------------------------------------------------------------

export function outcome(v, line, side) {
  if (!Number.isFinite(v)) return null
  if (v === line) return 'push'
  const over = v > line
  return (side === 'u' ? !over : over) ? 'hit' : 'miss'
}

export function hitCount(values, line, side) {
  let hits = 0
  let n = 0
  for (const v of values) {
    const o = outcome(v, line, side)
    if (o === 'push' || o === null) continue
    n++
    if (o === 'hit') hits++
  }
  return { hits, n }
}

/** Current streak of hits, newest game first. */
export function streakOf(values, line, side) {
  let s = 0
  for (let i = values.length - 1; i >= 0; i--) {
    const o = outcome(values[i], line, side)
    if (o === 'push') continue
    if (o !== 'hit') break
    s++
  }
  return s
}

// ---- game values ------------------------------------------------------------------------------

/**
 * Rows from the player's logs (oldest -> newest) with the market value. Games where a passer
 * didn't attempt a pass (a mop-up appearance) don't count for passing markets.
 */
export function marketRows(logs, market) {
  const mk = MARKETS[market]
  if (!mk) return []
  const out = []
  for (const r of logs) {
    const s = r.s || {}
    if (mk.need && !(s[mk.need] > 0)) continue
    if (mk.keys && !mk.keys.some((k) => s[k] != null)) continue
    out.push({ ...r, v: mk.stat(s) })
  }
  return out
}

function windowStat(rows, line, side, key, label) {
  const { hits, n } = hitCount(rows.map((r) => r.v), line, side)
  return { key, label, hits, n, rate: n ? hits / n : null, wilson: wilsonLower(hits, n) }
}

/**
 * Hit-rate windows like Linemate: L5, L10, L20, this season, last season, vs this opponent,
 * home/away, and "without <teammate>" when a key teammate is out.
 */
export function windows(rows, line, side, { season, lastSeason, oppId, oppAbbr, home, without } = {}) {
  const out = []
  const last = (k) => rows.slice(-k)
  if (rows.length) out.push(windowStat(last(5), line, side, 'L5', 'L5'))
  if (rows.length > 5) out.push(windowStat(last(10), line, side, 'L10', 'L10'))
  if (rows.length > 10) out.push(windowStat(last(20), line, side, 'L20', 'L20'))
  const cur = rows.filter((r) => r.season === season && !r.post)
  if (cur.length) out.push(windowStat(cur, line, side, 'season', String(season)))
  const prev = rows.filter((r) => r.season === lastSeason)
  if (prev.length) out.push(windowStat(prev, line, side, 'last', String(lastSeason)))
  if (oppId) {
    const h2h = rows.filter((r) => r.oppId === oppId)
    if (h2h.length) out.push(windowStat(h2h, line, side, 'h2h', `vs ${oppAbbr || 'opp'}`))
  }
  if (home != null) {
    const venue = rows.filter((r) => Boolean(r.home) === Boolean(home)).slice(-10)
    if (venue.length >= 3) out.push(windowStat(venue, line, side, 'venue', home ? 'Home' : 'Away'))
  }
  for (const w of without || []) {
    const games = new Set(w.missed)
    const sub = rows.filter((r) => games.has(r.eventId))
    if (sub.length >= 2) out.push({ ...windowStat(sub, line, side, `without:${w.id}`, `Without ${w.short}`), teammate: w.id })
  }
  return out
}

/** The window with the best trustworthy rate (Wilson lower bound), needing 4+ games. */
export function bestWindow(ws) {
  let best = null
  for (const w of ws) {
    if (w.n < 4) continue
    if (!best || w.wilson > best.wilson || (w.wilson === best.wilson && w.n > best.n)) best = w
  }
  return best
}

// ---- projection and probability -------------------------------------------------------------

/**
 * Projection for the next game: recency-weighted mean of the last 16 games, nudged by matchup
 * and injury context. Returns { mean, sd } (normal markets) or { lambda } (counts).
 */
export function project(rows, market, { matchup = 0, boost = 0 } = {}) {
  const mk = marketOf(market)
  const vals = rows.slice(-16).map((r) => r.v)
  if (!vals.length || !mk) return null
  const base = ewma(vals, 0.22)
  const longRun = mean(vals)
  let m = 0.7 * base + 0.3 * longRun
  m *= 1 + clamp(matchup, -0.12, 0.12) + clamp(boost, 0, 0.2)
  if (mk.dist === 'poisson') return { lambda: Math.max(0.02, m), mean: m }
  const sampleSd = sd(vals) ?? m * (mk.cv || 0.4)
  const prior = Math.max(1, m * (mk.cv || 0.4))
  const k = 4
  const nn = vals.length
  const s = Math.sqrt((nn * sampleSd * sampleSd + k * prior * prior) / (nn + k))
  return { mean: m, sd: Math.max(0.5, s) }
}

export function modelProb(proj, market, line) {
  if (!proj) return null
  const mk = marketOf(market)
  if (mk?.dist === 'poisson') return poissonAtLeast(proj.lambda, Math.floor(line) + 1)
  return normalOver(proj.mean, proj.sd, line)
}

/**
 * What the market would say about a line it didn't price. A posted main line without a price
 * is close to a coin flip, so center the model's spread on it and read off the other line.
 */
export function marketAnchor(proj, market, mainLine, line) {
  if (!proj || !Number.isFinite(mainLine) || !Number.isFinite(line)) return null
  const mk = marketOf(market)
  if (mk?.dist === 'poisson') {
    const k = Math.floor(mainLine) + 1
    let lo = 0.001
    let hi = Math.max(2, mainLine * 3 + 6)
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2
      if (poissonAtLeast(mid, k) < 0.5) lo = mid
      else hi = mid
    }
    return poissonAtLeast((lo + hi) / 2, Math.floor(line) + 1)
  }
  if (!(proj.sd > 0)) return null
  return normalOver(mainLine, proj.sd, line)
}

/**
 * APEX probability: 55% empirical (recent hit rate, shrunk toward the model) and 45% model.
 * Returns the probability of the OVER (yes for one-sided markets).
 */
export function apexOverProb(rows, market, line, ctx = {}) {
  const proj = project(rows, market, ctx)
  const pModel = modelProb(proj, market, line)
  if (pModel == null) return null
  const recent = rows.slice(-20).map((r) => r.v)
  const { hits, n } = hitCount(recent, line, 'o')
  const emp = shrink(hits, n, pModel, 3)
  const p = 0.55 * emp + 0.45 * pModel
  return { p: clamp(p, 0.02, 0.98), pModel, emp, proj, sample: n }
}

/** 0-100 score. 50 is a coin flip; it rewards probability and discounts thin samples. */
export function apexScore(p, sample, edge = 0) {
  if (!(p >= 0 && p <= 1)) return null
  const conf = clamp(sample / 8, 0.35, 1)
  const raw = 0.5 + 0.5 * Math.tanh((p - 0.5) / 0.12 + edge * 3)
  const s = 50 + (raw * 100 - 50) * conf
  return Math.round(clamp(s, 1, 99))
}

export function fairOdds(p) {
  return probToAmerican(p)
}

export function impliedFromPrice(price) {
  return americanToProb(price)
}

export function summarize(rows) {
  const vals = rows.map((r) => r.v)
  return { avg: vals.length ? round(mean(vals), 1) : null, median: vals.length ? median(vals) : null, games: vals.length }
}

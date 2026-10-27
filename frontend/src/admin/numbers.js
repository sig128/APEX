// The admin page's arithmetic on the API's accumulators, and the plain names for segments.
// An accumulator is [n, wins, losses, pushes, units, risked, sum of squared profits, sum of
// probabilities given, sum of break-even rates, priced decisions, sum of line moves, moves].
import { bookName } from '../lib/format.js'
import { SPORTS } from '../lib/leagues.js'

export const ZERO = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
export const add = (a, b) => (a || ZERO).map((x, i) => x + (b?.[i] || 0))

/** Everything a row of numbers shows, from one accumulator. */
export function stats(a) {
  const [n, w, l, p, u, r, sq, sp, si, ni, cv, nc] = a || ZERO
  const dec = w + l
  const roi = r ? u / r : null
  // the spread of one bet's profit, for how sure a ROI is (a t-score on the mean)
  const mean = r ? u / r : 0
  const varr = r > 1 ? Math.max(0, sq / r - mean * mean) * (r / (r - 1)) : null
  const se = varr != null && r ? Math.sqrt(varr / r) : null
  const t = se ? mean / se : null
  return {
    n,
    w,
    l,
    p,
    units: u,
    risked: r,
    hit: dec ? w / dec : null,
    expected: dec ? sp / dec : null,
    breakEven: ni ? si / ni : null,
    roi,
    t,
    move: nc ? cv / nc : null,
    moves: nc,
  }
}

/**
 * How much to trust a result, in words. A bet's profit swings a lot, so a ROI needs volume:
 * about 2 standard errors from zero on 100+ priced bets before it counts as real.
 */
export function confidence(s) {
  if (!s || !s.risked) return { key: 'none', label: 'No prices yet' }
  if (s.risked < 30) return { key: 'early', label: 'Too early' }
  const t = s.t ?? 0
  if (t >= 2 && s.risked >= 100) return { key: 'real', label: 'Real edge' }
  if (t >= 1.3) return { key: 'promising', label: 'Promising' }
  if (t <= -2 && s.risked >= 100) return { key: 'leak', label: 'Losing money' }
  if (t <= -1.3) return { key: 'weak', label: 'Looks weak' }
  return { key: 'noise', label: 'Could be luck' }
}

export const LEAGUE = Object.fromEntries(SPORTS.map((s) => [s.key, s.name]))

/** Ways to slice the board's record, in the order the page offers them. */
export const GROUPS = [
  { key: 'm', label: 'Bet type' },
  { key: 's', label: 'Over or under' },
  { key: 'pb', label: 'Probability' },
  { key: 'eb', label: 'Edge' },
  { key: 'ld', label: 'The read' },
  { key: 'mu', label: 'Matchup' },
  { key: 'pr', label: 'Price' },
  { key: 'bk', label: 'Book' },
  { key: 'sc', label: 'Score' },
  { key: 'h', label: 'Home or away' },
  { key: 'cl', label: 'Line move' },
  { key: 'lg', label: 'League' },
]

const NAMES = {
  s: { o: 'Overs', u: 'Unders', y: 'Yes bets (anytime goal, TD)' },
  eb: { none: 'No price to measure', neg: 'Below the price', 0: '0 to 2 points of edge', 2: '2 to 4 points', 4: '4 to 6 points', 6: '6 points or more' },
  ld: { f: 'The read backs it', m: 'Mixed read', a: 'Read says caution', n: 'No read' },
  mu: { h: 'Matchup helps', x: 'Matchup hurts', n: 'Neutral matchup' },
  pr: { fav2: '-200 or shorter', fav: '-199 to -131', even: '-130 to +110', dog: '+111 to +200', long: 'Longer than +200', none: 'No price' },
  sc: { 90: 'Score 90+', 80: 'Score 80 to 89', 70: 'Score 70 to 79', 60: 'Score 60 to 69', 0: 'Score under 60' },
  h: { 1: 'Home', 0: 'Away' },
  cl: { with: 'Price moved our way', against: 'Price moved against us', flat: 'Price held' },
}

/** "pb:65" -> "65 to 70%", "m:sog" -> "Shots on Goal". */
export function segName(key, labels = {}) {
  const [g, v] = key.split(':')
  if (g === 'm') return labels.m?.[v] || v
  if (g === 'bk') return v === 'none' ? 'No book price' : bookName(v)
  if (g === 'lg') return LEAGUE[v] || v.toUpperCase()
  if (g === 'pb') return v === '85' ? '85% or more' : `${v} to ${Number(v) + 5}%`
  return NAMES[g]?.[v] || v
}

/** Segments of one group, as rows with their numbers, best ROI first. */
export function groupRows(seg, group, labels, { min = 0 } = {}) {
  return Object.entries(seg || {})
    .filter(([k]) => k.startsWith(`${group}:`))
    .map(([k, a]) => ({ key: k, name: segName(k, labels), ...stats(a) }))
    .filter((r) => r.n >= min)
    .sort((a, b) => (b.roi ?? -9) - (a.roi ?? -9) || b.n - a.n)
}

/**
 * The strongest and weakest slices worth a look: priced, at least `min` bets, and not the
 * catch-alls (no price, no read). Ranked by how sure the result is, not just its size.
 */
export function standouts(seg, labels, { min = 30, count = 3 } = {}) {
  const rows = Object.entries(seg || {})
    .filter(([k]) => !/:(none|n)$/.test(k) && !k.startsWith('lg:'))
    .map(([k, a]) => ({ key: k, group: k.split(':')[0], name: segName(k, labels), ...stats(a) }))
    .filter((r) => r.risked >= min && r.roi != null)
  const up = rows.filter((r) => r.roi > 0).sort((a, b) => (b.t ?? 0) - (a.t ?? 0)).slice(0, count)
  const down = rows.filter((r) => r.roi < 0).sort((a, b) => (a.t ?? 0) - (b.t ?? 0)).slice(0, count)
  return { up, down }
}

export const pctTxt = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '–')
export const signedPct = (x, d = 1) => (Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%` : '–')
export const unitsTxt = (u, d = 1) => (Number.isFinite(u) ? `${u > 0 ? '+' : u < 0 ? '−' : ''}${Math.abs(u).toFixed(d)}u` : '–')
export const record = (s) => `${s.w}-${s.l}${s.p ? `-${s.p}` : ''}`
export const money = (x) => (Number.isFinite(x) ? `$${x.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '–')
export const compact = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : n.toLocaleString('en-US'))

/** YYYY-MM-DD for a Date or ms, in US Eastern (the API's game day). */
export function dayKey(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
  const get = (t) => parts.find((p) => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}
export const shiftDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
export const dayLabel = (day) => dayFmt.format(new Date(`${day}T12:00:00Z`))
const longFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
export const dayLong = (day) => longFmt.format(new Date(`${day}T12:00:00Z`))

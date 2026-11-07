// Responsible betting: limits someone sets on their own picks, a cool-off, self-exclusion, and a
// tilt check. PropPickz doesn't take bets, so these apply to what happens here: posting picks,
// tailing and contests. Lowering a limit works at once; raising or removing one waits a day, so
// it can't be undone in the heat of a bad night. A cool-off or exclusion can't be ended early.
import { ApiError } from '../lib/router.js'
import { round } from '../lib/util.js'

export const RAISE_WAIT_MS = 24 * 3600_000
export const COOL_DAYS = [1, 7, 30]
export const EXCLUDE_MONTHS = [6, 12, 60]
const DAY_MS = 86_400_000

/** picksDay: picks a day; unitsDay / unitsWeek: units staked; lossWeek: net units lost over 7 days. */
export const LIMITS = {
  picksDay: { min: 1, max: 20, step: 1, label: 'picks a day' },
  unitsDay: { min: 0.5, max: 200, step: 0.5, label: 'units staked a day' },
  unitsWeek: { min: 1, max: 1000, step: 0.5, label: 'units staked in 7 days' },
  lossWeek: { min: 1, max: 1000, step: 0.5, label: 'units lost in 7 days' },
}

export function cleanLimits(body = {}) {
  const out = {}
  for (const [k, spec] of Object.entries(LIMITS)) {
    const v = body[k]
    if (v === null || v === '' || v === undefined) {
      out[k] = null
      continue
    }
    const n = Number(v)
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw new ApiError(400, 'bad_limit', `${spec.label[0].toUpperCase()}${spec.label.slice(1)}: pick a number from ${spec.min} to ${spec.max}, or leave it empty for no limit.`)
    out[k] = Math.round(n / spec.step) * spec.step
  }
  return out
}

const stricter = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b))

/** The limits in force now: a pending raise takes over once its day has passed. */
export function effectiveLimits(rg, now) {
  const cur = { ...(rg?.limits || {}) }
  const p = rg?.pending
  if (p && p.at <= now) return { ...cur, ...p.limits }
  return cur
}

/** New settings: tighter values apply now, looser ones are queued for RAISE_WAIT_MS. */
export function nextLimits(rg, wanted, now) {
  const cur = effectiveLimits(rg, now)
  const limits = {}
  const pending = {}
  let wait = false
  for (const k of Object.keys(LIMITS)) {
    const want = wanted[k] ?? null
    const have = cur[k] ?? null
    const tight = stricter(have, want)
    limits[k] = have == null ? want : tight
    if (want !== limits[k]) {
      pending[k] = want
      wait = true
    }
  }
  return { ...(rg || {}), limits, pending: wait ? { limits: { ...limits, ...pending }, at: now + RAISE_WAIT_MS } : null, updatedAt: now }
}

export function pausedUntil(rg, now) {
  const until = Math.max(rg?.coolUntil || 0, rg?.excludedUntil || 0)
  return until > now ? until : 0
}

export function pauseError(rg, now) {
  const until = pausedUntil(rg, now)
  if (!until) return null
  const excluded = (rg.excludedUntil || 0) >= until
  const when = new Date(until).toISOString().slice(0, 10)
  return new ApiError(403, excluded ? 'self_excluded' : 'cooling_off', excluded ? `You've excluded yourself from picks until ${when}.` : `You're on a break from picks until ${when}.`, { until })
}

/** Units net over the last 7 days from the profile's daily totals (YYYY-MM-DD keys). */
export function netWeek(stats, fromDay) {
  let units = 0
  for (const [day, b] of Object.entries(stats?.days || {})) if (day >= fromDay) units += b.units || 0
  return round(units, 2)
}

/**
 * Throws when a new post would go over a limit. usage: { picksToday, unitsToday, unitsWeek,
 * netWeek }; adding: { picks, units } for this post.
 */
export function checkLimits(limits, usage, adding) {
  const l = limits || {}
  if (l.picksDay != null && usage.picksToday + adding.picks > l.picksDay) throw new ApiError(429, 'limit_picks', `That's over your limit of ${l.picksDay} ${l.picksDay === 1 ? 'pick' : 'picks'} a day.`, { limit: 'picksDay' })
  if (l.unitsDay != null && usage.unitsToday + adding.units > l.unitsDay + 1e-9) throw new ApiError(429, 'limit_units_day', `That's over your limit of ${l.unitsDay} units a day (${round(usage.unitsToday, 1)} used).`, { limit: 'unitsDay' })
  if (l.unitsWeek != null && usage.unitsWeek + adding.units > l.unitsWeek + 1e-9) throw new ApiError(429, 'limit_units_week', `That's over your limit of ${l.unitsWeek} units in 7 days (${round(usage.unitsWeek, 1)} used).`, { limit: 'unitsWeek' })
  if (l.lossWeek != null && -usage.netWeek >= l.lossWeek) throw new ApiError(429, 'limit_loss', `You've lost ${round(-usage.netWeek, 1)} units in the last 7 days, which reaches your limit of ${l.lossWeek}. New picks open again when that drops.`, { limit: 'lossWeek' })
}

/**
 * Tilt: three or more losses in a row and a stake at least twice the usual one. Returns the
 * numbers to show, or null. stats: the profile's running totals; recent: 'W'/'L' newest first.
 */
export function tiltCheck(stats, units) {
  const recent = stats?.recent || []
  let streak = 0
  for (const c of recent) {
    if (c !== 'L') break
    streak++
  }
  const all = stats?.all || {}
  const decided = (all.wins || 0) + (all.losses || 0)
  if (streak < 3 || decided < 5 || !(all.risked > 0)) return null
  const usual = all.risked / decided
  if (!(units >= usual * 2)) return null
  return { streak, usual: round(usual, 2), units, ratio: round(units / usual, 1) }
}

export const dayBack = (t, n) => t - n * DAY_MS

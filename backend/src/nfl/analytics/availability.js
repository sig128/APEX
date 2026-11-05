// Who's available tonight: the injury report status, and players coming back from an absence.
//
// An absence is a run of the team's completed games a player didn't play in this season, counted
// only after his first game for the team (a trade or a call-up isn't an absence). His first few
// games after a long enough run are "return games". The run has to be longer in sports where
// healthy players sit now and then, and starting pitchers aren't tracked: they skip four games
// between starts by design.
import { injurySeverity } from '../../providers/espn/normalize.js'
import { MARKETS } from '../markets.js'
import { outcome } from './core.js'

/** miss: games in a row that make an absence; n: how many games back count as return games. */
export const RETURN_RULES = {
  football: { miss: 1, n: 5 },
  basketball: { miss: 2, n: 5 },
  hockey: { miss: 2, n: 5 },
  baseball: { miss: 5, n: 5 },
}
const PITCHER = /^(SP|RP|P)$/i
/** The return panel hides itself below this many games. */
export const MIN_RETURN_GAMES = 3

export function returnRule(family, pos) {
  if (family === 'baseball' && PITCHER.test(String(pos || ''))) return null
  return RETURN_RULES[family] || RETURN_RULES.basketball
}

/**
 * Absences and returns from the team's schedule and the player's log.
 * `asOf`: when the log was fetched; later games aren't counted as missed (the log may lag).
 * Returns { returns: [{ eventId, date, opp, home, k, missed, row }], current } where current is
 * { out: games missed so far } while he's still sitting, { back: k, missed } in his first games
 * back, or null.
 */
export function absences({ schedule, log, rule, asOf = Infinity }) {
  if (!rule || !Array.isArray(schedule) || !schedule.length || !Array.isArray(log) || !log.length) return { returns: [], current: null }
  const played = new Map(log.map((r) => [String(r.eventId), r]))
  const games = schedule.filter((g) => g.completed && (Date.parse(g.date) || 0) + 3 * 3600_000 <= asOf)
  const first = games.findIndex((g) => played.has(String(g.id)))
  if (first < 0) return { returns: [], current: null }
  const returns = []
  let missed = 0
  let since = null
  for (let i = first; i < games.length; i++) {
    const g = games[i]
    const row = played.get(String(g.id))
    if (!row) {
      missed++
      since = null
      continue
    }
    if (missed >= rule.miss) since = { missed, k: 0 }
    missed = 0
    if (since) {
      since.k++
      returns.push({ eventId: String(g.id), date: g.date, opp: g.oppAbbr, home: g.home, k: since.k, missed: since.missed, row })
      if (since.k >= rule.n) since = null
    }
  }
  const current = missed >= rule.miss ? { out: missed } : since ? { back: since.k, missed: since.missed } : null
  return { returns, current }
}

const LABEL = { out: 'Out', doubtful: 'Doubtful', questionable: 'Questionable', daytoday: 'Day-to-day', probable: 'Probable', returning: 'Returning' }

/**
 * The badge for a player: the injury report first, then a return from an absence.
 * injury: { status, severity, detail } from the warehouse; abs: the result of absences().
 */
export function statusTag(injury, abs) {
  const sev = injury?.status ? injury.severity || injurySeverity(injury.status) : null
  let tag = null
  if (sev === 'out' || sev === 'doubtful' || sev === 'questionable' || sev === 'probable') tag = sev
  else if (sev === 'other' && /day.?to.?day/i.test(injury.status)) tag = 'daytoday'
  if (tag) return { tag, label: LABEL[tag], status: injury.status, detail: injury.detail || null }
  const back = abs?.current?.back
  if (back) return { tag: 'returning', label: LABEL.returning, status: `Game ${back + 1} back after missing ${abs.current.missed}`, detail: null, back, missed: abs.current.missed }
  return null
}

/**
 * How a player did in his return games against a line: each game's stat, over/under and margin,
 * the hit rate, and the sample. Null when the market can't be read or there are no return games.
 */
export function returnRecord(returns, { market, line, side }) {
  const mk = MARKETS[market]
  if (!mk || !Array.isArray(returns) || !returns.length || !Number.isFinite(line)) return null
  const games = []
  for (const r of returns) {
    const v = mk.stat(r.row?.s || {})
    if (!Number.isFinite(v)) continue
    const o = outcome(v, line, side)
    games.push({ eventId: r.eventId, date: String(r.date || '').slice(0, 10), opp: r.opp, home: r.home, k: r.k, missed: r.missed, v, result: o, margin: Math.round((side === 'u' ? line - v : v - line) * 10) / 10 })
  }
  if (!games.length) return null
  const decided = games.filter((g) => g.result === 'hit' || g.result === 'miss')
  const hits = decided.filter((g) => g.result === 'hit').length
  const avgMargin = games.reduce((s, g) => s + g.margin, 0) / games.length
  return {
    line,
    side,
    n: games.length,
    hits,
    decided: decided.length,
    hitRate: decided.length ? Math.round((hits / decided.length) * 1000) / 1000 : null,
    avgMargin: Math.round(avgMargin * 10) / 10,
    show: games.length >= MIN_RETURN_GAMES,
    games: games.slice().reverse(),
  }
}

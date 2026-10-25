// Defense vs position: what each defense allows per game to QBs, RBs, WRs and TEs,
// shrunk toward the league average so two blowouts don't define a team.
import { MARKETS } from '../markets.js'
import * as football from '../../sports/football.js'

export const DVP_GROUPS = Object.keys(football.DVP_STATS)

/**
 * logs: Map(playerId -> rows); players: Map(playerId -> { pos }).
 * Returns { byDef: { [defId]: { [group]: { [stat]: { perGame, rank, games } } } }, league, groups }.
 */
export function buildDvp({ logs, players, season, minGames = 3, shrinkGames = 2, fam = football }) {
  const STATS = fam.DVP_STATS
  const GROUPS = Object.keys(STATS)
  // totals[def][event][group][stat]
  const totals = new Map()
  const useSeason = (rows) => {
    const cur = rows.filter((r) => r.season === season && !r.post)
    return cur
  }
  for (const [pid, rows] of logs) {
    const p = players.get(pid)
    const group = fam.posGroup(p?.pos)
    const stats = STATS[group]
    if (!stats) continue
    for (const r of useSeason(rows)) {
      if (!r.oppId) continue
      let d = totals.get(r.oppId)
      if (!d) totals.set(r.oppId, (d = new Map()))
      let e = d.get(r.eventId)
      if (!e) d.set(r.eventId, (e = {}))
      const g = (e[group] ||= {})
      for (const st of stats) g[st] = (g[st] || 0) + MARKETS[st].stat(r.s || {})
    }
  }
  // per game
  const per = {}
  for (const [def, events] of totals) {
    per[def] = {}
    for (const group of GROUPS) {
      const evs = [...events.values()].filter((e) => e[group])
      if (!evs.length) continue
      per[def][group] = {}
      for (const st of STATS[group]) {
        const tot = evs.reduce((s, e) => s + (e[group][st] || 0), 0)
        per[def][group][st] = { total: tot, games: evs.length }
      }
    }
  }
  // league averages, shrinkage, ranks
  const league = {}
  for (const group of GROUPS) {
    league[group] = {}
    for (const st of STATS[group]) {
      const rows = Object.values(per).map((d) => d[group]?.[st]).filter((x) => x && x.games)
      const avg = rows.length ? rows.reduce((s, x) => s + x.total / x.games, 0) / rows.length : 0
      league[group][st] = avg
      const adj = Object.entries(per)
        .filter(([, d]) => d[group]?.[st]?.games)
        .map(([def, d]) => {
          const x = d[group][st]
          return [def, (x.total + avg * shrinkGames) / (x.games + shrinkGames), x.games]
        })
        .sort((a, b) => b[1] - a[1])
      adj.forEach(([def, v, games], i) => {
        per[def][group][st] = { perGame: v, raw: per[def][group][st].total / games, games, rank: i + 1, of: adj.length, trusted: games >= minGames }
      })
    }
  }
  return { byDef: per, league, groups: STATS }
}

/** Ordinal for "16th-most". */
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

/**
 * Matchup context for a prop: rank of the opposing defense for this group/stat and the nudge
 * it gives the projection (best matchups +, worst -). Returns null when there's no data.
 */
export function matchupFor(dvp, defId, pos, market, fam = football) {
  const group = fam.posGroup(pos)
  const statKey = fam.DVP_ALIAS?.[market] || market
  const cell = dvp?.byDef?.[defId]?.[group]?.[statKey]
  const avg = dvp?.league?.[group]?.[statKey]
  if (!cell || !avg) return null
  const rel = cell.perGame / avg - 1
  return {
    group,
    stat: statKey,
    rank: cell.rank,
    of: cell.of,
    perGame: cell.perGame,
    avg,
    games: cell.games,
    // half of the relative difference, capped, and only once the sample means something
    nudge: cell.trusted ? Math.max(-0.1, Math.min(0.1, rel * 0.5)) : 0,
  }
}

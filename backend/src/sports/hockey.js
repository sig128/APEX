// Hockey (NHL): skater and goalie markets from ESPN game logs, roles from ice time and starts.
import { mean } from '../lib/util.js'

const n = (x) => (Number.isFinite(x) ? x : 0)

export const MARKETS = {
  goals: { keys: ['g'], label: 'Goals', long: 'Goals', stat: (s) => n(s.g), dist: 'poisson', pos: ['F', 'D'], need: 'toi' },
  hAst: { keys: ['a'], label: 'Assists', long: 'Assists', stat: (s) => n(s.a), dist: 'poisson', pos: ['F', 'D'], need: 'toi' },
  hPts: { keys: ['g', 'a'], label: 'Points', long: 'Points', stat: (s) => n(s.g) + n(s.a), dist: 'poisson', pos: ['F', 'D'], need: 'toi' },
  sog: { keys: ['sog'], label: 'Shots on Goal', long: 'Shots on Goal', stat: (s) => n(s.sog), dist: 'poisson', pos: ['F', 'D'], need: 'toi' },
  saves: { keys: ['sv'], label: 'Saves', long: 'Goalie Saves', stat: (s) => n(s.sv), dist: 'normal', cv: 0.22, pos: ['G'], need: 'gs' },
  anyGoal: { keys: ['g'], label: 'Anytime Goal', long: 'Anytime Goalscorer', stat: (s) => n(s.g), dist: 'poisson', oneSided: true, fixedLine: 0.5, pos: ['F', 'D'], need: 'toi' },
  goals2: { keys: ['g'], label: '2+ Goals', long: '2+ Goals', stat: (s) => n(s.g), dist: 'poisson', oneSided: true, fixedLine: 1.5, pos: ['F', 'D'], need: 'toi' },
}
export const CORE = ['sog', 'hPts', 'goals', 'hAst', 'saves', 'anyGoal']

export function posGroup(pos) {
  const p = String(pos || '').toUpperCase()
  if (p === 'C' || p === 'LW' || p === 'RW' || p === 'W' || p === 'F') return 'F'
  if (p === 'D') return 'D'
  if (p === 'G') return 'G'
  return p || 'OTHER'
}
export const GROUPS = ['F', 'D', 'G']
export const PEERS = { F: ['F'], D: ['D'], G: [] }
export const KEY_POSITIONS = ['C', 'LW', 'RW', 'D', 'G']
export const DVP_STATS = { F: ['sog', 'goals', 'hPts', 'hAst'], D: ['sog', 'hPts', 'hAst'], G: ['saves'] }
export const GROUP_NAMES = { F: 'forwards', D: 'defensemen', G: 'goalies' }
export const NOUN = { sog: 'shots on goal', goals: 'goals', hPts: 'points', hAst: 'assists', saves: 'saves', anyGoal: 'goals' }

/** Ice time is the role for skaters; for goalies it's whether they start. */
export function roleOf(player, logs, season) {
  const cur = logs.filter((r) => r.season === season).slice(-5)
  const rows = cur.length >= 2 ? cur : logs.slice(-5)
  if (!rows.length) return 0.5
  if (posGroup(player.pos) === 'G') {
    const started = mean(rows.map((r) => (r.s?.gs ? 1 : 0)))
    return started >= 0.8 ? 1 : started >= 0.5 ? 0.6 : 0.3
  }
  const toi = mean(rows.map((r) => r.s?.toi || 0))
  return toi >= 17 ? 1 : toi >= 14 ? 0.8 : toi >= 11 ? 0.6 : 0.35
}

export const LOG_COLS = (group) => (group === 'G' ? ['gs', 'sa', 'sv', 'ga'] : ['toi', 'g', 'a', 'sog', 'ppg'])
export const STAT_LABELS = { toi: 'TOI', g: 'G', a: 'A', sog: 'SOG', ppg: 'PPG', gs: 'GS', sa: 'SA', sv: 'SV', ga: 'GA' }

/** Game log columns (skaters and goalies share some names). Clock values become minutes. */
export const LOG_KEYS = {
  goals: 'g',
  assists: 'a',
  points: 'p',
  shotsTotal: 'sog',
  powerPlayGoals: 'ppg',
  powerPlayAssists: 'ppa',
  penaltyMinutes: 'pim',
  timeOnIcePerGame: { key: 'toi', parse: 'clock' },
  timeOnIce: { key: 'toi', parse: 'clock' },
  gameStarted: 'gs',
  goalsAgainst: 'ga',
  shotsAgainst: 'sa',
  saves: 'sv',
  blockedShots: 'blk',
}
/** Box score: goalies' rows are the ones with saves; a goalie in the box started (or came in). */
export const boxKeys = (cat) => (cat?.keys || []).includes('saves') ? { ...LOG_KEYS, timeOnIce: { key: 'toi', parse: 'clock' } } : LOG_KEYS

export const PROP_TYPES = {
  1: { market: 'hPts' },
  2: { market: 'hAst' },
  42: { market: 'sog' },
  45: { market: 'saves' },
  39: { market: 'goals2', oneSided: true },
  230: { market: 'anyGoal', oneSided: true },
  151: { market: 'teamPts' },
  218: { market: 'hPts', milestone: true },
  219: { market: 'hAst', milestone: true },
  231: { market: 'sog', milestone: true },
  232: { market: 'goals', milestone: true },
  271: { market: 'saves', milestone: true },
}

export const SIM_GROUPS = {
  goals: { G: 0.2, T: 0.45, P: 0.1, U: 0.4 },
  anyGoal: { G: 0.2, T: 0.45, P: 0.1, U: 0.4 },
  goals2: { G: 0.2, T: 0.45, P: 0.1, U: 0.4 },
  hAst: { G: 0.2, T: 0.45, P: 0.1, U: 0.4 },
  hPts: { G: 0.22, T: 0.5, P: 0.1, U: 0.45 },
  sog: { G: 0.25, T: 0.3, P: 0.25, U: 0.5 },
  // a busy night for a goalie is the other team shooting a lot (opp: the opponent's team factor)
  saves: { G: 0.25, T: 0.3, P: 0.2, U: 0.3, opp: true },
}

export const clockFor = () => ({ periods: 3, secs: 1200 })
export const TEAM_LABEL = 'Goals'
export const SPECIAL_TAB = { key: 'goals', label: 'Goal scorers', filter: (r) => r.market === 'anyGoal' }

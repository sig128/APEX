// Basketball (NBA, WNBA, men's college): markets from ESPN box score and game log stats, how
// roles and positions work, and which ESPN prop types map to which market.
import { mean } from '../lib/util.js'

const n = (x) => (Number.isFinite(x) ? x : 0)

/** Every basketball market. Keys are unique across sports (the market registry is shared). */
export const MARKETS = {
  pts: { keys: ['pts'], label: 'Points', long: 'Points', stat: (s) => n(s.pts), dist: 'normal', cv: 0.33, pos: ['G', 'F', 'C'], need: 'min' },
  reb: { keys: ['reb'], label: 'Rebounds', long: 'Rebounds', stat: (s) => n(s.reb), dist: 'normal', cv: 0.42, pos: ['G', 'F', 'C'], need: 'min' },
  ast: { keys: ['ast'], label: 'Assists', long: 'Assists', stat: (s) => n(s.ast), dist: 'poisson', pos: ['G', 'F', 'C'], need: 'min' },
  threes: { keys: ['tpm'], label: '3-Pointers', long: '3-Pointers Made', stat: (s) => n(s.tpm), dist: 'poisson', pos: ['G', 'F', 'C'], need: 'min' },
  stl: { keys: ['stl'], label: 'Steals', long: 'Steals', stat: (s) => n(s.stl), dist: 'poisson', pos: ['G', 'F', 'C'], need: 'min' },
  blk: { keys: ['blk'], label: 'Blocks', long: 'Blocks', stat: (s) => n(s.blk), dist: 'poisson', pos: ['G', 'F', 'C'], need: 'min' },
  pra: { keys: ['pts'], label: 'Pts + Reb + Ast', long: 'Points + Rebounds + Assists', stat: (s) => n(s.pts) + n(s.reb) + n(s.ast), dist: 'normal', cv: 0.27, pos: ['G', 'F', 'C'], need: 'min' },
  pr: { keys: ['pts'], label: 'Pts + Reb', long: 'Points + Rebounds', stat: (s) => n(s.pts) + n(s.reb), dist: 'normal', cv: 0.3, pos: ['G', 'F', 'C'], need: 'min' },
  pa: { keys: ['pts'], label: 'Pts + Ast', long: 'Points + Assists', stat: (s) => n(s.pts) + n(s.ast), dist: 'normal', cv: 0.3, pos: ['G', 'F', 'C'], need: 'min' },
  ra: { keys: ['reb'], label: 'Reb + Ast', long: 'Rebounds + Assists', stat: (s) => n(s.reb) + n(s.ast), dist: 'normal', cv: 0.36, pos: ['G', 'F', 'C'], need: 'min' },
  stlBlk: { keys: ['stl'], label: 'Steals + Blocks', long: 'Steals + Blocks', stat: (s) => n(s.stl) + n(s.blk), dist: 'poisson', pos: ['G', 'F', 'C'], need: 'min' },
}
export const CORE = ['pts', 'reb', 'ast', 'threes', 'pra', 'pr', 'pa']

export function posGroup(pos) {
  const p = String(pos || '').toUpperCase()
  if (p === 'PG' || p === 'SG' || p === 'G') return 'G'
  if (p === 'SF' || p === 'PF' || p === 'F' || p === 'GF' || p === 'FG') return 'F'
  if (p === 'C' || p === 'FC' || p === 'CF') return 'C'
  return p || 'OTHER'
}
export const GROUPS = ['G', 'F', 'C']
/** Who picks up the slack when a teammate sits. */
export const PEERS = { G: ['G'], F: ['F', 'C'], C: ['C', 'F'] }
export const KEY_POSITIONS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']
export const DVP_STATS = { G: ['pts', 'ast', 'threes', 'reb', 'pra'], F: ['pts', 'reb', 'ast', 'threes', 'pra'], C: ['pts', 'reb', 'ast', 'blk', 'pra'] }
export const GROUP_NAMES = { G: 'guards', F: 'forwards', C: 'centers' }
export const NOUN = { pts: 'points', reb: 'rebounds', ast: 'assists', threes: '3-pointers', pra: 'points + rebounds + assists', pr: 'points + rebounds', pa: 'points + assists', blk: 'blocks', stl: 'steals' }

/** Minutes are the role: starters play 30+, rotation players 18+. */
export function roleOf(player, logs, season) {
  const cur = logs.filter((r) => r.season === season).slice(-5)
  const rows = cur.length >= 2 ? cur : logs.slice(-5)
  if (!rows.length) return 0.5
  const m = mean(rows.map((r) => r.s?.min || 0))
  return m >= 28 ? 1 : m >= 22 ? 0.8 : m >= 16 ? 0.6 : m >= 10 ? 0.4 : 0.2
}

export const LOG_COLS = () => ['min', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'tov']
export const STAT_LABELS = { min: 'MIN', pts: 'PTS', reb: 'REB', ast: 'AST', tpm: '3PM', stl: 'STL', blk: 'BLK', tov: 'TO' }

/** Game log column names -> stat keys. "a-b" columns split into made and attempted. */
export const LOG_KEYS = {
  minutes: 'min',
  points: 'pts',
  totalRebounds: 'reb',
  rebounds: 'reb',
  assists: 'ast',
  steals: 'stl',
  blocks: 'blk',
  turnovers: 'tov',
  fouls: 'pf',
  'fieldGoalsMade-fieldGoalsAttempted': ['fgm', 'fga'],
  'threePointFieldGoalsMade-threePointFieldGoalsAttempted': ['tpm', 'tpa'],
  'freeThrowsMade-freeThrowsAttempted': ['ftm', 'fta'],
}
/** Box score columns use the same names, plus "rebounds" for the total. */
export const boxKeys = () => LOG_KEYS

/** ESPN prop bet type ids. Milestones ("20+ points") come in as alternate lines with a yes price. */
export const PROP_TYPES = {
  1: { market: 'pts' },
  2: { market: 'ast' },
  3: { market: 'reb' },
  4: { market: 'threes' },
  5: { market: 'stl' },
  6: { market: 'blk' },
  87: { market: 'pa' },
  88: { market: 'pr' },
  89: { market: 'ra' },
  90: { market: 'pra' },
  91: { market: 'stlBlk' },
  98: { market: 'teamPts' },
  218: { market: 'pts', milestone: true },
  219: { market: 'ast', milestone: true },
  220: { market: 'reb', milestone: true },
  221: { market: 'threes', milestone: true },
  222: { market: 'stl', milestone: true },
  223: { market: 'blk', milestone: true },
  225: { market: 'pra', milestone: true },
  226: { market: 'pa', milestone: true },
  227: { market: 'pr', milestone: true },
}

/** Simulator correlation groups (pace G, team offense T, team style P, the player U). */
export const SIM_GROUPS = {
  pts: { G: 0.3, T: 0.3, P: 0.2, U: 0.55 },
  reb: { G: 0.25, T: 0.1, P: -0.2, U: 0.55 },
  ast: { G: 0.25, T: 0.35, P: 0.25, U: 0.5 },
  threes: { G: 0.2, T: 0.2, P: 0.35, U: 0.5 },
  stl: { G: 0.15, T: 0, P: 0, U: 0.45 },
  blk: { G: 0.15, T: 0, P: -0.15, U: 0.45 },
  pra: { G: 0.35, T: 0.3, P: 0.1, U: 0.6 },
  pr: { G: 0.32, T: 0.25, P: 0, U: 0.6 },
  pa: { G: 0.33, T: 0.35, P: 0.25, U: 0.58 },
  ra: { G: 0.3, T: 0.25, P: 0, U: 0.55 },
  stlBlk: { G: 0.15, T: 0, P: 0, U: 0.45 },
}

/** Clock: four 12-minute quarters (WNBA 10, college two 20-minute halves). */
export const clockFor = (league) => (league === 'wnba' ? { periods: 4, secs: 600 } : league === 'mens-college-basketball' ? { periods: 2, secs: 1200 } : { periods: 4, secs: 720 })

export const TEAM_LABEL = 'Points'
/** The home page's last tab. */
export const SPECIAL_TAB = { key: 'threes', label: '3-pointers', filter: (r) => r.market === 'threes' }

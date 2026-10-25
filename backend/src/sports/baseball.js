// Baseball (MLB): batter and pitcher markets. Batter and pitcher logs use the same column names
// ("hits", "walks", "strikeouts") for different things, so each gets its own stat keys.
import { mean } from '../lib/util.js'

const n = (x) => (Number.isFinite(x) ? x : 0)
const singles = (s) => Math.max(0, n(s.h) - n(s.d2) - n(s.d3) - n(s.hr))
const BAT = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH', 'OF', 'IF', 'UT']

export const MARKETS = {
  hits: { keys: ['h'], label: 'Hits', long: 'Hits', stat: (s) => n(s.h), dist: 'poisson', pos: BAT, need: 'ab' },
  tb: { keys: ['h'], label: 'Total Bases', long: 'Total Bases', stat: (s) => singles(s) + 2 * n(s.d2) + 3 * n(s.d3) + 4 * n(s.hr), dist: 'poisson', pos: BAT, need: 'ab', live: false },
  hr: { keys: ['hr'], label: 'Home Runs', long: 'Home Runs', stat: (s) => n(s.hr), dist: 'poisson', pos: BAT, need: 'ab' },
  rbi: { keys: ['rbi'], label: 'RBIs', long: 'Runs Batted In', stat: (s) => n(s.rbi), dist: 'poisson', pos: BAT, need: 'ab' },
  runs: { keys: ['r'], label: 'Runs', long: 'Runs Scored', stat: (s) => n(s.r), dist: 'poisson', pos: BAT, need: 'ab' },
  hrr: { keys: ['h'], label: 'Hits + Runs + RBIs', long: 'Hits + Runs + RBIs', stat: (s) => n(s.h) + n(s.r) + n(s.rbi), dist: 'poisson', pos: BAT, need: 'ab' },
  singles: { keys: ['h'], label: 'Singles', long: 'Singles', stat: singles, dist: 'poisson', pos: BAT, need: 'ab', live: false },
  doubles: { keys: ['d2'], label: 'Doubles', long: 'Doubles', stat: (s) => n(s.d2), dist: 'poisson', pos: BAT, need: 'ab', live: false },
  bbB: { keys: ['bb'], label: 'Walks', long: 'Walks (Batter)', stat: (s) => n(s.bb), dist: 'poisson', pos: BAT, need: 'ab' },
  soB: { keys: ['so'], label: 'Strikeouts', long: 'Strikeouts (Batter)', stat: (s) => n(s.so), dist: 'poisson', pos: BAT, need: 'ab' },
  sbB: { keys: ['sb'], label: 'Stolen Bases', long: 'Stolen Bases', stat: (s) => n(s.sb), dist: 'poisson', pos: BAT, need: 'ab', live: false },
  kP: { keys: ['k'], label: 'Strikeouts', long: 'Pitcher Strikeouts', stat: (s) => n(s.k), dist: 'poisson', pos: ['SP', 'RP', 'P'], need: 'outs' },
  outs: { keys: ['outs'], label: 'Outs', long: 'Outs Recorded', stat: (s) => n(s.outs), dist: 'normal', cv: 0.22, pos: ['SP', 'RP', 'P'], need: 'outs' },
  erP: { keys: ['er'], label: 'Earned Runs', long: 'Earned Runs Allowed', stat: (s) => n(s.er), dist: 'poisson', pos: ['SP', 'RP', 'P'], need: 'outs' },
  haP: { keys: ['ha'], label: 'Hits Allowed', long: 'Hits Allowed', stat: (s) => n(s.ha), dist: 'poisson', pos: ['SP', 'RP', 'P'], need: 'outs' },
  bbP: { keys: ['bba'], label: 'Walks Allowed', long: 'Walks Allowed', stat: (s) => n(s.bba), dist: 'poisson', pos: ['SP', 'RP', 'P'], need: 'outs' },
}
export const CORE = ['hits', 'tb', 'hrr', 'rbi', 'runs', 'kP', 'outs']

export function posGroup(pos) {
  const p = String(pos || '').toUpperCase()
  if (p === 'SP' || p === 'P') return 'SP'
  if (p === 'RP' || p === 'CL') return 'RP'
  if (BAT.includes(p)) return 'BAT'
  return p || 'OTHER'
}
export const GROUPS = ['BAT', 'SP']
export const PEERS = { BAT: [], SP: [], RP: [] }
export const KEY_POSITIONS = []
export const DVP_STATS = { BAT: ['hits', 'tb', 'hr', 'rbi', 'runs'], SP: ['kP', 'outs', 'erP', 'haP'] }
export const GROUP_NAMES = { BAT: 'hitters', SP: 'starting pitchers', RP: 'relievers' }
export const NOUN = { hits: 'hits', tb: 'total bases', hr: 'home runs', rbi: 'RBIs', runs: 'runs', kP: 'strikeouts', outs: 'outs', erP: 'earned runs', haP: 'hits' }

/** Everyday hitters bat 4 times; starting pitchers get 15+ outs. */
export function roleOf(player, logs, season) {
  const cur = logs.filter((r) => r.season === season).slice(-5)
  const rows = cur.length >= 2 ? cur : logs.slice(-5)
  if (!rows.length) return 0.5
  const g = posGroup(player.pos)
  if (g === 'SP' || g === 'RP') {
    const outs = mean(rows.slice(-3).map((r) => r.s?.outs || 0))
    return outs >= 15 ? 1 : outs >= 9 ? 0.7 : 0.3
  }
  const ab = mean(rows.map((r) => r.s?.ab || 0))
  return ab >= 3.5 ? 1 : ab >= 2.5 ? 0.7 : 0.4
}

export const LOG_COLS = (group) => (group === 'SP' || group === 'RP' ? ['outs', 'k', 'ha', 'er', 'bba'] : ['ab', 'h', 'hr', 'rbi', 'r', 'bb'])
export const STAT_LABELS = { ab: 'AB', h: 'H', hr: 'HR', rbi: 'RBI', r: 'R', bb: 'BB', outs: 'OUTS', k: 'K', ha: 'H', er: 'ER', bba: 'BB' }

const BAT_KEYS = { atBats: 'ab', runs: 'r', hits: 'h', doubles: 'd2', triples: 'd3', homeRuns: 'hr', RBIs: 'rbi', walks: 'bb', hitByPitch: 'hbp', strikeouts: 'so', stolenBases: 'sb' }
const PIT_KEYS = { innings: { key: 'outs', parse: 'innings' }, 'fullInnings.partInnings': { key: 'outs', parse: 'innings' }, hits: 'ha', runs: 'ra', earnedRuns: 'er', homeRuns: 'hra', walks: 'bba', strikeouts: 'k', pitches: 'pc', battersFaced: 'bf' }
/** A pitcher's log has innings in it; everything else is a batter's. */
export const LOG_KEYS = (names) => ((names || []).includes('innings') ? PIT_KEYS : BAT_KEYS)
export const boxKeys = (cat) => ((cat?.keys || []).includes('fullInnings.partInnings') ? PIT_KEYS : BAT_KEYS)

export const PROP_TYPES = {
  53: { market: 'hits' },
  52: { market: 'tb' },
  56: { market: 'hrr' },
  58: { market: 'runs' },
  59: { market: 'rbi' },
  48: { market: 'singles' },
  49: { market: 'doubles' },
  251: { market: 'bbB' },
  46: { market: 'kP' },
  57: { market: 'outs' },
  55: { market: 'erP' },
  54: { market: 'haP' },
  61: { market: 'bbP' },
  149: { market: 'teamPts' },
  234: { market: 'hits', milestone: true },
  235: { market: 'kP', milestone: true },
  236: { market: 'tb', milestone: true },
  237: { market: 'rbi', milestone: true },
  238: { market: 'haP', milestone: true },
  239: { market: 'bbP', milestone: true },
  240: { market: 'hr', milestone: true },
  241: { market: 'singles', milestone: true },
  242: { market: 'sbB', milestone: true },
  243: { market: 'doubles', milestone: true },
  244: { market: 'runs', milestone: true },
  247: { market: 'erP', milestone: true },
  248: { market: 'hrr', milestone: true },
  249: { market: 'soB', milestone: true },
  250: { market: 'bbB', milestone: true },
}

export const SIM_GROUPS = {
  hits: { G: 0.2, T: 0.35, P: 0, U: 0.45 },
  tb: { G: 0.2, T: 0.35, P: 0, U: 0.45 },
  hr: { G: 0.15, T: 0.25, P: 0, U: 0.4 },
  rbi: { G: 0.25, T: 0.45, P: 0, U: 0.4 },
  runs: { G: 0.25, T: 0.45, P: 0, U: 0.4 },
  hrr: { G: 0.25, T: 0.45, P: 0, U: 0.45 },
  singles: { G: 0.15, T: 0.25, P: 0, U: 0.45 },
  doubles: { G: 0.15, T: 0.25, P: 0, U: 0.4 },
  bbB: { G: 0.1, T: 0.15, P: 0, U: 0.4 },
  soB: { G: 0.1, T: -0.15, P: 0, U: 0.45 },
  sbB: { G: 0.05, T: 0.1, P: 0, U: 0.4 },
  // a pitcher's numbers ride on the other lineup (opp: the team factor is the opponent's)
  kP: { G: 0.1, T: -0.3, P: 0, U: 0.55, opp: true },
  outs: { G: 0.15, T: -0.35, P: 0, U: 0.55, opp: true },
  erP: { G: 0.25, T: 0.45, P: 0, U: 0.45, opp: true },
  haP: { G: 0.25, T: 0.4, P: 0, U: 0.45, opp: true },
  bbP: { G: 0.1, T: 0.1, P: 0, U: 0.45, opp: true },
}

export const clockFor = () => ({ periods: 9, secs: null })
export const TEAM_LABEL = 'Runs'
export const SPECIAL_TAB = { key: 'hr', label: 'Home runs', filter: (r) => r.market === 'hr' }

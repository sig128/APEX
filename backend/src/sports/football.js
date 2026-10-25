// Football (NFL and college): the original APEX markets, roles and positions.
import { FOOTBALL_MARKETS, FOOTBALL_CORE, footballPos } from '../nfl/markets.js'
import { mean } from '../lib/util.js'

export const MARKETS = FOOTBALL_MARKETS
export const CORE = FOOTBALL_CORE
export const posGroup = footballPos
export const GROUPS = ['QB', 'RB', 'WR', 'TE']
export const PEERS = { WR: ['WR', 'TE'], TE: ['WR', 'TE'], RB: ['RB'], QB: ['QB'] }
export const KEY_POSITIONS = ['QB', 'RB', 'WR', 'TE']
export const DVP_STATS = {
  QB: ['passYds', 'passTd', 'passAtt', 'passCmp', 'rushYds'],
  RB: ['rushYds', 'rushAtt', 'rec', 'recYds', 'rushRecYds', 'anyTd'],
  WR: ['rec', 'recYds', 'anyTd', 'longRec'],
  TE: ['rec', 'recYds', 'anyTd'],
}
/** Markets that share a defense-vs-position stat with another one. */
export const DVP_ALIAS = { passRushYds: 'passYds', td2: 'anyTd' }
export const GROUP_NAMES = { QB: 'QBs', RB: 'RBs', WR: 'WRs', TE: 'TEs' }
export const NOUN = { passYds: 'passing yards', passTd: 'passing TDs', passAtt: 'pass attempts', passCmp: 'completions', rushYds: 'rushing yards', rushAtt: 'rushing attempts', rec: 'receptions', recYds: 'receiving yards', rushRecYds: 'scrimmage yards', anyTd: 'touchdowns', longRec: 'long catches' }

/**
 * How big the player's role is, 0..1, from recent usage: attempts for QBs, touches for backs,
 * targets for receivers.
 */
export function roleOf(player, logs, season) {
  const group = posGroup(player.pos)
  const cur = logs.filter((r) => r.season === season).slice(-5)
  const rows = cur.length >= 2 ? cur : logs.slice(-5)
  if (!rows.length) return 0.5
  const avg = (f) => mean(rows.map((r) => f(r.s || {})))
  if (group === 'QB') {
    const a = avg((s) => s.passAtt || 0)
    return a >= 22 ? 1 : a >= 12 ? 0.6 : 0.25
  }
  if (group === 'RB') {
    const t = avg((s) => (s.rushAtt || 0) + (s.rec || 0))
    return t >= 12 ? 1 : t >= 7 ? 0.7 : t >= 4 ? 0.45 : 0.25
  }
  if (group === 'WR' || group === 'TE') {
    const t = avg((s) => s.targets ?? (s.rec || 0) * 1.4)
    return t >= 6 ? 1 : t >= 4 ? 0.75 : t >= 2.5 ? 0.5 : 0.3
  }
  if (group === 'K') return 0.8
  if (group === 'DEF') {
    const t = avg((s) => s.tackles || 0)
    return t >= 6 ? 0.9 : t >= 3.5 ? 0.6 : 0.35
  }
  return 0.5
}

export const LOG_COLS = (group) =>
  group === 'QB' ? ['passCmp', 'passAtt', 'passYds', 'passTd', 'passInt', 'rushAtt', 'rushYds'] : group === 'RB' ? ['rushAtt', 'rushYds', 'rushTd', 'rec', 'recYds', 'targets'] : group === 'WR' || group === 'TE' ? ['rec', 'targets', 'recYds', 'recTd', 'longRec'] : group === 'K' ? ['fgMade', 'xpMade', 'kickPts'] : ['tackles', 'solo', 'sacks']

export const LOG_KEYS = {
  completions: 'passCmp',
  passingAttempts: 'passAtt',
  passingYards: 'passYds',
  passingTouchdowns: 'passTd',
  interceptions: 'passInt',
  longPassing: 'longPass',
  sacks: 'sacks',
  rushingAttempts: 'rushAtt',
  rushingYards: 'rushYds',
  rushingTouchdowns: 'rushTd',
  longRushing: 'longRush',
  receptions: 'rec',
  receivingTargets: 'targets',
  receivingYards: 'recYds',
  receivingTouchdowns: 'recTd',
  longReception: 'longRec',
  totalTackles: 'tackles',
  soloTackles: 'solo',
  fieldGoalsMade: 'fgMade',
  extraPointsMade: 'xpMade',
  totalKickingPoints: 'kickPts',
  fumblesLost: 'fumLost',
}

// Box score keys per category -> the same stat names the game logs use.
const BOX_KEYS = {
  passing: { completions: 'passCmp', passingAttempts: 'passAtt', passingYards: 'passYds', passingTouchdowns: 'passTd', interceptions: 'passInt', sacks: 'sacksTaken', longPassing: 'longPass' },
  rushing: { rushingAttempts: 'rushAtt', rushingYards: 'rushYds', rushingTouchdowns: 'rushTd', longRushing: 'longRush' },
  receiving: { receptions: 'rec', receivingYards: 'recYds', receivingTouchdowns: 'recTd', longReception: 'longRec', receivingTargets: 'targets' },
  fumbles: { fumbles: 'fum', fumblesLost: 'fumLost' },
  defensive: { totalTackles: 'tackles', soloTackles: 'solo', sacks: 'sacks', tacklesForLoss: 'tfl', passesDefended: 'pd', QBHits: 'qbHits', defensiveTouchdowns: 'defTd' },
  interceptions: { interceptions: 'defInt', interceptionTouchdowns: 'defIntTd' },
  kickReturns: { kickReturnTouchdowns: 'krTd' },
  puntReturns: { puntReturnTouchdowns: 'prTd' },
  kicking: { fieldGoalsMade: 'fgMade', fieldGoalAttempts: 'fgAtt', extraPointsMade: 'xpMade', totalKickingPoints: 'kickPts', longFieldGoalMade: 'longFg' },
}
export const boxKeys = (cat) => BOX_KEYS[cat?.name] || null

/** ESPN prop bet type ids -> our market keys (football lines come without prices). */
export const PROP_TYPES = {
  8: { market: 'passYds' },
  9: { market: 'passCmp' },
  10: { market: 'passTd' },
  11: { market: 'rushAtt' },
  12: { market: 'rushYds' },
  13: { market: 'recYds' },
  14: { market: 'rec' },
  15: { market: 'passInt' },
  16: { market: 'passAtt' },
  17: { market: 'longPass' },
  18: { market: 'passRushYds' },
  19: { market: 'longRec' },
  20: { market: 'rushRecYds' },
  21: { market: 'longRush' },
  22: { market: 'kickPts' },
  24: { market: 'fgMade' },
  26: { market: 'tackles' },
  27: { market: 'tacklesAst' },
  28: { market: 'sacks' },
  31: { market: 'anyTd', oneSided: true },
  32: { market: 'td2', oneSided: true },
  98: { market: 'teamPts' },
}

export const SIM_GROUPS = {
  passYds: { G: 0.25, T: 0.35, P: 0.45, U: 0.55 },
  passAtt: { G: 0.25, T: 0.35, P: 0.45, U: 0.55 },
  passCmp: { G: 0.25, T: 0.35, P: 0.45, U: 0.55 },
  passTd: { G: 0.25, T: 0.35, P: 0.45, U: 0.55 },
  longPass: { G: 0.25, T: 0.35, P: 0.45, U: 0.55 },
  passRushYds: { G: 0.25, T: 0.35, P: 0.45, U: 0.55 },
  passInt: { G: 0.1, T: -0.2, P: 0.35, U: 0.5 },
  rushYds: { G: 0.15, T: 0.3, P: -0.25, U: 0.55 },
  rushAtt: { G: 0.15, T: 0.3, P: -0.25, U: 0.55 },
  longRush: { G: 0.15, T: 0.3, P: -0.25, U: 0.55 },
  rec: { G: 0.25, T: 0.3, P: 0.4, U: 0.55 },
  recYds: { G: 0.25, T: 0.3, P: 0.4, U: 0.55 },
  longRec: { G: 0.25, T: 0.3, P: 0.4, U: 0.55 },
  rushRecYds: { G: 0.2, T: 0.35, P: 0.1, U: 0.55 },
  anyTd: { G: 0.25, T: 0.45, P: 0, U: 0.4 },
  td2: { G: 0.25, T: 0.45, P: 0, U: 0.4 },
  fgMade: { G: 0.3, T: 0.35, P: 0, U: 0.5 },
  kickPts: { G: 0.3, T: 0.35, P: 0, U: 0.5 },
}

export const clockFor = () => ({ periods: 4, secs: 900 })
export const TEAM_LABEL = 'Points'
export const SPECIAL_TAB = { key: 'tds', label: 'Touchdowns', filter: (r) => r.market === 'anyTd' }

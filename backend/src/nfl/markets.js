// Player and team prop markets: how to read each from a stat line, and how it behaves.
import { MARKETS as BASKETBALL_MARKETS } from '../sports/basketball.js'
import { MARKETS as HOCKEY_MARKETS } from '../sports/hockey.js'
import { MARKETS as BASEBALL_MARKETS } from '../sports/baseball.js'
const n = (x) => (Number.isFinite(x) ? x : 0)

/**
 * dist: normal (yards, attempts) or poisson (counts like TDs, receptions, sacks).
 * cv: typical game-to-game spread relative to the mean, used to steady small samples.
 * oneSided: only "yes" is offered (anytime TD). line is fixed for those.
 * live: false when the live box score can't track it (ESPN's box has no longest completion).
 * keys: a game only counts when at least one of these stats was recorded (missing is not zero).
 */
export const FOOTBALL_MARKETS = {
  passYds: { keys: ['passYds'], label: 'Pass Yards', long: 'Passing Yards', stat: (s) => n(s.passYds), dist: 'normal', cv: 0.27, pos: ['QB'], need: 'passAtt' },
  passAtt: { keys: ['passAtt'], label: 'Pass Attempts', long: 'Passing Attempts', stat: (s) => n(s.passAtt), dist: 'normal', cv: 0.2, pos: ['QB'], need: 'passAtt' },
  passCmp: { keys: ['passCmp'], label: 'Completions', long: 'Pass Completions', stat: (s) => n(s.passCmp), dist: 'normal', cv: 0.22, pos: ['QB'], need: 'passAtt' },
  passTd: { keys: ['passTd'], label: 'Pass TDs', long: 'Passing Touchdowns', stat: (s) => n(s.passTd), dist: 'poisson', pos: ['QB'], need: 'passAtt' },
  passInt: { keys: ['passInt'], label: 'Interceptions', long: 'Interceptions Thrown', stat: (s) => n(s.passInt), dist: 'poisson', pos: ['QB'], need: 'passAtt' },
  longPass: { keys: ['longPass'], label: 'Longest Completion', long: 'Longest Completion', stat: (s) => n(s.longPass), dist: 'normal', cv: 0.35, pos: ['QB'], need: 'passAtt', live: false },
  passRushYds: { keys: ['passYds'], label: 'Pass + Rush Yards', long: 'Passing + Rushing Yards', stat: (s) => n(s.passYds) + n(s.rushYds), dist: 'normal', cv: 0.26, pos: ['QB'], need: 'passAtt' },
  rushYds: { keys: ['rushYds', 'rushAtt'], label: 'Rush Yards', long: 'Rushing Yards', stat: (s) => n(s.rushYds), dist: 'normal', cv: 0.45, pos: ['RB', 'QB', 'WR', 'FB'] },
  rushAtt: { keys: ['rushAtt'], label: 'Rush Attempts', long: 'Rushing Attempts', stat: (s) => n(s.rushAtt), dist: 'normal', cv: 0.32, pos: ['RB', 'QB', 'FB'] },
  longRush: { keys: ['longRush'], label: 'Longest Rush', long: 'Longest Rush', stat: (s) => n(s.longRush), dist: 'normal', cv: 0.55, pos: ['RB', 'QB', 'WR'] },
  rec: { keys: ['rec', 'targets'], label: 'Receptions', long: 'Receptions', stat: (s) => n(s.rec), dist: 'poisson', pos: ['WR', 'TE', 'RB', 'FB'] },
  recYds: { keys: ['recYds', 'rec'], label: 'Receiving Yards', long: 'Receiving Yards', stat: (s) => n(s.recYds), dist: 'normal', cv: 0.6, pos: ['WR', 'TE', 'RB', 'FB'] },
  longRec: { keys: ['longRec'], label: 'Longest Reception', long: 'Longest Reception', stat: (s) => n(s.longRec), dist: 'normal', cv: 0.55, pos: ['WR', 'TE', 'RB'] },
  rushRecYds: { keys: ['rushYds', 'recYds'], label: 'Rush + Rec Yards', long: 'Rushing + Receiving Yards', stat: (s) => n(s.rushYds) + n(s.recYds), dist: 'normal', cv: 0.4, pos: ['RB', 'WR', 'TE', 'QB'] },
  anyTd: { keys: ['rushTd', 'recTd'], label: 'Anytime TD', long: 'Anytime Touchdown', stat: (s) => n(s.rushTd) + n(s.recTd) + n(s.krTd) + n(s.prTd) + n(s.defTd) + n(s.defIntTd), dist: 'poisson', oneSided: true, fixedLine: 0.5, pos: ['RB', 'WR', 'TE', 'QB', 'FB'] },
  td2: { keys: ['rushTd', 'recTd'], label: '2+ TDs', long: '2+ Touchdowns', stat: (s) => n(s.rushTd) + n(s.recTd) + n(s.krTd) + n(s.prTd) + n(s.defTd) + n(s.defIntTd), dist: 'poisson', oneSided: true, fixedLine: 1.5, pos: ['RB', 'WR', 'TE', 'QB'] },
  tackles: { keys: ['solo'], label: 'Solo Tackles', long: 'Solo Tackles', stat: (s) => n(s.solo), dist: 'normal', cv: 0.5, pos: ['LB', 'S', 'CB', 'DE', 'DT', 'OLB', 'ILB', 'MLB', 'FS', 'SS', 'NT', 'EDGE'] },
  tacklesAst: { keys: ['tackles'], label: 'Tackles + Assists', long: 'Tackles + Assists', stat: (s) => n(s.tackles), dist: 'normal', cv: 0.42, pos: ['LB', 'S', 'CB', 'DE', 'DT', 'OLB', 'ILB', 'MLB', 'FS', 'SS', 'NT', 'EDGE'] },
  sacks: { keys: ['sacks', 'tackles'], label: 'Sacks', long: 'Sacks', stat: (s) => n(s.sacks), dist: 'poisson', pos: ['DE', 'DT', 'LB', 'OLB', 'EDGE', 'NT', 'ILB', 'MLB'] },
  fgMade: { keys: ['fgMade'], label: 'Field Goals', long: 'Field Goals Made', stat: (s) => n(s.fgMade), dist: 'poisson', pos: ['PK', 'K'] },
  kickPts: { keys: ['kickPts'], label: 'Kicking Points', long: 'Kicking Points', stat: (s) => n(s.kickPts), dist: 'normal', cv: 0.42, pos: ['PK', 'K'] },
}

export const TEAM_MARKETS = {
  teamPts: { label: 'Team Total', long: 'Team Total', dist: 'normal', cv: 0.38 },
}

export const FOOTBALL_CORE = ['passYds', 'passAtt', 'passCmp', 'passTd', 'rushYds', 'rushAtt', 'rec', 'recYds', 'rushRecYds', 'anyTd']
export const CORE_MARKETS = FOOTBALL_CORE

/** Every sport's markets in one registry: keys are unique across sports. */
export const MARKETS = { ...FOOTBALL_MARKETS, ...BASKETBALL_MARKETS, ...HOCKEY_MARKETS, ...BASEBALL_MARKETS }
export const MARKET_KEYS = Object.keys(MARKETS)

export function marketOf(key) {
  return MARKETS[key] || TEAM_MARKETS[key] || null
}

/** "Over 257.5 Pass Yards", "Anytime TD", "Under 16.5 Rush Attempts". */
export function propLabel(market, side, line) {
  const m = marketOf(market)
  if (!m) return market
  if (m.oneSided) return m.label
  return `${side === 'u' ? 'Under' : 'Over'} ${line} ${m.long}`
}

export function shortLabel(market, side, line) {
  const m = marketOf(market)
  if (!m) return market
  if (m.oneSided) return m.label
  return `${side === 'u' ? 'U' : 'O'} ${line} ${m.label}`
}

export const footballPos = (pos) => {
  const p = String(pos || '').toUpperCase()
  if (p === 'QB') return 'QB'
  if (p === 'RB' || p === 'FB' || p === 'HB') return 'RB'
  if (p === 'WR') return 'WR'
  if (p === 'TE') return 'TE'
  if (p === 'PK' || p === 'K') return 'K'
  if (['DE', 'DT', 'NT', 'EDGE', 'OLB', 'ILB', 'MLB', 'LB', 'CB', 'S', 'FS', 'SS', 'DB'].includes(p)) return 'DEF'
  return p || 'OTHER'
}

/** Football's position groups (kept under the old name for the NFL code paths). */
export const POS_GROUP = footballPos

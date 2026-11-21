// Soccer (Premier League, LaLiga, Serie A, Bundesliga, MLS): player shot, goal, assist, save and
// foul markets. ESPN has no game logs for soccer players, so each player's log is built from the
// lineups in his team's match summaries (who started, who came on, and each player's stats).
// Few sportsbooks' soccer props reach ESPN, so the board offers the standard lines (Over 0.5
// shots on target, anytime goal...) nearest each player's usual output: research lines, not
// posted ones, until a sportsbook price comes in for them.
import { mean } from '../lib/util.js'

const n = (x) => (Number.isFinite(x) ? x : 0)
const FIELD = ['F', 'M', 'D']

export const MARKETS = {
  shots: { keys: ['sh'], label: 'Shots', long: 'Shots', stat: (s) => n(s.sh), dist: 'poisson', pos: FIELD, need: 'app' },
  sot: { keys: ['sot'], label: 'Shots on Target', long: 'Shots on Target', stat: (s) => n(s.sot), dist: 'poisson', pos: FIELD, need: 'app' },
  anyGoalS: { keys: ['g'], label: 'Anytime Goal', long: 'Anytime Goalscorer', stat: (s) => n(s.g), dist: 'poisson', oneSided: true, fixedLine: 0.5, pos: FIELD, need: 'app' },
  anyAst: { keys: ['a'], label: 'Anytime Assist', long: 'To Record an Assist', stat: (s) => n(s.a), dist: 'poisson', oneSided: true, fixedLine: 0.5, pos: FIELD, need: 'app' },
  gkSaves: { keys: ['sv'], label: 'Saves', long: 'Goalkeeper Saves', stat: (s) => n(s.sv), dist: 'poisson', pos: ['G'], need: 'app' },
  fouls: { keys: ['fc'], label: 'Fouls', long: 'Fouls Committed', stat: (s) => n(s.fc), dist: 'poisson', pos: FIELD, need: 'app' },
}
export const CORE = ['shots', 'sot', 'anyGoalS', 'anyAst', 'gkSaves']

/** ESPN writes positions both ways: G/D/M/F on rosters, CB-L, LW, CF... on match lineups. */
export function posGroup(pos) {
  const p = String(pos || '')
    .toUpperCase()
    .replace(/-[LR]$/, '')
  if (p === 'G' || p === 'GK') return 'G'
  if (p === 'D' || /^(CB|CD|LB|RB|LWB|RWB|SW|DF)$/.test(p)) return 'D'
  if (p === 'M' || /^(CM|DM|CDM|AM|CAM|LM|RM|MF)$/.test(p)) return 'M'
  if (p === 'F' || /^(CF|ST|LW|RW|W|SS|FW|LF|RF)$/.test(p)) return 'F'
  return 'M'
}
export const GROUPS = ['F', 'M', 'D', 'G']
export const PEERS = { F: ['F', 'M'], M: ['M', 'F'], D: ['D'], G: [] }
export const KEY_POSITIONS = ['F', 'M', 'D', 'G', 'GK', 'CF', 'ST', 'LW', 'RW', 'AM', 'CM', 'DM', 'CB', 'LB', 'RB']
export const DVP_STATS = { F: ['shots', 'sot'], M: ['shots', 'sot'], D: ['shots'], G: ['gkSaves'] }
export const GROUP_NAMES = { F: 'forwards', M: 'midfielders', D: 'defenders', G: 'goalkeepers' }
export const NOUN = { shots: 'shots', sot: 'shots on target', anyGoalS: 'goals', anyAst: 'assists', gkSaves: 'saves', fouls: 'fouls' }

/** Starting is the role: a regular starter is 1, a rotation player less, a substitute least. */
export function roleOf(player, logs, season) {
  const cur = logs.filter((r) => r.season === season).slice(-5)
  const rows = cur.length >= 2 ? cur : logs.slice(-5)
  if (!rows.length) return 0.5
  const started = mean(rows.map((r) => (r.s?.gs ? 1 : 0)))
  return started >= 0.8 ? 1 : started >= 0.6 ? 0.8 : started >= 0.4 ? 0.6 : 0.35
}

export const LOG_COLS = (group) => (group === 'G' ? ['min', 'sv', 'ga'] : ['min', 'sh', 'sot', 'g', 'a'])
export const STAT_LABELS = { min: 'MIN', sh: 'SH', sot: 'SOT', g: 'G', a: 'A', sv: 'SV', ga: 'GA', fc: 'FC' }

/** ESPN's stat names on match lineups -> ours. */
export const LOG_KEYS = {
  totalShots: 'sh',
  shotsOnTarget: 'sot',
  totalGoals: 'g',
  goalAssists: 'a',
  saves: 'sv',
  goalsConceded: 'ga',
  shotsFaced: 'sf',
  foulsCommitted: 'fc',
  foulsSuffered: 'fs',
  yellowCards: 'yc',
  redCards: 'rc',
  offsides: 'off',
  ownGoals: 'og',
}
export const boxKeys = () => null
// no game logs on ESPN for soccer players: they come from match lineups (see the ESPN client)
export const LOGS_FROM_SUMMARIES = true

// ESPN's prop bet ids for soccer aren't known to carry lines; the standard lines below stand in
export const PROP_TYPES = {}
/** The lines offered for each market: the one nearest a player's usual output goes on the board. */
export const MODEL_LINES = {
  shots: [0.5, 1.5, 2.5, 3.5, 4.5],
  sot: [0.5, 1.5, 2.5],
  gkSaves: [1.5, 2.5, 3.5, 4.5, 5.5],
  fouls: [0.5, 1.5, 2.5],
  anyGoalS: [0.5],
  anyAst: [0.5],
  teamPts: [0.5, 1.5, 2.5, 3.5],
}
/** Which markets each position gets on the board. */
export const BOARD_MARKETS = { F: ['shots', 'sot', 'anyGoalS', 'anyAst', 'fouls'], M: ['shots', 'sot', 'anyGoalS', 'anyAst', 'fouls'], D: ['shots', 'anyGoalS', 'fouls'], G: ['gkSaves'] }

export const SIM_GROUPS = {
  shots: { G: 0.3, T: 0.45, P: 0, U: 0.5 },
  sot: { G: 0.3, T: 0.45, P: 0, U: 0.45 },
  anyGoalS: { G: 0.3, T: 0.5, P: 0, U: 0.4 },
  anyAst: { G: 0.3, T: 0.5, P: 0, U: 0.35 },
  fouls: { G: 0.2, T: -0.1, P: 0, U: 0.5 },
  // a busy day for a keeper is the other team shooting a lot (opp: the opponent's team factor)
  gkSaves: { G: 0.25, T: 0.45, P: 0, U: 0.3, opp: true },
}

// two 45-minute halves on a clock that counts up ("67'", "45'+2'")
export const clockFor = () => ({ periods: 2, secs: 2700, up: true })
export const TEAM_LABEL = 'Goals'
export const SPECIAL_TAB = { key: 'scorers', label: 'Goal scorers', filter: (r) => r.market === 'anyGoalS' }

const stat = (list, name) => {
  const s = (list || []).find((x) => x?.name === name)
  const v = Number(s?.value ?? s?.displayValue)
  return Number.isFinite(v) ? v : null
}
const minuteOf = (clock) => {
  const m = /^(\d{1,3})/.exec(String(clock?.displayValue ?? clock ?? ''))
  return m ? Number(m[1]) : null
}

/**
 * Players from a match summary's lineups: { [athleteId]: { id, name, short, jersey, teamId, pos,
 * stats } }. Only players who got on the field; minutes from the substitutions where ESPN has
 * them (else 90 for a full match, about 70 for a starter taken off, about 20 for a substitute).
 */
export function summaryPlayers(j) {
  const subs = new Map() // athleteId -> { on, off } minutes
  for (const e of j?.keyEvents || j?.commentary || []) {
    const type = String(e?.type?.type || e?.type?.text || '').toLowerCase()
    if (!type.includes('substitution')) continue
    const min = minuteOf(e.clock)
    const ps = e.participants || []
    // ESPN lists the player coming on first, the one going off second
    const on = ps[0]?.athlete?.id
    const off = ps[1]?.athlete?.id
    if (on) subs.set(String(on), { ...(subs.get(String(on)) || {}), on: min })
    if (off) subs.set(String(off), { ...(subs.get(String(off)) || {}), off: min })
  }
  const players = {}
  for (const side of j?.rosters || []) {
    const teamId = String(side.team?.id || '')
    for (const row of side.roster || []) {
      const a = row.athlete || {}
      if (!a.id) continue
      const played = row.starter === true || row.subbedIn === true || (stat(row.stats, 'appearances') || 0) > 0
      if (!played || row.didNotPlay === true) continue
      const s = { app: 1, gs: row.starter ? 1 : 0 }
      for (const [name, key] of Object.entries(LOG_KEYS)) {
        const v = stat(row.stats, name)
        if (v != null) s[key] = v
      }
      const sub = subs.get(String(a.id)) || {}
      const on = row.starter ? 0 : Number.isFinite(sub.on) ? sub.on : 70
      const off = Number.isFinite(sub.off) ? sub.off : row.subbedOut ? (row.starter ? 70 : 90) : 90
      s.min = Math.max(1, Math.min(90, off) - Math.min(89, on))
      players[String(a.id)] = { id: String(a.id), name: a.displayName || a.fullName || '', short: a.shortName || '', jersey: row.jersey || a.jersey || '', teamId, pos: row.position?.abbreviation || a.position?.abbreviation || '', stats: s }
    }
  }
  return players
}

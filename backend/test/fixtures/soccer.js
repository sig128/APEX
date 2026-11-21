// A Premier League matchweek on ESPN's soccer shapes (scoreboard by date range, team rosters and
// schedules, match summaries whose lineups carry each player's numbers), with invented players.
// No prop feed: the board runs on the standard lines.
import { etDay } from '../../src/nfl/engine.js'

export const SITE = 'site.api.espn.com/apis/site/v2/sports/soccer/eng.1'
export const NOW = Date.parse('2026-11-20T15:00:00Z')
const DAY = 86_400_000

export const TEAMS = [
  { id: '359', abbr: 'ARS', name: 'Arsenal', gf: 2.1 },
  { id: '363', abbr: 'CHE', name: 'Chelsea', gf: 1.6 },
  { id: '364', abbr: 'LIV', name: 'Liverpool', gf: 2.3 },
  { id: '382', abbr: 'MCI', name: 'Manchester City', gf: 2.0 },
]
// per team: a keeper, two defenders, two midfielders, two forwards (and a bench forward)
const SHAPES = [
  { pos: 'G', lineup: 'G', sh: 0, sot: 0, g: 0, a: 0, sv: 3.2, fc: 0.1, start: 1 },
  { pos: 'D', lineup: 'CD-L', sh: 0.5, sot: 0.1, g: 0.04, a: 0.03, fc: 1.1, start: 1 },
  { pos: 'D', lineup: 'RB', sh: 0.7, sot: 0.2, g: 0.05, a: 0.12, fc: 1.2, start: 1 },
  { pos: 'M', lineup: 'CM', sh: 1.4, sot: 0.5, g: 0.12, a: 0.2, fc: 1.4, start: 1 },
  { pos: 'M', lineup: 'AM', sh: 2.1, sot: 0.8, g: 0.25, a: 0.3, fc: 0.9, start: 1 },
  { pos: 'F', lineup: 'CF', sh: 3.4, sot: 1.5, g: 0.55, a: 0.15, fc: 1.0, start: 1 },
  { pos: 'F', lineup: 'LW', sh: 2.6, sot: 1.1, g: 0.35, a: 0.25, fc: 0.8, start: 1 },
  { pos: 'F', lineup: 'SUB', sh: 0.9, sot: 0.3, g: 0.1, a: 0.05, fc: 0.4, start: 0 },
]
export const PLAYERS = TEAMS.flatMap((t, ti) => SHAPES.map((sh, i) => ({ ...sh, id: String(9000 + ti * 10 + i), teamId: t.id, name: `${t.name.split(' ')[0]} ${['Keeper', 'Stopper', 'Fullback', 'Engine', 'Creator', 'Striker', 'Winger', 'Sub'][i]}` })))

// a steady pseudo-random wobble so the logs vary but the tests don't
const wob = (a, b) => (((a * 9301 + b * 49297) % 233280) / 233280)
const count = (mean, a, b) => {
  // a rough Poisson draw from the wobble
  const u = wob(a, b)
  let k = 0
  let p = Math.exp(-mean)
  let c = p
  while (u > c && k < 12) {
    k++
    p *= mean / k
    c += p
  }
  return k
}

const teamRef = (t) => ({ id: t.id, abbreviation: t.abbr, displayName: t.name, shortDisplayName: t.name.split(' ').pop(), name: t.name, location: t.name, logo: `https://a.espncdn.com/i/teamlogos/soccer/500/${t.id}.png` })
const other = (i) => ({ id: String(500 + (i % 6)), abbr: `T${i % 6}`, name: `Town ${i % 6}`, gf: 1.2 })

/** Completed league matches for a team in a season: n of them, every 7 days before `end`. */
function matchesFor(team, season, n, end) {
  const out = []
  for (let i = 0; i < n; i++) {
    const opp = i % 3 === 0 ? TEAMS[(TEAMS.indexOf(team) + 1 + (i % 2)) % TEAMS.length] : other(i)
    const home = i % 2 === 0
    // a match between two of the four teams has one id both schedules share
    const pairKey = [team.id, opp.id].sort().join('')
    const id = `${season}${pairKey}${String(i).padStart(2, '0')}`
    const date = new Date(end - (n - i) * 7 * DAY).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z')
    const pf = count(team.gf, Number(team.id) + i, season)
    const pa = count(opp.gf || 1.2, Number(opp.id) + i, season + 1)
    out.push({ id, date, team, opp, home, pf, pa })
  }
  return out
}

/** URL -> response for the matchweek. */
export function soccerFixtures({ now = NOW } = {}) {
  const f = {}
  const season = 2026
  const up = [
    { id: '740001', home: TEAMS[0], away: TEAMS[1], date: new Date(now + 1 * DAY).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z') },
    { id: '740002', home: TEAMS[2], away: TEAMS[3], date: new Date(now + 2 * DAY).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z') },
  ]
  const status = (state) => ({ clock: 0, displayClock: state === 'pre' ? "0'" : "90'+4'", period: state === 'pre' ? 0 : 2, type: { id: state === 'pre' ? '1' : '28', name: state === 'pre' ? 'STATUS_SCHEDULED' : 'STATUS_FULL_TIME', state, completed: state === 'post', description: state === 'pre' ? 'Scheduled' : 'Full Time', detail: state === 'pre' ? 'Scheduled' : 'FT', shortDetail: state === 'pre' ? 'Scheduled' : 'FT' } })
  const competitor = (t, side, score) => ({ id: t.id, homeAway: side, team: teamRef(t), score: score == null ? '0' : String(score) })
  f[`${SITE}/scoreboard?dates=${etDay(now, -1)}-${etDay(now, 7)}&limit=200`] = {
    leagues: [{ season: { year: season, type: 1 } }],
    season: { year: season, type: 1 },
    events: up.map((g) => ({ id: g.id, date: g.date, name: `${g.away.name} at ${g.home.name}`, shortName: `${g.away.abbr} @ ${g.home.abbr}`, season: { year: season, type: 1 }, competitions: [{ id: g.id, date: g.date, competitors: [competitor(g.home, 'home'), competitor(g.away, 'away')], status: status('pre'), venue: { fullName: 'A Ground', address: { city: 'London' } } }] })),
  }
  f[`${SITE}/teams`] = { sports: [{ leagues: [{ teams: TEAMS.map((t) => ({ team: teamRef(t) })) }] }] }
  for (const g of up) f[`${SITE}/summary?event=${g.id}`] = { header: { id: g.id, competitions: [{ id: g.id, date: g.date, status: status('pre'), competitors: [competitor(g.home, 'home'), competitor(g.away, 'away')] }] }, rosters: [], keyEvents: [] }
  for (const t of TEAMS) {
    f[`${SITE}/teams/${t.id}/roster`] = { team: { id: t.id }, athletes: PLAYERS.filter((p) => p.teamId === t.id).map((p) => ({ id: p.id, displayName: p.name, shortName: p.name.replace(/^(\w)\w+/, '$1.'), position: { abbreviation: p.pos }, jersey: String(Number(p.id) % 30) })) }
  }
  // schedules and match summaries for this season and last
  const matchTeams = new Map()
  for (const [yr, n, end] of [
    [season, 10, now - 2 * DAY],
    [season - 1, 14, now - 120 * DAY],
  ]) {
    for (const t of TEAMS) {
      const list = matchesFor(t, yr, n, end)
      f[`${SITE}/teams/${t.id}/schedule?season=${yr}`] = {
        team: { id: t.id },
        events: list.map((m) => ({ id: m.id, date: m.date, competitions: [{ id: m.id, date: m.date, status: status('post'), competitors: [{ id: t.id, homeAway: m.home ? 'home' : 'away', team: teamRef(t), score: { value: m.pf, displayValue: String(m.pf) } }, { id: m.opp.id, homeAway: m.home ? 'away' : 'home', team: teamRef(m.opp), score: { value: m.pa, displayValue: String(m.pa) } }] }] })),
      }
      for (const m of list) {
        if (!matchTeams.has(m.id)) matchTeams.set(m.id, { m, teams: new Set() })
        matchTeams.get(m.id).teams.add(t.id)
      }
    }
  }
  for (const [id, { m, teams }] of matchTeams) {
    const rosters = []
    const keyEvents = []
    for (const tid of teams) {
      const roster = PLAYERS.filter((p) => p.teamId === tid).map((p, k) => {
        const seed = Number(id.slice(-6)) + k * 13
        const starter = p.start === 1 && !(k === 6 && wob(seed, 3) < 0.25)
        const cameOn = !starter && wob(seed, 5) < 0.6
        const played = starter || cameOn
        const sh = played ? count(p.sh * (starter ? 1 : 0.35), seed, 1) : 0
        const sot = Math.min(sh, played ? count(p.sot * (starter ? 1 : 0.35), seed, 2) : 0)
        const g = Math.min(sot, played ? count(p.g, seed, 4) : 0)
        // the forward who starts on the left comes off around the hour; the bench forward goes on for him
        if (k === 6 && starter && cameOnAlso(seed)) keyEvents.push({ type: { type: 'substitution', text: 'Substitution' }, clock: { displayValue: "64'" }, participants: [{ athlete: { id: PLAYERS.find((x) => x.teamId === tid && x.lineup === 'SUB').id } }, { athlete: { id: p.id } }] })
        return {
          active: true,
          starter,
          subbedIn: cameOn,
          subbedOut: k === 6 && starter && cameOnAlso(seed),
          didNotPlay: !played,
          jersey: String(Number(p.id) % 30),
          athlete: { id: p.id, displayName: p.name, shortName: p.name.replace(/^(\w)\w+/, '$1.') },
          position: { abbreviation: p.lineup },
          stats: played
            ? [
                { name: 'appearances', value: 1 },
                { name: 'totalShots', value: sh },
                { name: 'shotsOnTarget', value: sot },
                { name: 'totalGoals', value: g },
                { name: 'goalAssists', value: count(p.a, seed, 6) },
                { name: 'foulsCommitted', value: count(p.fc, seed, 7) },
                { name: 'yellowCards', value: wob(seed, 8) < 0.12 ? 1 : 0 },
                ...(p.pos === 'G' ? [{ name: 'saves', value: count(p.sv, seed, 9) }, { name: 'goalsConceded', value: count(1.1, seed, 10) }] : []),
              ]
            : [{ name: 'appearances', value: 0 }],
        }
      })
      rosters.push({ team: { id: tid }, roster, formation: '4-3-3' })
    }
    const home = m.home ? m.team : m.opp
    const away = m.home ? m.opp : m.team
    f[`${SITE}/summary?event=${id}`] = {
      header: { id, competitions: [{ id, date: m.date, status: status('post'), competitors: [competitor(home, 'home', m.home ? m.pf : m.pa), competitor(away, 'away', m.home ? m.pa : m.pf)] }] },
      rosters,
      keyEvents,
    }
  }
  return f
}
const cameOnAlso = (seed) => wob(seed, 11) < 0.6

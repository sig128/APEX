// An NBA day on ESPN's real shapes (LAL @ UTAH from test/fixtures/nba-sample.json), with
// invented players, logs and priced lines: for the NBA tests and the local preview harness.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { etDay } from '../../src/nfl/engine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const S = JSON.parse(fs.readFileSync(path.join(here, 'nba-sample.json'), 'utf8'))
export const SITE = 'site.api.espn.com/apis/site/v2/sports/basketball/nba'
export const WEB = 'site.web.api.espn.com/apis/common/v3/sports/basketball/nba'
export const CORE = 'sports.core.api.espn.com/v2/sports/basketball/leagues/nba'
export const NOW = Date.parse('2026-10-25T15:00:00Z')
export const PLAYERS = [
  { id: '101', team: '13', name: 'Laker Guard', pos: 'G', pts: 27, reb: 5, ast: 7 },
  { id: '102', team: '13', name: 'Laker Big', pos: 'C', pts: 22, reb: 11, ast: 3 },
  { id: '201', team: '26', name: 'Jazz Wing', pos: 'F', pts: 18, reb: 6, ast: 3 },
  { id: '202', team: '26', name: 'Jazz Guard', pos: 'G', pts: 15, reb: 3, ast: 6 },
]

/** URL -> response for the whole day. `now` sets which day counts as tomorrow. */
export function nbaFixtures({ now = NOW, players = PLAYERS } = {}) {

  const ev = S.scoreboard.events[0]
  const opp = (t) => (t === '13' ? { id: '26', abbreviation: 'UTAH' } : { id: '13', abbreviation: 'LAL' })
  const log = (p, season, games) => {
    const events = {}
    const rows = []
    for (let i = 0; i < games; i++) {
      const id = `${season}${p.id}${String(i).padStart(3, '0')}`
      const wob = ((i * 7 + Number(p.id)) % 9) - 4
      const pts = Math.max(0, p.pts + wob * 2)
      const reb = Math.max(0, p.reb + (wob % 3))
      const ast = Math.max(0, p.ast + ((wob + 1) % 3))
      rows.push({ eventId: id, stats: [String(32 + (wob % 3)), `${Math.round(pts / 2.4)}-${Math.round(pts / 1.1)}`, '45.0', `${Math.max(0, 2 + (wob % 2))}-6`, '33.3', '4-5', '80.0', String(reb), String(ast), '1', '1', '2', '2', String(pts)] })
      const o = i % 4 === 0 ? opp(p.team) : { id: String(1 + (i % 12)), abbreviation: `T${i % 12}` }
      events[id] = { id, gameDate: new Date(Date.parse(season === 2027 ? '2026-10-21T02:00:00Z' : '2025-11-01T02:00:00Z') + i * 2 * 86_400_000).toISOString(), atVs: i % 2 ? '@' : 'vs', gameResult: i % 2 ? 'W' : 'L', score: '110-104', opponent: o, team: { id: p.team, abbreviation: p.team === '13' ? 'LAL' : 'UTAH' } }
    }
    return { names: S.gamelog.names, labels: S.gamelog.labels, seasonTypes: [{ displayName: `${season - 1}-${String(season).slice(2)} Regular Season`, categories: [{ type: 'event', events: rows.reverse() }] }], events }
  }
  const odds = (v) => ({ american: { value: v > 0 ? `+${v}` : String(v), open: String(v) } })
  const items = []
  for (const p of players) {
    const ref = { $ref: `http://${CORE}/seasons/2027/athletes/${p.id}?lang=en&region=us` }
    const line = p.pts - 3.5
    items.push({ type: { id: '1' }, athlete: ref, current: { target: { value: line } }, open: { target: { value: line } }, odds: odds(-115), lastUpdated: '2026-10-25T12:00Z' })
    items.push({ type: { id: '1' }, athlete: ref, current: { target: { value: line } }, open: { target: { value: line } }, odds: odds(-105), lastUpdated: '2026-10-25T12:00Z' })
    items.push({ type: { id: '218' }, athlete: ref, current: { target: { value: p.pts - 10 } }, open: { target: { value: p.pts - 10 } }, odds: odds(-600), lastUpdated: '2026-10-25T12:00Z' })
    items.push({ type: { id: '3' }, athlete: ref, current: { target: { value: p.reb - 0.5 } }, open: { target: { value: p.reb - 0.5 } }, odds: odds(-110), lastUpdated: '2026-10-25T12:00Z' })
    items.push({ type: { id: '3' }, athlete: ref, current: { target: { value: p.reb - 0.5 } }, open: { target: { value: p.reb - 0.5 } }, odds: odds(-110), lastUpdated: '2026-10-25T12:00Z' })
  }
  const roster = (tid) => ({ team: { id: tid }, athletes: players.filter((p) => p.team === tid).map((p) => ({ id: p.id, displayName: p.name, shortName: p.name.replace(/^(\w)\w+/, '$1.'), position: { abbreviation: p.pos }, jersey: '1', status: { type: 'active' }, injuries: [] })) })
  const schedule = (tid) => ({ events: [] , team: { id: tid } })
  const f = {
    [`${SITE}/scoreboard`]: S.scoreboard,
    [`${SITE}/scoreboard?dates=${etDay(now, 1)}`]: { events: [] },
    [`${SITE}/summary?event=${ev.id}`]: { header: { id: ev.id, competitions: [{ id: ev.id, date: ev.date, status: ev.status, competitors: ev.competitions[0].competitors }] }, injuries: [] },
    [`${SITE}/teams`]: { sports: [{ leagues: [{ teams: ev.competitions[0].competitors.map((c) => ({ team: c.team })) }] }] },
    [`${SITE}/teams/13/roster`]: roster('13'),
    [`${SITE}/teams/26/roster`]: roster('26'),
    [`${SITE}/teams/13/schedule?season=2027`]: schedule('13'),
    [`${SITE}/teams/26/schedule?season=2027`]: schedule('26'),
    [`${CORE}/events/${ev.id}/competitions/${ev.id}/odds/100/propBets?limit=1000`]: { count: items.length, pageCount: 1, items },
  }
  for (const p of players) {
    f[`${WEB}/athletes/${p.id}/gamelog?season=2027`] = log(p, 2027, 3)
    f[`${WEB}/athletes/${p.id}/gamelog?season=2026`] = log(p, 2026, 40)
  }
  return f
}

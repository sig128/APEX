// Every league on the same engine: ESPN's basketball, hockey and baseball shapes, prices that
// come with the lines, daily slates, and an NBA board end to end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normGamelog, normPropBets, normRoster, normBoxPlayers } from '../src/providers/espn/normalize.js'
import { FAMILIES, sportOf, SPORT_KEYS } from '../src/sports/index.js'
import { MARKETS } from '../src/nfl/markets.js'
import { createEngine, etDay } from '../src/nfl/engine.js'
import { createFixtureTransport, createHttp } from '../src/lib/http.js'
import { createStore } from '../src/lib/store.js'
import { statCorrelation } from '../src/nfl/analytics/sim.js'
import { gameFraction } from '../src/nfl/services/live.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const S = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'nba-sample.json'), 'utf8'))
const { basketball, hockey, baseball, football } = FAMILIES

test('every sport is registered, and market keys never collide', () => {
  assert.deepEqual(SPORT_KEYS.sort(), ['mlb', 'nba', 'ncaab', 'ncaaf', 'nfl', 'nhl', 'wnba'])
  const all = [football, basketball, hockey, baseball].flatMap((f) => Object.keys(f.MARKETS))
  assert.equal(new Set(all).size, all.length, 'one registry for every sport')
  assert.equal(Object.keys(MARKETS).length, all.length)
  assert.equal(sportOf('ncaab').fam, basketball)
  assert.equal(sportOf('ncaaf').fam, football)
})

test('basketball logs: "made-attempted" cells split, preseason skipped', () => {
  const rows = normGamelog(S.gamelog, 2027, basketball)
  assert.equal(rows.length, 2, 'two regular-season games, no preseason')
  const last = rows[rows.length - 1]
  assert.equal(last.eventId, '401909851')
  assert.deepEqual([last.s.min, last.s.pts, last.s.reb, last.s.ast, last.s.tpm, last.s.tpa, last.s.fgm, last.s.fga], [24, 13, 1, 2, 3, 6, 5, 8])
  assert.equal(last.oppAbbr, 'LAC')
  assert.equal(MARKETS.pra.stat(last.s), 16)
  assert.equal(MARKETS.threes.stat(last.s), 3)
})

test('hockey and baseball logs: clock minutes, innings as outs, batters and pitchers kept apart', () => {
  const mk = (x) => ({ names: x.names, seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ type: 'event', events: [{ eventId: '1', stats: x.stats }] }] }], events: { 1: { gameDate: '2026-10-20T23:00:00Z', atVs: 'vs', opponent: { id: '2', abbreviation: 'BOS' }, team: { id: '3' } } } })
  const sk = normGamelog(mk(S.nhlSkaterLog), 2027, hockey)[0].s
  assert.deepEqual([sk.g, sk.a, sk.sog, sk.toi], [1, 0, 1, 20.1])
  const gk = normGamelog(mk(S.nhlGoalieLog), 2027, hockey)[0].s
  assert.deepEqual([gk.gs, gk.sa, gk.sv, gk.ga], [1, 32, 28, 4])
  const bat = normGamelog(mk(S.mlbBatterLog), 2026, baseball)[0].s
  assert.deepEqual([bat.ab, bat.h, bat.d2, bat.hr, bat.rbi, bat.bb, bat.so], [4, 2, 1, 1, 3, 1, 1])
  assert.equal(MARKETS.tb.stat(bat), 2 + 4, 'two hits: a double and a homer')
  assert.equal(MARKETS.hrr.stat(bat), 6)
  const pit = normGamelog(mk(S.mlbPitcherLog), 2026, baseball)[0].s
  assert.deepEqual([pit.outs, pit.ha, pit.er, pit.bba, pit.k], [11, 6, 3, 2, 4], '3.2 innings = 11 outs; hits are hits allowed')
  assert.equal(pit.h, undefined, 'a pitcher never gets batter stats')
})

test('box scores per sport: basketball cells, hockey goalies, baseball pitching', () => {
  const box = (cat, athlete = { id: '9', displayName: 'X' }) => ({ players: [{ team: { id: '1' }, statistics: [{ ...cat, athletes: [{ athlete, stats: cat.stats, starter: true }] }] }] })
  const nba = normBoxPlayers(box(S.nbaBox), basketball)['9'].stats
  assert.deepEqual([nba.min, nba.pts, nba.reb, nba.ast, nba.tpm, nba.fgm], [25, 14, 6, 3, 0, 4])
  const g = normBoxPlayers(box(S.nhlBoxGoalies), hockey)['9'].stats
  assert.deepEqual([g.sv, g.sa, g.toi, g.gs], [28, 32, 60, 1])
  const p = normBoxPlayers(box(S.mlbBoxPitching), baseball)['9'].stats
  assert.deepEqual([p.outs, p.k, p.ha, p.er], [16, 7, 4, 2])
})

test('ESPN lines with prices: over first, then under; milestones are alternate overs', () => {
  const lines = normPropBets({ items: S.propBets }, basketball)
  const pts = lines.find((l) => l.market === 'pts')
  assert.equal(pts.line, 5.5)
  assert.deepEqual(pts.alts, [9.5], 'the 10+ milestone is the 9.5 over')
  assert.deepEqual(pts.prices['5.5'], { over: -128, under: 100 })
  assert.equal(pts.prices['9.5'].over, 260)
  const threes = lines.find((l) => l.market === 'threes')
  assert.deepEqual(threes.prices['1.5'], { over: 140, under: -186 })
  const team = lines.find((l) => l.market === 'teamPts')
  assert.equal(team.teamId, '13')
  assert.equal(team.line, 121.5)
  assert.equal(team.open, 122.5)
  assert.ok(!lines.some((l) => l.market === undefined), 'first basket and the like are skipped')
})

test('rosters: basketball sends one flat list with headshots', () => {
  const r = normRoster(S.roster, '26', 'nba')
  assert.equal(r.length, 2)
  assert.equal(r[0].pos, 'G')
  assert.equal(r[0].injury, 'Out')
  assert.match(r[1].headshot, /headshots\/nba\/players/)
})

test('correlation: a pitcher rides on the opposing lineup, a goalie on the other team shooting', () => {
  const pitcher = { market: 'kP', gameId: 'g', teamId: 'A', oppId: 'B', playerId: 'p', side: 'o' }
  const bat = { market: 'hits', gameId: 'g', teamId: 'B', oppId: 'A', playerId: 'b', side: 'o' }
  assert.ok(statCorrelation(pitcher, bat) < 0, 'his strikeouts and their hits pull against each other')
  const goalie = { market: 'saves', gameId: 'g', teamId: 'A', oppId: 'B', playerId: 'q', side: 'o' }
  const shooter = { market: 'sog', gameId: 'g', teamId: 'B', oppId: 'A', playerId: 's', side: 'o' }
  assert.ok(statCorrelation(goalie, shooter) > 0)
})

test('clocks: basketball quarters, hockey periods, baseball innings', () => {
  assert.equal(gameFraction({ state: 'in', period: 3, clock: '6:00' }, basketball.clockFor('nba')), 0.625)
  assert.equal(gameFraction({ state: 'in', period: 2, clock: '10:00' }, hockey.clockFor()), 0.5)
  assert.ok(Math.abs(gameFraction({ state: 'in', period: 5, short: 'Bot 5th' }, baseball.clockFor()) - 4.5 / 9) < 1e-9)
})

// ---- an NBA day, end to end ------------------------------------------------------------------
const SITE = 'site.api.espn.com/apis/site/v2/sports/basketball/nba'
const WEB = 'site.web.api.espn.com/apis/common/v3/sports/basketball/nba'
const CORE = 'sports.core.api.espn.com/v2/sports/basketball/leagues/nba'
const NOW = Date.parse('2026-10-25T15:00:00Z')

function nbaFixtures() {
  const ev = S.scoreboard.events[0]
  const players = [
    { id: '101', team: '13', name: 'Laker Guard', pos: 'G', pts: 27, reb: 5, ast: 7 },
    { id: '102', team: '13', name: 'Laker Big', pos: 'C', pts: 22, reb: 11, ast: 3 },
    { id: '201', team: '26', name: 'Jazz Wing', pos: 'F', pts: 18, reb: 6, ast: 3 },
    { id: '202', team: '26', name: 'Jazz Guard', pos: 'G', pts: 15, reb: 3, ast: 6 },
  ]
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
    [`${SITE}/scoreboard?dates=${etDay(NOW, 1)}`]: { events: [] },
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

test('an NBA day: daily slate, ESPN prices, the board, a prop, the lock', async () => {
  const transport = createFixtureTransport(nbaFixtures())
  const engine = createEngine({ mode: 'lazy', sport: 'nba', http: createHttp({ transport }), store: createStore({ driver: 'memory' }), now: () => NOW })
  await engine.ensureStarted()
  for (const t of ['summaries', 'schedules', 'rosters', 'lines']) await engine.runTask(t)
  let r
  do r = await engine.logsTask(100)
  while (r.left > 0)
  assert.equal(engine.wh.season, 2027)
  assert.equal(engine.slate(), '2026-10-25', 'daily sports key the slate by date')
  const home = engine.views.home()
  assert.equal(home.sport, 'nba')
  assert.equal(home.calendar, 'day')
  assert.ok(home.tabs.apex.length > 0, 'the board has props')
  assert.ok(home.tabs.threes, 'the sport brings its own tab')

  const board = engine.views.props({ market: 'core' })
  assert.ok(board.rows.length >= 8, `${board.rows.length} rows`)
  assert.ok(board.rows.every((x) => ['pts', 'reb', 'ast', 'threes', 'pra', 'pr', 'pa'].includes(x.market)))
  assert.deepEqual(board.facets.groups.map((g) => g.key), ['G', 'F', 'C'])

  const id = `101.pts.o.23.5`
  const row = engine.views.findProp(id)
  assert.ok(row, 'Laker Guard over 23.5 points')
  assert.equal(row.price.over, -115, 'the price came with the line')
  assert.equal(row.price.under, -105)
  assert.ok(row.implied > 0.5 && row.implied < 0.55, `no-vig ${row.implied}`)
  assert.ok(row.edge != null)
  assert.equal(row.role, 1, '32 minutes a night')
  assert.ok(row.windows.find((w) => w.key === 'L10')?.n === 10)
  const alt = engine.views.findProp('101.pts.o.16.5')
  assert.equal(alt?.posted, 'alt', 'the 17+ milestone is a posted alternate')
  assert.equal(alt.price.over, -600)

  const player = engine.views.player('101')
  assert.deepEqual(player.log.cols, ['min', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'tov'])
  const lock = engine.views.lock()
  assert.ok(['certified', 'price_needed', 'pass'].includes(lock.status))
  assert.equal(lock.week, '2026-10-25')
  assert.ok(lock.funnel.scanned > 0)
  const misses = [...transport.misses].filter((k) => !k.includes('/schedule'))
  assert.deepEqual(misses, [], 'every request had an answer')
})

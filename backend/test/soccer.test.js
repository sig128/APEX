// Soccer: player logs built from match lineups, the standard lines on the board, the clock that
// counts up, the simulator and the builder on soccer props, and picks that need a real price.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../src/nfl/engine.js'
import { createStore } from '../src/lib/store.js'
import { createHttp, createFixtureTransport } from '../src/lib/http.js'
import { summaryPlayers, posGroup, roleOf, MARKETS } from '../src/sports/soccer.js'
import { gameFraction } from '../src/nfl/services/live.js'
import { simulateSlip } from '../src/nfl/analytics/sim.js'
import { buildParlays } from '../src/nfl/analytics/builder.js'
import { SPORTS, sportOf } from '../src/sports/index.js'
import { ODDS_SPORTS } from '../src/providers/oddsapi/props.js'
import { soccerFixtures, NOW, PLAYERS, SITE } from './fixtures/soccer.js'
import { clock } from './support.js'
import { etDay } from '../src/nfl/engine.js'
import { daysIn } from '../src/providers/espn/client.js'

test('five soccer leagues on ESPN, a matchweek slate each', () => {
  for (const k of ['epl', 'laliga', 'seriea', 'bundesliga', 'mls']) {
    assert.equal(SPORTS[k].family, 'soccer')
    assert.equal(SPORTS[k].calendar, 'matchweek')
    assert.equal(sportOf(k).fam.TEAM_LABEL, 'Goals')
    assert.ok(ODDS_SPORTS[k].key.startsWith('soccer_'), 'The Odds API carries them too')
  }
  assert.deepEqual([SPORTS.epl.espn.league, SPORTS.laliga.espn.league, SPORTS.seriea.espn.league, SPORTS.bundesliga.espn.league, SPORTS.mls.espn.league], ['eng.1', 'esp.1', 'ita.1', 'ger.1', 'usa.1'])
})

test('lineups: who played, their numbers, minutes from the substitutions', () => {
  const j = {
    rosters: [
      {
        team: { id: '359' },
        roster: [
          { starter: true, subbedOut: true, athlete: { id: '1', displayName: 'A Striker' }, position: { abbreviation: 'CF' }, stats: [{ name: 'totalShots', value: 4 }, { name: 'shotsOnTarget', value: 2 }, { name: 'totalGoals', value: 1 }, { name: 'goalAssists', value: 0 }] },
          { starter: false, subbedIn: true, athlete: { id: '2', displayName: 'A Sub' }, position: { abbreviation: 'SUB' }, stats: [{ name: 'appearances', value: 1 }, { name: 'totalShots', value: 1 }] },
          { starter: false, subbedIn: false, didNotPlay: true, athlete: { id: '3', displayName: 'Bench Warmer' }, stats: [{ name: 'appearances', value: 0 }] },
          { starter: true, athlete: { id: '4', displayName: 'A Keeper' }, position: { abbreviation: 'G' }, stats: [{ name: 'saves', value: 5 }, { name: 'goalsConceded', value: 1 }] },
        ],
      },
    ],
    keyEvents: [{ type: { type: 'substitution' }, clock: { displayValue: "71'" }, participants: [{ athlete: { id: '2' } }, { athlete: { id: '1' } }] }],
  }
  const p = summaryPlayers(j)
  assert.deepEqual(Object.keys(p).sort(), ['1', '2', '4'], 'the unused sub is left out')
  assert.deepEqual(p['1'].stats, { app: 1, gs: 1, sh: 4, sot: 2, g: 1, a: 0, min: 71 })
  assert.equal(p['2'].stats.min, 19, 'on at 71')
  assert.equal(p['2'].stats.gs, 0)
  assert.equal(p['4'].stats.sv, 5)
  assert.equal(p['4'].stats.min, 90)
  assert.equal(p['1'].teamId, '359')
  assert.deepEqual(['CF', 'LW', 'CD-L', 'RB', 'CM', 'G', 'GK', 'SUB'].map(posGroup), ['F', 'F', 'D', 'D', 'M', 'G', 'G', 'M'])
  assert.equal(roleOf({}, [{ season: 2026, s: { gs: 1 } }, { season: 2026, s: { gs: 1 } }, { season: 2026, s: { gs: 1 } }], 2026), 1)
  assert.equal(roleOf({}, [{ season: 2026, s: { gs: 0 } }, { season: 2026, s: { gs: 0 } }, { season: 2026, s: { gs: 1 } }], 2026), 0.35)
})

test('minutes from each player’s own substitution plays when the key events don’t have them', () => {
  const j = {
    rosters: [
      {
        team: { id: '359' },
        roster: [
          { starter: true, subbedIn: false, subbedOut: true, athlete: { id: '10', displayName: 'Starter Off' }, plays: [{ clock: { displayValue: "76'" }, substitution: true }, { clock: { displayValue: "12'" }, yellowCard: true }], stats: [{ name: 'appearances', value: 1 }] },
          { starter: false, subbedIn: true, subbedOut: false, athlete: { id: '11', displayName: 'On At 76' }, plays: [{ clock: { displayValue: "76'" }, substitution: true }], stats: [{ name: 'appearances', value: 1 }, { name: 'subIns', value: 1 }] },
          { starter: false, subbedIn: true, subbedOut: true, athlete: { id: '12', displayName: 'On And Off' }, plays: [{ clock: { displayValue: "88'" }, substitution: true }, { clock: { displayValue: "46'" }, substitution: true }], stats: [{ name: 'appearances', value: 1 }] },
          { starter: false, subbedIn: false, subbedOut: false, athlete: { id: '13', displayName: 'Unused' }, stats: [{ name: 'appearances', value: 0 }] },
        ],
      },
    ],
  }
  const p = summaryPlayers(j)
  assert.deepEqual(Object.keys(p).sort(), ['10', '11', '12'])
  assert.equal(p['10'].stats.min, 76)
  assert.equal(p['11'].stats.min, 14)
  assert.equal(p['12'].stats.min, 42, 'on at 46, off at 88')
})

test('ESPN’s main host refuses the scoreboard: the web host answers a day at a time, and status says what failed', async () => {
  const range = `${etDay(NOW, -1)}-${etDay(NOW, 7)}`
  const f = soccerFixtures({ now: NOW })
  const key = `${SITE}/scoreboard?dates=${range}&limit=200`
  const sb = f[key]
  delete f[key]
  const web = SITE.replace('site.api.espn.com', 'site.web.api.espn.com')
  for (const d of daysIn(range)) f[`${web}/scoreboard?dates=${d}`] = { ...sb, events: sb.events.filter((e) => etDay(Date.parse(e.date)) === d) }
  assert.equal(daysIn(range).length, 9)
  assert.deepEqual(daysIn('20261231-20270102'), ['20261231', '20270101', '20270102'])
  const engine = createEngine({ mode: 'lazy', http: createHttp({ transport: createFixtureTransport(f), maxPerHost: 16 }), store: createStore({ driver: 'memory' }), sport: 'epl', now: clock(NOW) })
  try {
    await engine.ensureStarted()
    const st = engine.status()
    assert.equal(st.games, 2, 'both matches, from the web host')
    assert.equal(st.season, 2026)
    assert.equal(st.failing, undefined)
  } finally {
    engine.stop()
  }
  // nothing answers: the board stays empty and status names the task and the code
  const dead = createEngine({ mode: 'lazy', http: createHttp({ transport: createFixtureTransport({}), maxPerHost: 16 }), store: createStore({ driver: 'memory' }), sport: 'epl', now: clock(NOW) })
  try {
    await dead.ensureStarted()
    const st = dead.status()
    assert.equal(st.games, 0)
    assert.equal(st.failing.scoreboard.status, 404)
    assert.ok(!JSON.stringify(st.failing).includes('espn'), 'a code, not a URL')
  } finally {
    dead.stop()
  }
})

test('the clock counts up: minutes played out of 90, halftime, stoppage time', () => {
  const c = sportOf('epl').fam.clockFor()
  assert.equal(gameFraction({ state: 'in', period: 2, clock: "67'" }, c), 67 / 90)
  assert.equal(gameFraction({ state: 'in', period: 1, clock: "45'+2'" }, c), 0.5)
  assert.equal(gameFraction({ state: 'in', period: 2, clock: "90'+4'" }, c), 1)
  assert.equal(gameFraction({ state: 'in', period: 1, halftime: true, clock: "45'" }, c), 0.5)
  assert.equal(gameFraction({ state: 'pre' }, c), 0)
})

test('a matchweek: logs from lineups, standard lines on the board, a builder and a simulation on them', async () => {
  const now = clock(NOW)
  const { http } = (() => {
    const transport = createFixtureTransport(soccerFixtures({ now: NOW }))
    return { http: createHttp({ transport, maxPerHost: 16 }) }
  })()
  const engine = createEngine({ mode: 'lazy', http, store: createStore({ driver: 'memory' }), sport: 'epl', now })
  try {
    await engine.ensureStarted()
    for (const t of ['summaries', 'schedules', 'rosters', 'lines']) await engine.runTask(t)
    let r
    do r = await engine.logsTask(500)
    while (r.left > 0)
    // the standard lines need the logs: the next lines run puts them up
    await engine.runTask('lines')
    const st = engine.status()
    assert.equal(st.games, 2)
    assert.equal(st.players, PLAYERS.length)
    assert.ok(st.logs >= PLAYERS.length - 1, `logs for nearly everyone (${st.logs})`)
    const striker = engine.wh.logs.get('9005')
    assert.ok(striker.length >= 16, 'this season and last')
    assert.ok(striker.every((x) => x.teamId === '359' && x.s.app === 1))
    assert.ok(striker.some((x) => x.season === 2025) && striker.some((x) => x.season === 2026))

    const rows = engine.views.allRows().rows
    assert.ok(rows.length > 20, `${rows.length} rows`)
    const markets = new Set(rows.map((x) => x.market))
    for (const m of ['shots', 'sot', 'anyGoalS', 'gkSaves', 'teamPts']) assert.ok(markets.has(m), m)
    // research lines: nobody posted them, so they say so, and they can't go on a record
    assert.ok(rows.every((x) => x.posted === null && x.standard === true))
    assert.ok(rows.every((x) => x.prob > 0 && x.prob < 1))
    // only regular starters get lines; the bench forward doesn't
    assert.ok(!rows.some((x) => PLAYERS.find((p) => p.id === x.playerId)?.lineup === 'SUB'))
    // keepers get saves and nothing else
    assert.ok(rows.filter((x) => x.market === 'gkSaves').every((x) => PLAYERS.find((p) => p.id === x.playerId).pos === 'G'))
    assert.ok(!rows.some((x) => x.market === 'shots' && PLAYERS.find((p) => p.id === x.playerId)?.pos === 'G'))
    // the shots line sits near what he usually does
    const sh = rows.find((x) => x.playerId === '9005' && x.market === 'shots')
    assert.ok(sh && Math.abs(sh.line - sh.avg) <= 1.01, `${sh?.line} vs ${sh?.avg}`)
    const goals = rows.find((x) => x.kind === 'team')
    assert.ok(goals.label.endsWith('Goals') && [0.5, 1.5, 2.5, 3.5].includes(goals.line))
    assert.ok(goals.prob > 0.3 && goals.prob < 0.97, 'a count model for goals, not a bell curve')

    // the home page and cards carry the mark
    const home = engine.views.home()
    const card = home.tabs.apex[0]
    assert.equal(card.standard, true)
    assert.equal(card.sport, 'epl')

    // the simulator plays them out, and the builder builds from them
    const sim = simulateSlip(rows.slice(0, 3), { iterations: 10_000 })
    assert.equal(sim.legs.length, 3)
    for (const l of sim.legs) assert.ok(Math.abs(l.hitRate - l.apex) < 0.04, `${l.label}: ${l.hitRate} vs ${l.apex}`)
    const built = buildParlays(engine.views.builderRows(), { risk: 'longshot', legs: 3, target: 600, now: now(), core: sportOf('epl').fam.CORE })
    assert.ok(['ok', 'off_target'].includes(built.status), built.reason)
    assert.equal(built.builds[0].legs.length, 3)
    assert.ok(built.builds[0].legs.every((l) => MARKETS[l.r.market] || l.r.kind === 'team'))
  } finally {
    engine.stop()
  }
})

test('the Odds API: a soccer assists over/under becomes the anytime assist, Over 0.5 only', async () => {
  const { createOddsApi } = await import('../src/providers/oddsapi/props.js')
  // parse() is internal: go through refresh with a stub http and one game
  const game = { id: 'g1', date: '2026-11-21T15:00:00Z', home: { id: '359', name: 'Arsenal', abbr: 'ARS' }, away: { id: '363', name: 'Chelsea', abbr: 'CHE' }, status: { state: 'pre' } }
  const players = new Map([['9005', { id: '9005', name: 'Arsenal Striker', teamId: '359' }]])
  const event = { id: 'ev1', home_team: 'Arsenal', away_team: 'Chelsea', commence_time: game.date }
  const odds = {
    bookmakers: [
      {
        key: 'fanduel',
        markets: [
          { key: 'player_assists', outcomes: [{ name: 'Over', description: 'Arsenal Striker', point: 0.5, price: 260 }, { name: 'Under', description: 'Arsenal Striker', point: 0.5, price: -380 }, { name: 'Over', description: 'Arsenal Striker', point: 1.5, price: 1400 }] },
          { key: 'player_shots_on_target', outcomes: [{ name: 'Over', description: 'Arsenal Striker', point: 1.5, price: 120 }, { name: 'Under', description: 'Arsenal Striker', point: 1.5, price: -150 }] },
        ],
      },
    ],
  }
  const http = {
    getJson: async (url) => {
      if (/\/events\?/.test(url) || /\/events$/.test(url.split('?')[0])) return [event]
      if (/\/events\/ev1\/odds/.test(url)) return odds
      throw Object.assign(new Error('no'), { status: 404 })
    },
  }
  const api = createOddsApi({ http, store: createStore({ driver: 'memory' }), apiKey: 'k'.repeat(32), sport: 'epl', now: () => Date.parse('2026-11-20T15:00:00Z') })
  const prices = await api.refresh({ games: [game], players, teamAbbr: new Map() })
  assert.ok(prices, 'prices came back')
  const ast = prices.get('9005:anyAst:0.5')
  assert.equal(ast?.yes, 260, 'Over 0.5 assists is the yes price')
  assert.equal(prices.get('9005:anyAst:1.5'), undefined, 'Over 1.5 isn’t an anytime assist')
  const sot = prices.get('9005:sot:1.5')
  assert.deepEqual([sot?.over, sot?.under], [120, -150])
})

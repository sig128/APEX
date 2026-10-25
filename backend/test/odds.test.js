// Sportsbook prices from The Odds API (optional): matching events and players, the headline
// book, the daily credit budget, and what prices do to the APEX read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOddsApi } from '../src/providers/oddsapi/nfl.js'
import { createStore } from '../src/lib/store.js'
import { createEngine } from '../src/nfl/engine.js'
import { fixtures } from './helpers.js'
import { createFixtureTransport, createHttp, fixtureKey } from '../src/lib/http.js'
import { clock, loadAll } from './support.js'

const KEY = 'test-odds-key'
const BASE = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl'

function oddsFixtures({ game, home, away, outcomes }) {
  const ev = { id: 'ev-gbdet', sport_key: 'americanfootball_nfl', commence_time: game.date.replace('Z', ':00Z'), home_team: home, away_team: away }
  return {
    [fixtureKey(`${BASE}/events?apiKey=${KEY}`)]: [ev, { id: 'ev-other', commence_time: '2026-10-25T17:00:00Z', home_team: 'Nowhere FC', away_team: 'Elsewhere' }],
    [fixtureKey(`${BASE}/events/ev-gbdet/odds?apiKey=${KEY}&regions=us&oddsFormat=american&markets=player_pass_yds,player_pass_attempts,player_pass_completions,player_pass_tds,player_pass_interceptions,player_rush_yds,player_rush_attempts,player_receptions,player_reception_yds,player_rush_reception_yds,player_anytime_td&bookmakers=draftkings,fanduel,betmgm,williamhill_us,espnbet`)]: {
      id: 'ev-gbdet',
      bookmakers: [
        { key: 'fanduel', markets: [{ key: 'player_pass_yds', outcomes: outcomes.fanduel }] },
        { key: 'draftkings', markets: [{ key: 'player_pass_yds', outcomes: outcomes.draftkings }, { key: 'player_anytime_td', outcomes: outcomes.td }] },
      ],
    },
  }
}

test('prices: event and player matching, DraftKings as the headline, the budget holds', async () => {
  const now = clock()
  const engine = createEngine({ mode: 'lazy', http: createHttp({ transport: createFixtureTransport(fixtures()) }), store: createStore({ driver: 'memory' }), now })
  await loadAll(engine)
  const g = engine.wh.games.get('401873020')
  const goff = [...engine.wh.players.values()].find((p) => p.name === 'Jared Goff')
  const gibbs = [...engine.wh.players.values()].find((p) => p.name === 'Jahmyr Gibbs')
  const goffLine = (engine.wh.lines.get(g.id).props.find((l) => l.athleteId === goff.id && l.market === 'passYds') || {}).line
  assert.ok(goffLine, 'the board has a Goff passing line')
  const outcomes = {
    draftkings: [
      { name: 'Over', description: 'Jared Goff', price: -125, point: goffLine },
      { name: 'Under', description: 'Jared Goff', price: 105, point: goffLine },
      { name: 'Over', description: 'Somebody Else', price: -110, point: 199.5 },
    ],
    fanduel: [
      { name: 'Over', description: 'Jared Goff', price: -118, point: goffLine },
      { name: 'Under', description: 'Jared Goff', price: -102, point: goffLine },
    ],
    td: [{ name: 'Yes', description: 'Jahmyr Gibbs', price: -190 }],
  }
  const http = createHttp({ transport: createFixtureTransport({ ...fixtures(), ...oddsFixtures({ game: g, home: g.home.name, away: g.away.name, outcomes }) }) })
  const store = createStore({ driver: 'memory' })
  const odds = createOddsApi({ http, store, apiKey: KEY, now, dailyCredits: 30 })
  const prices = await odds.refresh({ games: [g], players: engine.wh.players })
  const p = prices.get(`${goff.id}:passYds:${goffLine}`)
  assert.equal(p.book, 'draftkings', 'DraftKings leads when it has both sides')
  assert.equal(p.over, -125)
  assert.equal(p.under, 105)
  assert.equal(p.books.fanduel.over, -118, 'other books ride along')
  assert.equal(prices.get(`${gibbs.id}:anyTd:0.5`).yes, -190)
  assert.equal(odds.status().spentToday, 11)

  // into the analytics: implied probability, edge, and a calibrated read
  engine.wh.prices = prices
  engine.wh.bump('core')
  const row = engine.views.findProp(`${goff.id}.passYds.o.${goffLine}`)
  assert.equal(row.price.over, -125)
  assert.ok(row.implied > 0.5 && row.implied < 0.6, `no-vig implied ${row.implied}`)
  assert.ok(Math.abs(row.edge - (row.prob - row.implied)) < 1e-3)
  const under = engine.views.findProp(`${goff.id}.passYds.u.${goffLine}`)
  assert.ok(Math.abs(under.implied + row.implied - 1) < 1e-3, 'the two sides share the no-vig split')

  // a second refresh within 3 hours spends nothing; a new day with the budget gone spends nothing
  await odds.refresh({ games: [g], players: engine.wh.players })
  assert.equal(odds.status().spentToday, 11)
  now.add(4 * 3600_000)
  await odds.refresh({ games: [g], players: engine.wh.players })
  assert.equal(odds.status().spentToday, 22)
  now.add(4 * 3600_000)
  await odds.refresh({ games: [g], players: engine.wh.players })
  assert.ok(odds.status().spentToday <= 30, 'never past the daily budget')
  engine.stop()
})

test('prices survive a cold start through the store', async () => {
  const store = createStore({ driver: 'memory' })
  await store.set('oddsprops', 'all', [['401873020', { at: Date.now(), rows: [{ pid: '1', market: 'rec', line: 4.5, side: 'over', price: -130, book: 'draftkings' }, { pid: '1', market: 'rec', line: 4.5, side: 'under', price: 110, book: 'draftkings' }] }]])
  const http = createHttp({ transport: async () => ({ ok: false, status: 503, headers: new Headers(), text: async () => '' }) })
  const odds = createOddsApi({ http, store, apiKey: KEY })
  const prices = await odds.refresh({ games: [], players: new Map() })
  assert.equal(prices.get('1:rec:4.5').over, -130, 'the saved snapshot serves while the API is down')
  assert.match(odds.status().lastError, /HTTP 503|cooling/)
})

// Sportsbook prices from The Odds API (optional): matching events and players, the headline
// book, the daily credit budget, and what prices do to the APEX read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOddsApi } from '../src/providers/oddsapi/props.js'
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
    [fixtureKey(`${BASE}/events/ev-gbdet/odds?apiKey=${KEY}&oddsFormat=american&markets=player_pass_yds,player_pass_attempts,player_pass_completions,player_pass_tds,player_pass_interceptions,player_rush_yds,player_rush_attempts,player_receptions,player_reception_yds,player_rush_reception_yds,player_anytime_td&bookmakers=draftkings,fanduel,betmgm,williamhill_us,fanatics,betrivers,espnbet&includeLinks=true`)]: {
      id: 'ev-gbdet',
      bookmakers: [
        { key: 'fanduel', link: 'https://sportsbook.fanduel.com/', markets: [{ key: 'player_pass_yds', outcomes: outcomes.fanduel }] },
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
      { name: 'Over', description: 'Jared Goff', price: -118, point: goffLine, link: 'https://sportsbook.fanduel.com/addToBetslip?marketId=42.448600011&selectionId=29165' },
      { name: 'Under', description: 'Jared Goff', price: -102, point: goffLine, link: 'javascript:alert(1)' },
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
  // line shopping: the best price on each side, across books
  assert.deepEqual(p.best.over, { price: -118, book: 'fanduel' })
  assert.deepEqual(p.best.under, { price: 105, book: 'draftkings' })
  assert.equal(p.books.fanduel.links.over, 'https://sportsbook.fanduel.com/addToBetslip?marketId=42.448600011&selectionId=29165', 'the bet slip link')
  assert.equal(p.books.fanduel.deep.over, true)
  assert.equal(p.books.fanduel.links.under, 'https://sportsbook.fanduel.com/', 'a bad link falls back to the book')
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

test('every league: NBA and NHL props map to APEX markets, each league spends its own budget', async () => {
  const NBA = 'https://api.the-odds-api.com/v4/sports/basketball_nba'
  const NHL = 'https://api.the-odds-api.com/v4/sports/icehockey_nhl'
  const g = { id: 'g1', date: '2026-10-26T00:00Z', home: { id: '26', name: 'Utah Jazz' }, away: { id: '13', name: 'Los Angeles Lakers' } }
  const h = { id: 'h1', date: '2026-10-26T00:00Z', home: { id: '5', name: 'Boston Bruins' }, away: { id: '6', name: 'Buffalo Sabres' } }
  const players = new Map([
    ['101', { id: '101', name: 'Luka Dončić', teamId: '13' }],
    ['501', { id: '501', name: 'David Pastrňák', teamId: '5' }],
  ])
  const nbaMarkets = 'player_points,player_rebounds,player_assists,player_threes,player_blocks,player_steals,player_blocks_steals,player_points_rebounds_assists,player_points_rebounds,player_points_assists,player_rebounds_assists'
  const nhlMarkets = 'player_points,player_assists,player_goals,player_shots_on_goal,player_total_saves,player_goal_scorer_anytime'
  const books = 'draftkings,fanduel,betmgm,williamhill_us,fanatics,betrivers,espnbet'
  const f = {
    [fixtureKey(`${NBA}/events?apiKey=${KEY}`)]: [{ id: 'e1', commence_time: '2026-10-26T00:00:00Z', home_team: 'Utah Jazz', away_team: 'Los Angeles Lakers' }],
    [fixtureKey(`${NBA}/events/e1/odds?apiKey=${KEY}&oddsFormat=american&markets=${nbaMarkets}&bookmakers=${books}&includeLinks=true`)]: {
      bookmakers: [
        { key: 'fanduel', markets: [{ key: 'player_points', outcomes: [{ name: 'Over', description: 'Luka Doncic', price: -105, point: 31.5 }, { name: 'Under', description: 'Luka Doncic', price: -125, point: 31.5 }] }] },
        { key: 'draftkings', markets: [{ key: 'player_points_rebounds_assists', outcomes: [{ name: 'Over', description: 'Luka Doncic', price: -115, point: 48.5 }, { name: 'Under', description: 'Luka Doncic', price: -105, point: 48.5 }] }] },
      ],
    },
    [fixtureKey(`${NHL}/events?apiKey=${KEY}`)]: [{ id: 'e2', commence_time: '2026-10-26T00:00:00Z', home_team: 'Boston Bruins', away_team: 'Buffalo Sabres' }],
    [fixtureKey(`${NHL}/events/e2/odds?apiKey=${KEY}&oddsFormat=american&markets=${nhlMarkets}&bookmakers=${books}&includeLinks=true`)]: {
      bookmakers: [{ key: 'betmgm', markets: [{ key: 'player_goal_scorer_anytime', outcomes: [{ name: 'Yes', description: 'David Pastrnak', price: 120 }, { name: 'No', description: 'David Pastrnak', price: -160 }] }, { key: 'player_shots_on_goal', outcomes: [{ name: 'Over', description: 'David Pastrnak', price: -140, point: 3.5 }] }] }],
    },
  }
  const http = createHttp({ transport: createFixtureTransport(f) })
  const store = createStore({ driver: 'memory' })
  const nba = createOddsApi({ http, store, apiKey: KEY, sport: 'nba', dailyCredits: 11 })
  const pn = await nba.refresh({ games: [g], players })
  assert.equal(pn.get('101:pts:31.5').books.fanduel.over, -105, 'accents and all, the name matches')
  assert.equal(pn.get('101:pra:48.5').over, -115)
  assert.equal(nba.status().spentToday, 11)
  const nhl = createOddsApi({ http, store, apiKey: KEY, sport: 'nhl', dailyCredits: 6 })
  const ph = await nhl.refresh({ games: [h], players })
  assert.deepEqual(ph.get('501:anyGoal:0.5').books.betmgm, { yes: 120 }, 'anytime goal: the yes side at its fixed line')
  assert.equal(ph.get('501:sog:3.5').best.over.price, -140)
  assert.equal(nhl.status().spentToday, 6, 'the NHL budget is its own')
  assert.equal(nba.status().spentToday, 11)
})

// The analyzer's odds routes: one paid upstream call per event however callers vary the query,
// a daily credit budget of their own, ids checked before anything is spent, and a rate limit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createStore } from '../src/lib/store.js'
import { _resetOddsCaches } from '../oddsEvents.js'
import { oddsCreditsUsed } from '../src/lib/oddsBudget.js'
import { fixtureHttp } from './helpers.js'
import { clock, testAuth, USERS, withEnv, serve } from './support.js'

const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: null, APEX_PAYWALL: 'off', K_SERVICE: null, APEX_LOG_LEVEL: 'error', APEX_ODDS_ANALYZER_DAILY_CREDITS: '80', APEX_ODDS_NEW_GAMES_PER_IP: '10' })
const EV1 = 'a'.repeat(32)
const EV2 = 'b'.repeat(32)
const EV3 = 'c'.repeat(32) // on the schedule, but the odds call fails upstream
const EV4 = 'd'.repeat(32)
const EV5 = 'e'.repeat(32) // next week
const EV6 = 'f'.repeat(32)
let store
const realFetch = globalThis.fetch
const upstream = []
let api
let engine

before(async () => {
  _resetOddsCaches()
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (!url.startsWith('https://api.the-odds-api.com/') && !url.includes('statsapi.mlb.com')) return realFetch(input, init)
    upstream.push(url)
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '36' } })
    if (url.includes('statsapi.mlb.com')) return json({ people: [] })
    if (url.includes(`/events/${EV3}/odds`)) return new Response('{"message":"Event not found"}', { status: 404 })
    if (/\/events\/[a-f0-9]{32}\/odds/.test(url)) {
      return json({ id: url.match(/events\/([a-f0-9]{32})/)[1], home_team: 'Home', away_team: 'Away', bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'batter_hits', outcomes: [{ name: 'Over', description: 'Shohei Ohtani', price: -150, point: 0.5 }, { name: 'Under', description: 'Shohei Ohtani', price: 120, point: 0.5 }] }] }] })
    }
    if (/\/sports\/[a-z_]+\/events\?/.test(url)) return json([EV1, EV2, EV3, EV4, EV5, EV6].map((id) => ({ id, sport_key: 'baseball_mlb', commence_time: new Date(Date.now() + (id === EV5 ? 5 * 86400e3 : 3600e3)).toISOString(), home_team: 'Home', away_team: 'Away' })))
    return new Response('not found', { status: 404 })
  }
  const { http } = fixtureHttp()
  store = createStore({ driver: 'memory' })
  const made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), anthropicKey: () => null, oddsKey: () => 'odds-test-key', now: clock() })
  engine = made.engine
  api = await serve(made.app)
})
after(async () => {
  globalThis.fetch = realFetch
  await api?.close()
  engine?.stop()
  restoreEnv()
})

const paidCalls = () => upstream.filter((u) => /\/events\/[a-f0-9]{32}\/odds/.test(u)).length

test('one paid call per event, whatever players or books are asked about', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await api.get(`/api/odds/mlb-player-props-board?eventId=${EV1}&players=${encodeURIComponent(`Player Number ${i}`)}&book=${i % 2 ? 'fanduel' : 'draftkings'}`)
    assert.ok([200].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`)
  }
  const ladder = await api.get(`/api/odds/mlb-prop-ladder?eventId=${EV1}&player=${encodeURIComponent('Shohei Ohtani')}&market=batter_hits&book=draftkings`)
  assert.equal(ladder.status, 200)
  assert.equal(paidCalls(), 1)
})

test('only scheduled games cost credits, failed calls give them back, the pool runs out cleanly', async () => {
  const used = () => oddsCreditsUsed(store, { pool: 'analyzer' })
  assert.equal(await used(), 36)
  const bad = await api.get(`/api/odds/mlb-player-props-board?eventId=${encodeURIComponent('../../sports')}&players=X`)
  assert.equal(bad.status, 400)
  for (let i = 0; i < 5; i++) {
    const made = await api.get(`/api/odds/mlb-player-props-board?eventId=${i.toString(16).repeat(32)}&players=X`)
    assert.equal(made.status, 404, 'made-up ids are not on the schedule')
  }
  assert.equal(await used(), 36, 'and cost nothing')
  const upstream404 = await api.get(`/api/odds/mlb-player-props-board?eventId=${EV3}&players=X`)
  assert.ok(upstream404.status >= 400, JSON.stringify(upstream404.body))
  assert.equal(await used(), 36, 'a call that returned nothing is refunded')
  assert.equal((await api.get(`/api/odds/mlb-player-props-board?eventId=${EV2}&players=Someone`)).status, 200)
  assert.equal(await used(), 72)
  // 72 of 80 spent: the next game can't be bought today
  const over = await api.get(`/api/odds/mlb-player-props-board?eventId=${EV4}&players=Someone`)
  assert.equal(over.status, 503)
  assert.equal(over.body.code, 'odds_budget')
  assert.equal(paidCalls(), 3, 'EV1, EV3 (refunded) and EV2; nothing for made-up ids or past the budget')
})

test('games days away cost nothing; each caller gets a share of new games', async () => {
  const far = await api.get(`/api/odds/mlb-player-props-board?eventId=${EV5}&players=X`)
  assert.equal(far.status, 404)
  assert.equal(far.body.code, 'not_soon')
  const restore = withEnv({ APEX_ODDS_NEW_GAMES_PER_IP: '2', APEX_ODDS_ANALYZER_DAILY_CREDITS: '10000' })
  try {
    // this address already opened EV1 and EV2 today (EV3's failed call was given back)
    const mine = await api.get(`/api/odds/mlb-player-props-board?eventId=${EV6}&players=X`)
    assert.equal(mine.status, 429)
    assert.equal(mine.body.code, 'odds_caller')
    const open = await api.get(`/api/odds/mlb-player-props-board?eventId=${EV1}&players=${encodeURIComponent('Someone Else')}`)
    assert.equal(open.status, 200, 'games already open still load')
  } finally {
    restore()
  }
})

test('schedules are cached for a minute (free upstream, still not hammered)', async () => {
  _resetOddsCaches()
  const before = upstream.filter((u) => u.includes('/events?')).length
  await api.get('/api/odds/events?sport=mlb&q=home')
  await api.get('/api/odds/events?sport=mlb&q=home')
  await api.get('/api/odds/events?sport=mlb&q=home')
  assert.equal(upstream.filter((u) => u.includes('/events?')).length - before, 1)
})

test('one address gets a modest rate', async () => {
  let limited = 0
  for (let i = 0; i < 45; i++) if ((await api.get('/api/odds/events?sport=mlb&q=home')).status === 429) limited++
  assert.ok(limited > 0, 'a burst gets throttled')
})

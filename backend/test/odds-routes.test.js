// The analyzer's odds routes: one paid upstream call per event however callers vary the query,
// a daily credit budget of their own, ids checked before anything is spent, and a rate limit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createStore } from '../src/lib/store.js'
import { _resetOddsCaches } from '../oddsEvents.js'
import { fixtureHttp } from './helpers.js'
import { clock, testAuth, USERS, withEnv, serve } from './support.js'

const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: null, APEX_PAYWALL: 'off', K_SERVICE: null, APEX_LOG_LEVEL: 'error', APEX_ODDS_ANALYZER_DAILY_CREDITS: '40' })
const EV1 = 'a'.repeat(32)
const EV2 = 'b'.repeat(32)
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
    if (/\/events\/[a-f0-9]{32}\/odds/.test(url)) {
      return json({ id: url.match(/events\/([a-f0-9]{32})/)[1], home_team: 'Home', away_team: 'Away', bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'batter_hits', outcomes: [{ name: 'Over', description: 'Shohei Ohtani', price: -150, point: 0.5 }, { name: 'Under', description: 'Shohei Ohtani', price: 120, point: 0.5 }] }] }] })
    }
    if (/\/sports\/[a-z_]+\/events\?/.test(url)) return json([{ id: EV1, sport_key: 'baseball_mlb', commence_time: new Date(Date.now() + 3600e3).toISOString(), home_team: 'Home', away_team: 'Away' }])
    return new Response('not found', { status: 404 })
  }
  const { http } = fixtureHttp()
  const made = createApexApp({ engineMode: 'lazy', http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS), anthropicKey: () => null, oddsKey: () => 'odds-test-key', now: clock() })
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

test('bad event ids cost nothing; the daily pool runs out cleanly', async () => {
  const bad = await api.get(`/api/odds/mlb-player-props-board?eventId=${encodeURIComponent('../../sports')}&players=X`)
  assert.equal(bad.status, 400)
  assert.equal(paidCalls(), 1)
  // 36 credits spent of 40: the next event can't be bought today
  const second = await api.get(`/api/odds/mlb-player-props-board?eventId=${EV2}&players=Someone`)
  assert.equal(second.status, 503)
  assert.equal(second.body.code, 'odds_budget')
  assert.equal(paidCalls(), 1)
})

test('schedules are cached for a minute (free upstream, still not hammered)', async () => {
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

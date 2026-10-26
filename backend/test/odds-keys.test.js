// The Odds API keys: the paid key first, the backup when the API turns the paid one down (bad
// or cancelled key, or its credits are used up), on the props board and the older odds routes
// alike. Keys only ever show up as a count.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createKeyRing, keyRefused, oddsKeys, splitKeys, _resetKeyRings } from '../src/providers/oddsapi/keys.js'
import { createOddsApi } from '../src/providers/oddsapi/props.js'
import { createFixtureTransport, createHttp, fixtureKey } from '../src/lib/http.js'
import { createStore } from '../src/lib/store.js'
import { createApexApp } from '../app.js'
import { fetchOddsEventsSafe, _resetOddsCaches } from '../oddsEvents.js'
import { fixtureHttp } from './helpers.js'
import { clock, testAuth, USERS, withEnv, serve } from './support.js'

const restoreEnv = withEnv({ APEX_LOG_LEVEL: 'silent', APEX_ODDS_SPORTS: null, OPENAI_API_KEY: null })
after(() => restoreEnv())

const refused = (code, status = 401) => Object.assign(new Error(`HTTP ${status}`), { upstreamStatus: status, upstreamCode: code })

test('keys: the paid key, then the backup; commas allowed, no repeats', () => {
  assert.deepEqual(oddsKeys({ THE_ODDS_API_KEY: 'paid', THE_ODDS_API_KEY_BACKUP: 'free' }), ['paid', 'free'])
  assert.deepEqual(oddsKeys({ THE_ODDS_API_KEY: ' paid , other ', THE_ODDS_API_KEY_BACKUP: 'paid' }), ['paid', 'other'])
  assert.deepEqual(oddsKeys({ THE_ODDS_API_KEY_BACKUP: 'free' }), ['free'], 'a backup on its own still works')
  assert.deepEqual(oddsKeys({}), [])
  assert.deepEqual(splitKeys(['a,b', null, undefined, 'b c']), ['a', 'b', 'c'])
})

test('keys: what counts as the key being turned down', () => {
  assert.equal(keyRefused(refused('OUT_OF_USAGE_CREDITS', 429)), true, 'out of credits, whatever the status')
  assert.equal(keyRefused(refused('INVALID_KEY')), true)
  assert.equal(keyRefused(refused('DEACTIVATED_KEY')), true)
  assert.equal(keyRefused(refused('EXCEEDED_FREQ_LIMIT', 429)), false, 'too fast is not a bad key')
  assert.equal(keyRefused(refused('EVENT_NOT_FOUND', 404)), false)
  assert.equal(keyRefused({ status: 401 }), true, 'a bare 401 from the http client')
  assert.equal(keyRefused({ status: 503 }), false)
  assert.equal(keyRefused({ status: 0, code: 'network' }), false)
  assert.equal(keyRefused(null), false)
})

test('ring: a refused key is set aside, the next answers the same call, and the first comes back later', async () => {
  let t = 1_000_000
  const ring = createKeyRing('paid,free', { now: () => t, benchMs: 60_000 })
  const calls = []
  const fn = async (k) => {
    calls.push(k)
    if (k === 'paid') throw refused('OUT_OF_USAGE_CREDITS')
    return `ok:${k}`
  }
  assert.equal(await ring.run(fn), 'ok:free')
  assert.deepEqual(calls, ['paid', 'free'])
  assert.deepEqual(ring.status(), { keys: 2, using: 2, setAside: 1 })
  assert.equal(await ring.run(fn), 'ok:free')
  assert.deepEqual(calls, ['paid', 'free', 'free'], 'the set-aside key is skipped')
  t += 61_000
  assert.equal(ring.current(), 'paid', 'after a while the paid key gets another go')
  await ring.run(fn)
  assert.deepEqual(calls.slice(3), ['paid', 'free'])
})

test('ring: other failures are the caller’s, and with every key refused it still asks', async () => {
  const ring = createKeyRing(['one', 'two'], { now: () => 5, benchMs: 1000 })
  const calls = []
  await assert.rejects(
    ring.run(async (k) => {
      calls.push(k)
      throw Object.assign(new Error('HTTP 503'), { status: 503 })
    }),
    /503/,
  )
  assert.deepEqual(calls, ['one'], 'a server error is not a reason to burn the backup')
  const all = []
  await assert.rejects(
    ring.run(async (k) => {
      all.push(k)
      throw refused('INVALID_KEY')
    }),
    /HTTP 401/,
  )
  assert.deepEqual(all, ['one', 'two'])
  const again = []
  await assert.rejects(ring.run(async (k) => (again.push(k), Promise.reject(refused('INVALID_KEY')))))
  assert.deepEqual(again, ['one'], 'every key set aside: the first is asked again, once')
  await assert.rejects(createKeyRing('').run(async () => 'never'), /No Odds API key/)
})

test('board prices: the paid key is out of credits, the backup fills the board', async () => {
  _resetKeyRings()
  const PAID = 'paid-board-key'
  const FREE = 'free-board-key'
  const NBA = 'https://api.the-odds-api.com/v4/sports/basketball_nba'
  const markets = 'player_points,player_rebounds,player_assists,player_threes,player_blocks,player_steals,player_blocks_steals,player_points_rebounds_assists,player_points_rebounds,player_points_assists,player_rebounds_assists'
  const books = 'draftkings,fanduel,betmgm,williamhill_us,fanatics,betrivers,espnbet'
  const fixtures = createFixtureTransport({
    [fixtureKey(`${NBA}/events?apiKey=${FREE}`)]: [{ id: 'e1', commence_time: '2026-10-26T00:00:00Z', home_team: 'Utah Jazz', away_team: 'Los Angeles Lakers' }],
    [fixtureKey(`${NBA}/events/e1/odds?apiKey=${FREE}&oddsFormat=american&markets=${markets}&bookmakers=${books}&includeLinks=true`)]: {
      bookmakers: [{ key: 'fanduel', markets: [{ key: 'player_points', outcomes: [{ name: 'Over', description: 'Luka Doncic', price: -105, point: 31.5 }, { name: 'Under', description: 'Luka Doncic', price: -125, point: 31.5 }] }] }],
    },
  })
  const seen = []
  const transport = async (url, init) => {
    seen.push(url.includes(PAID) ? 'paid' : url.includes(FREE) ? 'free' : 'other')
    if (url.includes(PAID)) return { ok: false, status: 401, headers: { get: () => null }, text: async () => '{"message":"Usage quota has been reached.","error_code":"OUT_OF_USAGE_CREDITS"}' }
    return fixtures(url, init)
  }
  const odds = createOddsApi({ http: createHttp({ transport }), store: createStore({ driver: 'memory' }), apiKey: `${PAID},${FREE}`, sport: 'nba', dailyCredits: 50 })
  const g = { id: 'g1', date: '2026-10-26T00:00Z', home: { id: '26', name: 'Utah Jazz' }, away: { id: '13', name: 'Los Angeles Lakers' } }
  const prices = await odds.refresh({ games: [g], players: new Map([['101', { id: '101', name: 'Luka Dončić', teamId: '13' }]]) })
  assert.equal(prices.get('101:pts:31.5').books.fanduel.over, -105, 'prices from the backup key')
  assert.deepEqual(seen, ['paid', 'free', 'free'], 'one refused call, then the backup for the rest')
  assert.deepEqual(odds.status().keys, { keys: 2, using: 2, setAside: 1 })
  assert.equal(odds.status().lastError, null)
  assert.ok(!JSON.stringify(odds.status()).includes(PAID), 'status never shows a key')
})

test('older odds routes: a bad paid key falls through to the backup, and stays skipped', async () => {
  _resetKeyRings()
  _resetOddsCaches()
  const realFetch = globalThis.fetch
  const used = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const key = url.searchParams.get('apiKey')
    used.push(key)
    if (key === 'legacy-paid') return new Response('{"message":"API key is not valid","error_code":"INVALID_KEY"}', { status: 401 })
    return new Response(JSON.stringify([{ id: 'x'.repeat(32), commence_time: '2026-10-26T00:00:00Z', home_team: 'Home', away_team: 'Away' }]), { status: 200 })
  }
  try {
    const first = await fetchOddsEventsSafe('legacy-paid,legacy-free', ['baseball_mlb'])
    assert.equal(first.events.length, 1)
    assert.deepEqual(first.errors, [])
    _resetOddsCaches()
    await fetchOddsEventsSafe('legacy-paid,legacy-free', ['basketball_nba'])
    assert.deepEqual(used, ['legacy-paid', 'legacy-free', 'legacy-free'])
  } finally {
    globalThis.fetch = realFetch
    _resetOddsCaches()
  }
})

test('health says whether the AI and the odds are on, never the keys', async () => {
  const made = createApexApp({ engineMode: 'lazy', http: fixtureHttp().http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS), anthropicKey: () => 'sk-ant-health-test', oddsKey: () => 'health-paid-key,health-free-key', now: clock() })
  const api = await serve(made.app)
  try {
    const r = await api.get('/api/health')
    assert.equal(r.status, 200)
    assert.equal(r.body.ai, true)
    assert.deepEqual(r.body.odds, { keys: 2, leagues: ['nfl'] })
    const text = JSON.stringify(r.body)
    for (const secret of ['sk-ant-health-test', 'health-paid-key', 'health-free-key']) assert.ok(!text.includes(secret), `${secret} stays private`)
  } finally {
    await api.close()
    made.engine.stop()
  }
  const off = createApexApp({ engineMode: 'lazy', http: fixtureHttp().http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS), anthropicKey: () => null, oddsKey: () => { throw new Error('secret not mounted') }, now: clock() })
  const api2 = await serve(off.app)
  try {
    const r = await api2.get('/api/health')
    assert.equal(r.body.ai, false)
    assert.equal(r.body.odds.keys, 0)
  } finally {
    await api2.close()
    off.engine.stop()
  }
})

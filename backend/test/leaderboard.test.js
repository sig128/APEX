// The paid leaderboard: windows, league and leg-count filters, tiers, sorts, and the paywall.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { applyGraded, recordFor, tierOf, cutOf, TIERS } from '../src/picks/service.js'
import { fixtureHttp } from './helpers.js'
import { clock, testAuth, USERS, bearer, withEnv, serve } from './support.js'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-20T20:00:00Z')
const day = (t) => new Date(t).toISOString().slice(0, 10)
const pick = (i, { result = 'win', price = -110, legs = 1, sport = 'nfl', clv = 0.02 } = {}) => ({
  id: `p${i}`,
  result,
  price,
  units: 1,
  profit: result === 'win' ? (price > 0 ? price / 100 : 100 / -price) : result === 'loss' ? -1 : 0,
  clv,
  legs: Array.from({ length: legs }, () => ({ sport })),
})
/** A record of n picks, one a day going back from today, with the win rate and shape given. */
function statsOf(n, { winEvery = 2, price = -110, legs = 1, sport = 'nfl', startDaysAgo = 0 } = {}) {
  let st = null
  for (let i = n - 1; i >= 0; i--) st = applyGraded(st, pick(i, { result: i % winEvery === 0 ? 'win' : 'loss', price, legs, sport }), day(T0 - (i + startDaysAgo) * DAY))
  return st
}

test('records by window, league and leg count; tiers need volume and results', () => {
  assert.equal(cutOf({ legs: [{ sport: 'nba' }, { sport: 'nba' }, { sport: 'nba' }] }), 'nba|3')
  assert.equal(cutOf({ legs: [{ sport: 'nba' }, { sport: 'nhl' }] }), 'mixed|2')
  assert.equal(cutOf({ legs: [{}, {}, {}, {}, {}] }), 'nfl|4+')
  // 60 NHL two-leg parlays at +260, winning 1 in 2: well up
  const st = statsOf(60, { winEvery: 2, price: 260, legs: 2, sport: 'nhl' })
  assert.equal(st.v, 2)
  const all = recordFor(st, T0, 'UTC', { range: 'all' })
  assert.equal(all.graded, 60)
  assert.equal(all.avgOdds, 260)
  assert.equal(recordFor(st, T0, 'UTC', { range: '30d' }).graded, 30, 'one a day: 30 in 30 days')
  assert.equal(recordFor(st, T0, 'UTC', { range: '90d' }).graded, 60)
  assert.equal(recordFor(st, T0, 'UTC', { range: '30d', sport: 'nhl', legs: '2' }).graded, 30)
  assert.equal(recordFor(st, T0, 'UTC', { range: 'all', sport: 'nba' }).graded, 0, 'no NBA picks')
  assert.equal(recordFor(st, T0, 'UTC', { range: 'all', legs: '1' }).graded, 0, 'no singles')
  const r90 = recordFor(st, T0, 'UTC', { range: '90d' })
  assert.ok(r90.roi > 0.7)
  assert.equal(tierOf(r90), 'platinum', '60 graded and well up: Platinum (Diamond needs 75)')
  assert.equal(tierOf({ graded: 9, roi: 2 }), null, 'under 10: no tier')
  assert.equal(tierOf({ graded: 12, roi: -0.3 }), 'bronze')
  assert.equal(tierOf({ graded: 120, roi: 0.2, clv: 0.01, clvN: 80 }), 'legend')
  assert.equal(tierOf({ graded: 120, roi: 0.2, clv: -0.01, clvN: 80 }), 'diamond', 'a Legend beats the closing line too')
  assert.deepEqual(TIERS.map((t) => t.key), ['legend', 'diamond', 'platinum', 'gold', 'silver', 'bronze'])
})

let api
let made
let restoreEnv
before(async () => {
  restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error', APEX_PAYWALL: 'auto', APEX_TREASURY_ADDRESS: '0x1111111111111111111111111111111111111111', APEX_EPHEMERAL: null, APEX_BOARD_MIN: '20' })
  const now = clock(T0)
  const store = createStore({ driver: 'memory' })
  const docs = createStoreDocs(store)
  const billing = createBilling({ docs, now })
  // five paid members, one free person with a better record (not on a members' board)
  const people = [
    ['u_a', 'alpha', { winEvery: 2, price: 150 }],
    ['u_b', 'bravo', { winEvery: 2, price: 120 }],
    ['u_c', 'charlie', { winEvery: 3, price: 200, legs: 3, sport: 'nba' }],
    ['u_d', 'delta', { winEvery: 2, price: -110 }],
    ['u_e', 'echo', { winEvery: 4, price: 100 }],
    ['u_free', 'freebie', { winEvery: 1, price: 300 }],
  ]
  for (const [uid, handle, shape] of people) {
    await docs.set('profiles', uid, { uid, handle, name: handle.toUpperCase(), avatar: null, ig: 'insta_' + handle, x: 'x_' + handle, createdAt: T0 - 60 * DAY, recordAt: T0 - DAY, stats: statsOf(40, shape), ...(uid === 'u_free' ? {} : { paidUntil: T0 + 10 * DAY, eliteUntil: uid === 'u_a' ? T0 + 10 * DAY : 0 }) })
  }
  // a member who's watching (not posting)
  await docs.set('subscriptions', 'u_pro', { plan: 'pro', paidUntil: T0 + 20 * DAY, source: 'usdc', email: 'pro@example.com', updatedAt: T0 - DAY })
  const { http } = fixtureHttp()
  made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, oddsKey: () => null, now })
  api = await serve(made.app)
})
after(async () => {
  await api?.close()
  for (const e of Object.values(made?.engines || {})) e.stop()
  restoreEnv?.()
})

test('the board: members only, the full list for members, the podium for everyone else', async () => {
  const anon = await api.get('/api/picks/leaderboard?range=30d')
  assert.equal(anon.status, 200)
  assert.equal(anon.body.locked, true)
  assert.equal(anon.body.rows.length, 3, 'a free visitor sees the top three')
  assert.equal(anon.body.total, 5, 'and how many are behind them')
  assert.ok(!anon.body.rows.some((r) => r.profile.handle === 'freebie'), 'free accounts are not on it')
  assert.match(anon.headers.get('cache-control'), /public/)
  // a paid member sees everyone, privately cached
  const mine = await api.get('/api/picks/leaderboard?range=30d', { headers: bearer('u_pro') })
  assert.equal(mine.body.locked, false)
  assert.equal(mine.body.rows.length, 5, 'a member sees the whole board')
  assert.match(mine.headers.get('cache-control'), /private/)
  const freeViewer = await api.get('/api/picks/leaderboard?range=30d', { headers: bearer('u_free') })
  assert.equal(freeViewer.body.rows.length, 3, 'signed in on the free plan: still the podium only')
  // filters and sorts
  const nba = await api.get('/api/picks/leaderboard?range=all&sport=nba&legs=3')
  assert.deepEqual(nba.body.rows.map((r) => r.profile.handle), ['charlie'])
  const byUnits = await api.get('/api/picks/leaderboard?range=all&sort=units')
  const u = byUnits.body.rows.map((r) => r.record.units)
  assert.deepEqual(u, [...u].sort((a, b) => b - a))
  const top = byUnits.body.rows[0]
  assert.ok(top.tier, 'each row has its tier')
  assert.equal(top.record.avgOdds != null, true)
  // Instagram and X show for Elite pages only
  const alpha = (await api.get('/api/picks/leaderboard?range=all&sort=roi')).body.rows.find((r) => r.profile.handle === 'alpha')
  assert.equal(alpha?.profile.ig, 'insta_alpha')
  const bravo = (await api.get('/api/picks/leaderboard?range=all&sort=units')).body.rows.find((r) => r.profile.handle === 'bravo')
  if (bravo) assert.equal(bravo.profile.ig, null)
})

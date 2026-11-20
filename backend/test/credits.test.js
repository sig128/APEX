// Credits: a monthly allotment by plan, top-up packs bought like passes, keyed spends (a retry
// never charges twice), refunds for failed uses, the admin uncharged, and the simulator's price.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createCredits, rolled, leftOf, warnOf, applyTopup, resetsAt, PACKS, creditCosts } from '../src/billing/credits.js'
import { createStore } from '../src/lib/store.js'
import { ApiError } from '../src/lib/router.js'
import { createApexApp } from '../app.js'
import { fixtureHttp } from './helpers.js'
import { fakeChain, clock, withEnv, TREASURY, txHash, testAuth, USERS, bearer, serve } from './support.js'

const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, APEX_BILLING_NETWORK: 'base', APEX_BILLING_STORE: 'store', K_SERVICE: null, VERCEL: null, APEX_CREDITS_PRO: null, APEX_CREDITS_ELITE: null, APEX_CREDIT_COSTS: null, APEX_LOG_LEVEL: 'error', APEX_AUTH: null, OPENAI_API_KEY: null })
const T0 = Date.parse('2026-11-20T15:00:00Z')
const DAY = 86_400_000
const alice = { uid: 'alice', email: 'alice@example.com' }
const freebie = { uid: 'freebie', email: 'f@example.com' }
const boss = { uid: 'boss', email: 'boss@example.com', admin: true }

async function rejectsWith(p, code) {
  await assert.rejects(p, (e) => e instanceof ApiError && e.code === code, `expected ${code}`)
}

test('the month rolls over, monthly credits go first, warnings at 80% and at zero', () => {
  let d = rolled(null, 'pro', T0)
  assert.deepEqual([d.period, d.allot, d.used, d.topup], ['2026-11', 120, 0, 0])
  d = { ...d, used: 100 }
  assert.equal(leftOf(d), 20)
  assert.equal(warnOf(d), 'low', '100 of 120 used')
  assert.equal(warnOf({ ...d, topup: 30 }), null, 'a top-up to fall back on')
  assert.equal(warnOf({ ...d, used: 120 }), 'out')
  const next = rolled({ ...d, topup: 7 }, 'elite', T0 + 15 * DAY)
  assert.deepEqual([next.period, next.allot, next.used, next.topup], ['2026-12', 300, 0, 7], 'a new month: used resets, top-up stays')
  assert.equal(resetsAt(T0), Date.parse('2026-12-01T00:00:00Z'))
  const t1 = applyTopup(null, { id: 'inv_1', credits: 50 }, T0)
  assert.equal(t1.topup, 50)
  assert.equal(applyTopup(t1, { id: 'inv_1', credits: 50 }, T0).topup, 50, 'one invoice, one top-up')
  assert.ok(PACKS.every((p) => p.priceUsd / p.credits > 79 / 300), 'packs cost more per credit than either plan')
  assert.deepEqual(creditCosts({ APEX_CREDIT_COSTS: '{"sim":4,"nope":9,"build":-1}' }), { ...creditCosts({}), sim: 4 })
})

let now
let chain
let billing
let credits
beforeEach(() => {
  now = clock(T0)
  chain = fakeChain()
  const docs = createStoreDocs(createStore({ driver: 'memory' }))
  billing = createBilling({ docs, chainFor: () => chain, now })
  credits = createCredits({ docs, billing, now })
})

test('spending: keyed, month first then top-up, out of credits, refunds, the admin free', async () => {
  await rejectsWith(credits.spend(freebie, 'sim', { key: 'sim:k1' }), 'upgrade')
  await billing.grant(boss, { uid: 'alice', plan: 'pro', days: 30 })
  let s = await credits.status(alice)
  assert.deepEqual([s.plan, s.allot, s.left, s.warn], ['pro', 120, 120, null])
  const a = await credits.spend(alice, 'sim', { key: 'sim:run-a' })
  assert.deepEqual([a.cost, a.left], [3, 117])
  const again = await credits.spend(alice, 'sim', { key: 'sim:run-a' })
  assert.deepEqual([again.already, again.cost, again.left], [true, 0, 117], 'the same run twice is charged once')
  assert.equal(await credits.paid(alice, 'sim:run-a'), true)
  // spend down to 2, then a top-up from the admin covers the rest
  await credits.spend(alice, 'build', { key: 'build:big', cost: 115 })
  await rejectsWith(credits.spend(alice, 'sim', { key: 'sim:run-b' }), 'credits_out')
  s = await credits.status(alice)
  assert.deepEqual([s.left, s.warn], [2, 'low'])
  await credits.grant(boss, { uid: 'alice', credits: 10, note: 'thanks' })
  const b = await credits.spend(alice, 'sim', { key: 'sim:run-b' })
  assert.equal(b.left, 9, '2 from the month, 1 from the top-up')
  s = await credits.status(alice)
  assert.deepEqual([s.monthLeft, s.topup], [0, 9])
  // a failed run gives back exactly what it took, from where it took it
  const r = await credits.refund(alice, 'sim:run-b')
  assert.equal(r.credits, 3)
  s = await credits.status(alice)
  assert.deepEqual([s.monthLeft, s.topup], [2, 10])
  assert.equal((await credits.refund(alice, 'sim:run-b')).none, true, 'refunding twice does nothing')
  assert.equal(await credits.paid(alice, 'sim:run-b'), false)
  assert.ok(s.log.some((e) => e.kind === 'refund') && s.log.some((e) => e.kind === 'grant'))
  // next month: a fresh 120, the top-up still there
  now.set(Date.parse('2026-12-02T00:00:00Z'))
  s = await credits.status(alice)
  assert.deepEqual([s.period, s.monthLeft, s.topup], ['2026-12', 120, 10])
  const free = await credits.spend(boss, 'sim', { key: 'sim:boss' })
  assert.equal(free.free, true, 'the admin isn’t charged')
})

test('a credit pack is bought like a pass and lands once', async () => {
  await rejectsWith(billing.createInvoice(alice, 'c50'), 'upgrade')
  await billing.grant(boss, { uid: 'alice', plan: 'pro', days: 30 })
  const inv = await billing.createInvoice(alice, 'c50')
  assert.equal(inv.kind, 'credits')
  assert.equal(inv.planName, '50 credits')
  assert.equal(inv.usd, 15)
  const h = txHash(9)
  chain.send(h, { to: TREASURY, amount: inv.units, timestamp: now(), confirmations: 5 })
  const paid = await billing.confirm(alice, inv.id, h)
  assert.equal(paid.status, 'paid')
  const s = await credits.status(alice)
  assert.deepEqual([s.topup, s.left], [50, 170])
  assert.equal((await billing.me(alice)).entitlement.plan, 'pro', 'the pass is untouched')
  assert.equal((await billing.confirm(alice, inv.id, h)).status, 'paid')
  assert.equal((await credits.status(alice)).topup, 50, 'confirming again adds nothing')
})

test('the simulator: a full run costs credits once per tap; the slip check is free', async () => {
  const docs = createStoreDocs(createStore({ driver: 'memory' }))
  const b = createBilling({ docs, chainFor: () => chain, now })
  await docs.set('subscriptions', 'u_pro', { plan: 'pro', paidUntil: now() + 20 * DAY, source: 'usdc', updatedAt: now() })
  const { http } = fixtureHttp()
  const made = createApexApp({ engineMode: 'lazy', http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS), billing: b, oddsKey: () => null, now })
  const api = await serve(made.app)
  try {
    await api.get('/api/nfl/home')
    const legs = made.engine.views.home().tabs.apex.slice(0, 3).map((c) => c.id)
    const quick = await api.post('/api/nfl/sim', { legs, quick: true }, { headers: bearer('u_pro') })
    assert.equal(quick.status, 200)
    assert.equal(quick.body.credits, null, 'the slip’s check is free')
    const run = await api.post('/api/nfl/sim', { legs, iterations: 25000, runKey: 'tap-0000001' }, { headers: bearer('u_pro') })
    assert.equal(run.status, 200)
    assert.deepEqual([run.body.credits.cost, run.body.credits.left], [3, 117])
    now.add(10_000)
    const twice = await api.post('/api/nfl/sim', { legs, iterations: 25000, runKey: 'tap-0000001' }, { headers: bearer('u_pro') })
    assert.deepEqual([twice.body.credits.cost, twice.body.credits.left], [0, 117], 'a retry of the same tap')
    now.add(10_000)
    const big = await api.post('/api/nfl/sim', { legs, iterations: 100000, runKey: 'tap-0000002' }, { headers: bearer('u_pro') })
    assert.deepEqual([big.body.credits.cost, big.body.credits.left], [5, 112], 'a large run costs more')
    const mine = await api.get('/api/billing/credits', { headers: bearer('u_pro') })
    assert.deepEqual([mine.body.left, mine.body.allot], [112, 120])
    assert.ok(mine.body.log[0].label)
    assert.equal((await api.get('/api/billing/credits')).status, 401)
    const cfg = await api.get('/api/billing/config')
    assert.equal(cfg.body.credits.costs.sim, 3)
    assert.equal(cfg.body.credits.packs.length, 3)
  } finally {
    await api.close()
    for (const e of Object.values(made.engines)) e.stop()
  }
})

after(() => restoreEnv())

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { applyPurchase, entitlementOf, dayKey, nextReset, createBilling, LIFETIME, atLeast } from '../src/billing/service.js'
import { billingConfig, usdToUnits, formatUnits, DAY_MS, publicBillingConfig } from '../src/billing/config.js'
import { createChain, TRANSFER_TOPIC } from '../src/billing/chain.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { ApiError } from '../src/lib/router.js'
import { fakeChain, clock, withEnv, TREASURY, PAYER, txHash } from './support.js'

const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, APEX_BILLING_NETWORK: 'base', APEX_USAGE_TZ: 'America/New_York', APEX_BILLING_STORE: 'store', K_SERVICE: null })
after(() => restoreEnv())

const T0 = Date.parse('2026-10-25T15:00:00Z')

test('units: dollars to micro-USDC and back', () => {
  assert.equal(usdToUnits(29), '29000000')
  assert.equal(formatUnits('29000123'), '29.000123')
  assert.equal(formatUnits('5'), '0.000005')
  assert.equal(formatUnits('0'), '0.000000')
})

test('config: paywall follows the treasury address', () => {
  assert.equal(billingConfig().paywall, true)
  let r = withEnv({ APEX_PAYWALL: 'off' })
  assert.equal(billingConfig().paywall, false)
  r()
  r = withEnv({ APEX_TREASURY_ADDRESS: 'not-an-address' })
  assert.equal(billingConfig().paywall, false)
  r()
  r = withEnv({ APEX_TREASURY_ADDRESS: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' })
  assert.equal(billingConfig().treasury, null, 'the USDC contract itself is never a treasury')
  r()
  const pub = publicBillingConfig()
  assert.deepEqual(pub.plans.map((p) => [p.id, p.priceUsd]), [['pro', 29], ['elite', 79]])
  assert.equal(pub.rpcUrl, undefined, 'no RPC url in the browser config')
})

test('plan math: buy, extend, switch with credit, lifetime, revoked', () => {
  const cfg = billingConfig()
  const P = 30 * DAY_MS
  assert.deepEqual(applyPurchase(null, 'pro', T0, cfg), { plan: 'pro', paidUntil: T0 + P, lifetime: false })
  const active = { plan: 'pro', paidUntil: T0 + 10 * DAY_MS }
  assert.equal(applyPurchase(active, 'pro', T0, cfg).paidUntil, T0 + 10 * DAY_MS + P, 'renewing early stacks')
  const up = applyPurchase(active, 'elite', T0, cfg)
  assert.equal(up.plan, 'elite')
  assert.equal(up.paidUntil, T0 + P + Math.round((10 * DAY_MS * 29) / 79), 'unused Pro time converts at the price ratio')
  const lapsed = { plan: 'elite', paidUntil: T0 - DAY_MS }
  assert.equal(applyPurchase(lapsed, 'pro', T0, cfg).paidUntil, T0 + P, 'a lapsed pass starts fresh')
  assert.deepEqual(applyPurchase(null, 'elite', T0, cfg, 'lifetime'), { plan: 'elite', paidUntil: LIFETIME, lifetime: true })
  const life = { plan: 'elite', paidUntil: LIFETIME, lifetime: true }
  assert.equal(applyPurchase(life, 'pro', T0, cfg).plan, 'elite', 'lifetime Elite stays Elite')
  const revoked = { plan: 'elite', paidUntil: T0 + 20 * DAY_MS, revoked: true }
  assert.equal(applyPurchase(revoked, 'pro', T0, cfg).paidUntil, T0 + P, 'a revoked pass gives no credit')
})

test('entitlement: active, grace (7 days), then locked out', () => {
  const cfg = billingConfig()
  const sub = { plan: 'pro', paidUntil: T0 }
  assert.equal(entitlementOf(sub, T0 - 1, cfg).status, 'active')
  const g = entitlementOf(sub, T0 + DAY_MS, cfg)
  assert.equal(g.status, 'grace')
  assert.equal(g.plan, 'pro', 'grace keeps the plan')
  assert.equal(g.daysLeft, 6)
  const x = entitlementOf(sub, T0 + 7 * DAY_MS, cfg)
  assert.equal(x.status, 'expired')
  assert.equal(x.plan, 'free', 'after grace: free tier')
  assert.equal(entitlementOf({ ...sub, revoked: true }, T0 - 1, cfg).plan, 'free')
  assert.equal(entitlementOf({ plan: 'gold', paidUntil: T0 }, T0 - 1, cfg).plan, 'free', 'unknown plans grant nothing')
  assert.equal(entitlementOf(null, T0, cfg).status, 'none')
  assert.ok(atLeast('elite', 'pro') && !atLeast('pro', 'elite') && atLeast('free', 'free'))
})

test('daily allowances reset at local midnight, DST included', () => {
  const tz = 'America/New_York'
  assert.equal(dayKey(Date.parse('2026-10-25T03:59:00Z'), tz), '2026-10-24')
  assert.equal(dayKey(Date.parse('2026-10-25T04:01:00Z'), tz), '2026-10-25')
  assert.equal(new Date(nextReset(Date.parse('2026-10-25T15:00:00Z'), tz)).toISOString(), '2026-10-26T04:00:00.000Z')
  // Nov 1, 2026: clocks fall back, so the next local midnight is 05:00Z
  assert.equal(new Date(nextReset(Date.parse('2026-11-01T15:00:00Z'), tz)).toISOString(), '2026-11-02T05:00:00.000Z')
})

// ---- the billing service against a scripted chain ---------------------------------------------

let now
let chain
let billing
let store
const alice = { uid: 'alice', email: 'alice@example.com' }
const bob = { uid: 'bob', email: 'bob@example.com' }
const admin = { uid: 'boss', email: 'boss@example.com', admin: true }

beforeEach(() => {
  now = clock(T0)
  chain = fakeChain()
  store = createStore({ driver: 'memory' })
  billing = createBilling({ docs: createStoreDocs(store), chainFor: () => chain, now })
})

async function rejectsWith(p, code) {
  await assert.rejects(p, (e) => e instanceof ApiError && e.code === code, `expected ${code}`)
}

test('invoice: unique amount per request, reused while open', async () => {
  const a = await billing.createInvoice(alice, 'pro')
  assert.equal(a.status, 'open')
  assert.equal(a.treasury, TREASURY)
  assert.ok(BigInt(a.units) > 29_000_000n && BigInt(a.units) <= 29_010_000n, a.units)
  assert.match(a.payUri, /^ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453\/transfer\?address=0x1{40}&uint256=\d+$/)
  const again = await billing.createInvoice(alice, 'pro')
  assert.equal(again.id, a.id, 'same open request comes back')
  const b = await billing.createInvoice(bob, 'pro')
  assert.notEqual(b.units, a.units, 'two people never share an amount')
  const e = await billing.createInvoice(alice, 'elite')
  assert.ok(BigInt(e.units) > 79_000_000n)
  await rejectsWith(billing.createInvoice(alice, 'gold'), 'bad_plan')
  await rejectsWith(billing.createInvoice(null, 'pro'), 'signin')
  await rejectsWith(billing.getInvoice(bob, a.id), 'not_found')
  await rejectsWith(billing.getInvoice(alice, 'inv_../../etc'), 'not_found')
})

test('invoice: daily cap', async () => {
  const ids = new Set()
  for (let i = 0; i < 20; i++) {
    await billing.docs.merge('billingUsers', alice.uid, { open: { pro: null } }) // forget the open one
    ids.add((await billing.createInvoice(alice, 'pro')).id)
  }
  assert.equal(ids.size, 20)
  await billing.docs.merge('billingUsers', alice.uid, { open: { pro: null } })
  await rejectsWith(billing.createInvoice(alice, 'pro'), 'too_many_invoices')
  now.set(nextReset(T0, 'America/New_York') + 1)
  assert.ok(await billing.createInvoice(alice, 'pro'), 'the cap resets the next day')
})

test('confirm: pending, confirming, wrong amount, then paid once', async () => {
  const inv = await billing.createInvoice(alice, 'pro')
  const h = txHash(1)
  await rejectsWith(billing.confirm(alice, inv.id, 'nope'), 'bad_hash')
  assert.equal((await billing.confirm(alice, inv.id, h)).status, 'pending')
  chain.send(h, { to: TREASURY, amount: inv.units, timestamp: now(), confirmations: 1 })
  const c = await billing.confirm(alice, inv.id, h)
  assert.equal(c.status, 'confirming')
  assert.equal(c.needed, 3)
  chain.txs.get(h).confirmations = 5
  const paid = await billing.confirm(alice, inv.id, h)
  assert.equal(paid.status, 'paid')
  assert.equal(paid.entitlement.plan, 'pro')
  assert.equal(paid.entitlement.status, 'active')
  assert.equal(paid.entitlement.paidUntil, T0 + 30 * DAY_MS)
  assert.equal((await billing.confirm(alice, inv.id, h)).status, 'paid', 'confirming again is harmless')
  const sub = await billing.docs.get('subscriptions', alice.uid)
  assert.equal(sub.source, 'usdc')
  assert.equal(sub.wallet, PAYER)
  const me = await billing.me(alice)
  assert.equal(me.payments.length, 1)
  assert.equal(me.open.length, 0, 'the paid request is no longer open')

  const wrong = await billing.createInvoice(bob, 'pro')
  chain.send(txHash(2), { to: TREASURY, amount: String(BigInt(wrong.units) - 1n), timestamp: now() })
  await rejectsWith(billing.confirm(bob, wrong.id, txHash(2)), 'tx_mismatch')
  chain.send(txHash(3), { to: '0x3333333333333333333333333333333333333333', amount: wrong.units, timestamp: now() })
  await rejectsWith(billing.confirm(bob, wrong.id, txHash(3)), 'tx_mismatch')
  chain.send(txHash(4), { to: TREASURY, amount: wrong.units, status: 'failed' })
  await rejectsWith(billing.confirm(bob, wrong.id, txHash(4)), 'tx_failed')
  chain.send(txHash(5), { to: TREASURY, amount: wrong.units, timestamp: T0 - 3600_000 })
  await rejectsWith(billing.confirm(bob, wrong.id, txHash(5)), 'tx_window')
})

test('replay: one transfer pays one request, ever', async () => {
  const a = await billing.createInvoice(alice, 'pro')
  const h = txHash(9)
  chain.send(h, { to: TREASURY, amount: a.units, timestamp: now() })
  assert.equal((await billing.confirm(alice, a.id, h)).status, 'paid')
  // a second request that happens to reuse the amount (forced) still can't reuse the hash
  const b = await billing.createInvoice(bob, 'pro')
  await billing.docs.merge('billingInvoices', b.id, { units: a.units })
  const out = await billing.confirm(bob, b.id, h)
  assert.equal(out.status, 'used')
  assert.equal((await billing.entitlement(bob)).plan, 'free')
  await rejectsWith(billing.confirm(alice, b.id, h), 'not_found', 'and not on someone else’s request')
})

test('scan finds the transfer without a pasted hash', async () => {
  const inv = await billing.createInvoice(alice, 'elite')
  assert.equal((await billing.scan(alice, inv.id)).status, 'not_found')
  now.add(60_000)
  chain.send(txHash(7), { to: TREASURY, amount: inv.units, timestamp: now(), block: chain.head - 2 })
  chain.head += 3
  const out = await billing.scan(alice, inv.id)
  assert.equal(out.status, 'paid')
  assert.equal((await billing.entitlement(alice)).plan, 'elite')
})

test('grace then lockout, renewal stacks, change listeners fire', async () => {
  const seen = []
  billing.onChange((uid) => seen.push(uid))
  const inv = await billing.createInvoice(alice, 'pro')
  chain.send(txHash(11), { to: TREASURY, amount: inv.units, timestamp: now() })
  await billing.confirm(alice, inv.id, txHash(11))
  assert.deepEqual(seen, ['alice'])
  now.set(T0 + 31 * DAY_MS)
  billing.forget(alice.uid)
  assert.equal((await billing.entitlement(alice)).status, 'grace')
  now.set(T0 + 38 * DAY_MS)
  billing.forget(alice.uid)
  const ent = await billing.entitlement(alice)
  assert.equal(ent.status, 'expired')
  assert.equal(ent.plan, 'free')
  const again = await billing.createInvoice(alice, 'pro')
  chain.send(txHash(12), { to: TREASURY, amount: again.units, timestamp: now() })
  const out = await billing.confirm(alice, again.id, txHash(12))
  assert.equal(out.entitlement.paidUntil, now() + 30 * DAY_MS, 'after lockout a payment starts a new month from today')
})

test('admin grant, lifetime and revoke', async () => {
  await rejectsWith(billing.grant(alice, { uid: 'bob', plan: 'pro', days: 30 }), 'admin')
  const g = await billing.grant(admin, { uid: 'bob', plan: 'elite', days: 14, note: 'beta tester' })
  assert.equal(g.entitlement.plan, 'elite')
  assert.equal(g.subscription.source, 'comp')
  assert.equal(g.subscription.paidUntil, T0 + 14 * DAY_MS)
  await rejectsWith(billing.grant(admin, { uid: 'bob', plan: 'elite', days: 0 }), 'bad_days')
  const life = await billing.grant(admin, { uid: 'carol', plan: 'pro', days: 'lifetime' })
  assert.equal(life.entitlement.lifetime, true)
  await rejectsWith(billing.createInvoice({ uid: 'carol' }, 'pro'), 'lifetime')
  await billing.revoke(admin, { uid: 'bob' })
  assert.equal((await billing.entitlement(bob)).plan, 'free')
  await billing.docs.set('billingUsers', 'dave', { email: 'dave@example.com', updatedAt: T0 })
  const byEmail = await billing.grant(admin, { email: 'Dave@Example.com', plan: 'pro', days: 7 })
  assert.equal(byEmail.uid, 'dave')
  await rejectsWith(billing.grant(admin, { email: 'nobody@example.com', plan: 'pro', days: 7 }), 'no_user')
  const subs = await billing.subscriptions(admin)
  assert.ok(subs.find((s) => s.uid === 'carol' && s.lifetime))
})

test('AI allowances: per plan, per day, refunds, admin and open mode', async () => {
  const restore = withEnv({ APEX_PRO_AI_READS_PER_DAY: 2 })
  const proEnt = { plan: 'pro', status: 'active' }
  assert.deepEqual(await billing.useQuota(alice, proEnt, 'aiReads'), { used: 1, limit: 2, resetsAt: nextReset(now(), 'America/New_York') })
  await billing.useQuota(alice, proEnt, 'aiReads')
  await rejectsWith(billing.useQuota(alice, proEnt, 'aiReads'), 'quota')
  await billing.refundQuota(alice, 'aiReads')
  assert.equal((await billing.useQuota(alice, proEnt, 'aiReads')).used, 2, 'a refunded read can be used again')
  await rejectsWith(billing.useQuota(bob, { plan: 'free', status: 'none' }, 'aiReads'), 'upgrade')
  now.set(nextReset(now(), 'America/New_York') + 1000)
  assert.equal((await billing.useQuota(alice, proEnt, 'aiReads')).used, 1, 'new day, new allowance')
  const fu = await billing.useQuota(alice, proEnt, 'followups')
  assert.equal(fu.limit, 24, 'three follow-ups per analysis')
  assert.ok((await billing.useQuota(admin, { plan: 'elite', status: 'admin' }, 'aiReads')).limit >= 100)
  assert.equal((await billing.useQuota(alice, { plan: 'elite', status: 'open' }, 'aiReads')).limit, null)
  restore()
})

test('paywall off: everyone gets everything (the invite gate still applies at the route)', async () => {
  const restore = withEnv({ APEX_PAYWALL: 'off' })
  assert.equal((await billing.entitlement(null)).status, 'open')
  await rejectsWith(billing.createInvoice(alice, 'pro'), 'billing_off')
  restore()
  assert.equal((await billing.entitlement(null)).status, 'anonymous')
})

// ---- the JSON-RPC client ------------------------------------------------------------------------

function rpcServer(handlers) {
  const calls = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.method)
    const h = handlers[body.method]
    const result = typeof h === 'function' ? h(body.params) : h
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) }
  }
  return { fetchImpl, calls }
}
const pad = (a) => `0x${'0'.repeat(24)}${a.slice(2)}`
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

test('chain: verifies an exact USDC transfer with enough confirmations', async () => {
  const receipt = (over = {}) => ({
    status: '0x1',
    blockNumber: '0x64',
    logs: [{ address: USDC, topics: [TRANSFER_TOPIC, pad(PAYER), pad(TREASURY)], data: `0x${(29_000_123).toString(16)}`, removed: false }],
    ...over,
  })
  const base = { eth_chainId: '0x2105', eth_blockNumber: '0x66', eth_getBlockByNumber: { timestamp: '0x6720f000' } }
  let s = rpcServer({ ...base, eth_getTransactionReceipt: receipt() })
  let c = createChain({ rpcUrl: 'x', chainId: 8453, fetchImpl: s.fetchImpl })
  const ok = await c.verifyTransfer({ txHash: txHash(1), token: USDC, to: TREASURY, amount: '29000123', minConfirmations: 3 })
  assert.equal(ok.status, 'ok')
  assert.equal(ok.from, PAYER)
  assert.equal(ok.confirmations, 3)
  assert.equal(ok.timestamp, 0x6720f000 * 1000)
  assert.equal((await c.verifyTransfer({ txHash: txHash(1), token: USDC, to: TREASURY, amount: '29000123', minConfirmations: 5 })).status, 'confirming')
  assert.equal((await c.verifyTransfer({ txHash: txHash(1), token: USDC, to: TREASURY, amount: '29000124', minConfirmations: 3 })).status, 'mismatch')
  assert.equal((await c.verifyTransfer({ txHash: txHash(1), token: '0x0000000000000000000000000000000000000001', to: TREASURY, amount: '29000123', minConfirmations: 3 })).status, 'mismatch', 'a fake token with the same event does not count')
  s = rpcServer({ ...base, eth_getTransactionReceipt: receipt({ status: '0x0' }) })
  c = createChain({ rpcUrl: 'x', chainId: 8453, fetchImpl: s.fetchImpl })
  assert.equal((await c.verifyTransfer({ txHash: txHash(1), token: USDC, to: TREASURY, amount: '29000123' })).status, 'failed')
  s = rpcServer({ ...base, eth_getTransactionReceipt: null })
  c = createChain({ rpcUrl: 'x', chainId: 8453, fetchImpl: s.fetchImpl })
  assert.equal((await c.verifyTransfer({ txHash: txHash(1), token: USDC, to: TREASURY, amount: '29000123' })).status, 'pending')
  s = rpcServer({ ...base, eth_chainId: '0x1' })
  c = createChain({ rpcUrl: 'x', chainId: 8453, fetchImpl: s.fetchImpl })
  await assert.rejects(c.verifyTransfer({ txHash: txHash(1), token: USDC, to: TREASURY, amount: '1' }), /chain 1/)
})

test('chain: scans logs forward in 2,000-block chunks', async () => {
  const ranges = []
  const s = rpcServer({
    eth_chainId: '0x2105',
    eth_blockNumber: '0x1388', // 5000
    eth_getLogs: ([q]) => {
      ranges.push([parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)])
      assert.equal(q.topics[2], pad(TREASURY))
      return parseInt(q.fromBlock, 16) >= 4000 ? [{ data: `0x${(5).toString(16)}`, transactionHash: txHash(5), blockNumber: '0x1000', removed: false }] : []
    },
  })
  const c = createChain({ rpcUrl: 'x', chainId: 8453, fetchImpl: s.fetchImpl })
  const out = await c.findTransfer({ token: USDC, to: TREASURY, amount: '5', fromBlock: 0, toBlock: 5000 })
  assert.equal(out.txHash, txHash(5))
  assert.deepEqual(ranges, [[0, 1999], [2000, 3999], [4000, 5000]])
})

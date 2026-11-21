// Buying inside the iPhone app through Apple: the purchase as Apple signed it (StoreKit 2),
// checked up to the root, tied to the buyer's account, granted once, and taken back on refund.
// The chain here is a stand-in made with openssl (test/fixtures/apple-certs.js), with its own root
// pinned in place of Apple's.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { ROOT, INTER, LEAF, LEAF_NO_OID, LEAF_KEY } from './fixtures/apple-certs.js'
import { verifyAppleJws, checkTransaction, appAccountToken, appleConfig, APPLE_ROOT_G3_SHA256 } from '../src/billing/apple.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { withEnv } from './support.js'

const ROOT_SHA = new crypto.X509Certificate(Buffer.from(ROOT, 'base64')).fingerprint256
const DAY = 86_400_000
const T0 = Date.parse('2027-01-15T16:00:00Z') // inside the stand-in chain's dates
const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url')

/** A JWS signed like StoreKit's, by the stand-in leaf. */
function sign(payload, { leaf = LEAF, chain } = {}) {
  const head = b64u({ alg: 'ES256', x5c: chain || [leaf, INTER, ROOT] })
  const body = b64u(payload)
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: LEAF_KEY, dsaEncoding: 'ieee-p1363' })
  return `${head}.${body}.${sig.toString('base64url')}`
}
const purchase = (over = {}) => ({
  transactionId: '2000000123456789',
  originalTransactionId: '2000000123456789',
  bundleId: 'com.proppickz.app',
  productId: 'com.proppickz.app.pro30',
  purchaseDate: T0,
  signedDate: T0,
  type: 'Non-Renewing Subscription',
  environment: 'Production',
  appAccountToken: appAccountToken('u_buyer'),
  ...over,
})

test('Apple’s root is pinned; the stand-in chain verifies only with its own root', () => {
  assert.equal(APPLE_ROOT_G3_SHA256, '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79')
  const jws = sign(purchase())
  assert.equal(verifyAppleJws(jws, { rootSha256: ROOT_SHA }).productId, 'com.proppickz.app.pro30')
  assert.throws(() => verifyAppleJws(jws), /Apple’s root/, 'not under Apple’s real root')
})

test('a changed purchase, a leaf without Apple’s marker, a reordered chain: all refused', () => {
  const jws = sign(purchase())
  const [h, , s] = jws.split('.')
  const forged = `${h}.${b64u(purchase({ productId: 'com.proppickz.app.elite30' }))}.${s}`
  assert.throws(() => verifyAppleJws(forged, { rootSha256: ROOT_SHA }), /signature/)
  assert.throws(() => verifyAppleJws(sign(purchase(), { leaf: LEAF_NO_OID }), { rootSha256: ROOT_SHA }), /purchase-signing/)
  assert.throws(() => verifyAppleJws(sign(purchase(), { chain: [INTER, LEAF, ROOT] }), { rootSha256: ROOT_SHA }), /chain|roles/)
  assert.throws(() => verifyAppleJws('abc.def', { rootSha256: ROOT_SHA }), /not a signed record/)
  assert.throws(() => verifyAppleJws(sign(purchase({ signedDate: Date.parse('2010-01-01') })), { rootSha256: ROOT_SHA }), /out of date/)
})

test('the purchase must be this app’s product, real (or sandbox while that’s on), and this account’s', () => {
  const cfg = appleConfig({})
  assert.equal(checkTransaction(purchase(), { cfg, uid: 'u_buyer' }).plan, 'pro')
  assert.throws(() => checkTransaction(purchase({ bundleId: 'com.other.app' }), { cfg, uid: 'u_buyer' }), /another app/)
  assert.throws(() => checkTransaction(purchase({ productId: 'com.proppickz.app.gold' }), { cfg, uid: 'u_buyer' }), /unknown product/)
  assert.throws(() => checkTransaction(purchase({ type: 'Consumable' }), { cfg, uid: 'u_buyer' }), /product type/)
  assert.throws(() => checkTransaction(purchase({ environment: 'Sandbox' }), { cfg: appleConfig({ APPLE_IAP_SANDBOX: 'off' }), uid: 'u_buyer' }), /test purchase/)
  assert.equal(checkTransaction(purchase({ environment: 'Sandbox' }), { cfg, uid: 'u_buyer' }).days, 30, 'App Review buys in the sandbox')
  assert.throws(() => checkTransaction(purchase({ revocationDate: T0 }), { cfg, uid: 'u_buyer' }), (e) => e.code === 'refunded')
  assert.throws(() => checkTransaction(purchase(), { cfg, uid: 'u_someone_else' }), (e) => e.code === 'not_yours')
  assert.match(appAccountToken('u_buyer'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(appAccountToken('u_buyer'), appAccountToken('u_buyer'))
})

test('granting: a pass once (more days on top of a pass), credits once, refunds take them back', async () => {
  const restore = withEnv({ APPLE_IAP: null, APPLE_IAP_SANDBOX: null, APNS_TOPIC: null })
  try {
    let t = T0
    const docs = createStoreDocs(createStore({ driver: 'memory' }))
    const billing = createBilling({ docs, now: () => t, appleRootSha256: ROOT_SHA })
    const buyer = { uid: 'u_buyer', email: 'b@example.com' }
    const info = billing.appleInfo(buyer)
    assert.equal(info.enabled, true)
    assert.equal(info.appAccountToken, appAccountToken('u_buyer'))
    assert.deepEqual(info.products.map((p) => p.id), ['com.proppickz.app.pro30', 'com.proppickz.app.elite30', 'com.proppickz.app.credits50', 'com.proppickz.app.credits150', 'com.proppickz.app.credits500'])

    const first = await billing.applePurchase(buyer, sign(purchase()))
    assert.deepEqual([first.ok, first.already, first.kind, first.held.plan, first.held.status], [true, false, 'pass', 'pro', 'active'])
    const sub = await docs.get('subscriptions', 'u_buyer')
    assert.equal(sub.paidUntil, T0 + 30 * DAY)
    assert.equal(sub.source, 'apple')
    // the app resends after a dropped connection: nothing doubles
    const again = await billing.applePurchase(buyer, sign(purchase()))
    assert.equal(again.already, true)
    assert.equal((await docs.get('subscriptions', 'u_buyer')).paidUntil, T0 + 30 * DAY)
    // someone else can't claim it
    await assert.rejects(billing.applePurchase({ uid: 'u_other' }, sign(purchase())), (e) => e.code === 'not_yours')

    // a second pass later stacks on the first
    t = T0 + 10 * DAY
    await billing.applePurchase(buyer, sign(purchase({ transactionId: '2000000123456790', purchaseDate: t, signedDate: t })))
    assert.equal((await docs.get('subscriptions', 'u_buyer')).paidUntil, T0 + 60 * DAY)

    // a credit pack
    const pack = await billing.applePurchase(buyer, sign(purchase({ transactionId: '2000000123456791', productId: 'com.proppickz.app.credits150', type: 'Consumable' })))
    assert.deepEqual([pack.kind, pack.credits], ['credits', 150])
    assert.equal((await docs.get('credits', 'u_buyer')).topup, 150)

    // Apple refunds the credit pack and the second pass
    const notice = (txPayload, type = 'REFUND') => sign({ notificationType: type, notificationUUID: crypto.randomUUID(), signedDate: t, data: { bundleId: 'com.proppickz.app', environment: 'Production', signedTransactionInfo: sign(txPayload) } })
    const r1 = await billing.appleNotice(notice(purchase({ transactionId: '2000000123456791', productId: 'com.proppickz.app.credits150', type: 'Consumable' })))
    assert.equal(r1.handled, true)
    assert.equal((await docs.get('credits', 'u_buyer')).topup, 0)
    const r2 = await billing.appleNotice(notice(purchase({ transactionId: '2000000123456790' })))
    assert.equal(r2.handled, true)
    assert.equal((await docs.get('subscriptions', 'u_buyer')).paidUntil, T0 + 30 * DAY)
    // the same notice twice changes nothing; other notices are acknowledged and left alone
    assert.equal((await billing.appleNotice(notice(purchase({ transactionId: '2000000123456790' })))).handled, false)
    assert.equal((await billing.appleNotice(sign({ notificationType: 'TEST', signedDate: t }))).handled, false)
    await assert.rejects(billing.appleNotice(notice(purchase()).replace(/\.[^.]+$/, '.AAAA')), /signature/)
  } finally {
    restore()
  }
})

test('switched off on the server: nothing is granted', async () => {
  const restore = withEnv({ APPLE_IAP: 'off' })
  try {
    const billing = createBilling({ docs: createStoreDocs(createStore({ driver: 'memory' })), now: () => T0, appleRootSha256: ROOT_SHA })
    assert.equal(billing.appleInfo({ uid: 'u_buyer' }).enabled, false)
    await assert.rejects(billing.applePurchase({ uid: 'u_buyer' }, sign(purchase())), (e) => e.code === 'apple_off')
  } finally {
    restore()
  }
})

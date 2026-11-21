// Buying inside the iPhone app through Apple (StoreKit 2, @capgo/native-purchases). Apple's own
// sheet takes the payment (Face ID or a double-click of the side button); the purchase goes to
// the server exactly as Apple signed it, the pass or credits switch on, and only then is it
// marked finished with Apple. So a dropped connection never loses one: anything unfinished is
// sent again the next time the app opens, and purchases that finish later (a parent approving
// Ask to Buy) arrive on their own.
import { api } from './api.js'
import { isNative } from './native.js'

let infoP = null
/** What the server sells through Apple, and this account's token for the purchase. */
export function appleInfo({ fresh = false } = {}) {
  if (!isNative()) return Promise.resolve({ enabled: false, products: [], appAccountToken: null })
  if (!infoP || fresh) infoP = api('/api/billing/apple').catch(() => ({ enabled: false, products: [], appAccountToken: null }))
  return infoP
}

const plugin = () => import('@capgo/native-purchases')

/** The products Apple has on sale for this app, with prices in the buyer's own currency. */
export async function appleProducts() {
  const info = await appleInfo()
  if (!info.enabled) return []
  const { NativePurchases, PURCHASE_TYPE } = await plugin()
  const ok = await NativePurchases.isBillingSupported().catch(() => ({ isBillingSupported: false }))
  if (!ok.isBillingSupported) return []
  const ids = info.products.map((p) => p.id)
  const { products = [] } = await NativePurchases.getProducts({ productIdentifiers: ids, productType: PURCHASE_TYPE.INAPP }).catch(() => ({ products: [] }))
  return info.products
    .map((p) => {
      const s = products.find((x) => x.identifier === p.id)
      return s ? { ...p, price: s.priceString, title: s.title } : null
    })
    .filter(Boolean)
}

/** The Apple product for a pass ('pro', 'elite') or a credit pack ('c50', 'c150', 'c500'). */
export function productFor(products, buy) {
  if (/^c\d+$/.test(String(buy))) return products.find((p) => p.kind === 'credits' && p.credits === Number(String(buy).slice(1))) || null
  return products.find((p) => p.kind === 'pass' && p.plan === buy) || null
}

async function deliver(tx) {
  if (!tx?.jwsRepresentation) throw new Error('Apple didn’t hand over the purchase. If you were charged, it switches on the next time the app opens.')
  const out = await api('/api/billing/apple', { method: 'POST', body: { jws: tx.jwsRepresentation } })
  const { NativePurchases } = await plugin()
  await NativePurchases.finishTransaction({ transactionId: tx.transactionId }).catch(() => {})
  return out
}

/**
 * Apple's sheet, then the server. Resolves the server's answer, `null` when the buyer cancels,
 * or `{ pending: true }` when Apple holds it for approval (Ask to Buy): it switches on by itself.
 */
export async function buyWithApple(product) {
  let info = await appleInfo()
  if (!info.appAccountToken) info = await appleInfo({ fresh: true })
  if (!info.appAccountToken) throw new Error('Sign in first.')
  const { NativePurchases, PURCHASE_TYPE } = await plugin()
  let tx
  try {
    tx = await NativePurchases.purchaseProduct({ productIdentifier: product.id, productType: PURCHASE_TYPE.INAPP, quantity: 1, appAccountToken: info.appAccountToken, autoAcknowledgePurchases: false })
  } catch (e) {
    const m = String(e?.message || e || '')
    if (/cancel/i.test(m)) return null
    if (/pending/i.test(m)) return { pending: true }
    throw new Error(m || 'Apple couldn’t complete the purchase.')
  }
  return deliver(tx)
}

// a purchase that will never count (refunded, or not a real Apple purchase) is cleared from
// Apple's queue; one made from another PropPickz account waits for that account
const FINAL = new Set(['refunded', 'bad_purchase'])

async function settle(tx) {
  try {
    await deliver(tx)
    return true
  } catch (e) {
    if (FINAL.has(e?.code)) {
      const { NativePurchases } = await plugin()
      await NativePurchases.finishTransaction({ transactionId: tx.transactionId }).catch(() => {})
    }
    return false
  }
}

let listening = false
/**
 * After sign-in: send anything Apple took but the server never confirmed, and listen for
 * purchases that finish later. `after` runs when one switched on (to refresh the plan shown).
 */
export async function watchApplePurchases(after = () => {}) {
  if (!isNative()) return
  const info = await appleInfo({ fresh: true })
  if (!info.enabled || !info.appAccountToken) return
  const { NativePurchases } = await plugin()
  if (!listening) {
    listening = true
    NativePurchases.addListener('transactionUpdated', async (tx) => {
      if (await settle(tx)) after()
    }).catch(() => {
      listening = false
    })
  }
  const { transactions = [] } = await NativePurchases.getUnfinishedTransactions().catch(() => ({ transactions: [] }))
  let n = 0
  for (const tx of transactions) if (await settle(tx)) n++
  if (n) after()
}

/**
 * Restore purchases: Apple's purchase history for this Apple account, sent to the server again.
 * The server grants only what it hasn't seen, so this never doubles anything. Returns how many
 * were new (passes live on the PropPickz account, so they're on every device signed into it).
 */
export async function restoreApplePurchases() {
  if (!isNative()) return 0
  const info = await appleInfo({ fresh: true })
  if (!info.enabled || !info.appAccountToken) return 0
  const { NativePurchases, PURCHASE_TYPE } = await plugin()
  await NativePurchases.restorePurchases().catch(() => {})
  const { purchases = [] } = await NativePurchases.getPurchases({ productType: PURCHASE_TYPE.INAPP, appAccountToken: info.appAccountToken })
  let n = 0
  for (const tx of purchases) {
    if (!tx?.jwsRepresentation) continue
    try {
      const out = await api('/api/billing/apple', { method: 'POST', body: { jws: tx.jwsRepresentation } })
      if (!out.already) n++
      await NativePurchases.finishTransaction({ transactionId: tx.transactionId }).catch(() => {})
    } catch {
      /* another PropPickz account's purchase, or refunded */
    }
  }
  return n
}

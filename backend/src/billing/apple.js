// Passes and credit packs bought inside the iPhone app, through Apple's in-app purchase.
// The app hands over the purchase exactly as Apple signed it (a StoreKit 2 JWS); this checks
// Apple's signature all the way up to Apple's root certificate, that it's this app's product
// and this person's purchase, and grants it once. Apple's refund notices take it back.
//
// The 30-day passes are non-renewing subscriptions and the credit packs are consumables, set up
// in App Store Connect under these product ids (the bundle id plus a suffix). Prices are set
// there too: Apple keeps 15% under the Small Business Program.
import crypto from 'node:crypto'
import { ApiError } from '../lib/router.js'

// Apple Root CA - G3 (ECDSA P-384, to 2039), SHA-256 as Apple publishes it in its root list
export const APPLE_ROOT_G3_SHA256 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79'

// Apple's markers inside the certificates (DER of the OIDs Apple's own library checks):
// 1.2.840.113635.100.6.11.1 on the signing leaf, 1.2.840.113635.100.6.2.1 on the intermediate
const OID_LEAF = Buffer.from('060a2a864886f76364060b01', 'hex')
const OID_INTER = Buffer.from('060a2a864886f76364060201', 'hex')

export function appleConfig(env = process.env) {
  const bundleId = String(env.APNS_TOPIC || env.APPLE_BUNDLE_ID || 'com.proppickz.app').trim()
  const p = (suffix) => `${bundleId}.${suffix}`
  return {
    enabled: String(env.APPLE_IAP || 'on').toLowerCase() !== 'off',
    bundleId,
    // App Review and TestFlight buy in Apple's sandbox, so it counts unless switched off
    sandbox: String(env.APPLE_IAP_SANDBOX || 'on').toLowerCase() !== 'off',
    products: {
      [p('pro30')]: { kind: 'pass', plan: 'pro', days: 30, type: 'Non-Renewing Subscription' },
      [p('elite30')]: { kind: 'pass', plan: 'elite', days: 30, type: 'Non-Renewing Subscription' },
      [p('credits50')]: { kind: 'credits', credits: 50, type: 'Consumable' },
      [p('credits150')]: { kind: 'credits', credits: 150, type: 'Consumable' },
      [p('credits500')]: { kind: 'credits', credits: 500, type: 'Consumable' },
    },
  }
}

/**
 * The account token the app attaches to each purchase, so a purchase can only ever count for the
 * account that made it. A UUID (StoreKit's format) derived from the user id; not a secret: the
 * protection is that Apple signs it into the purchase.
 */
export function appAccountToken(uid) {
  const h = crypto.createHash('sha256').update(`proppickz-apple:${uid}`).digest()
  h[6] = (h[6] & 0x0f) | 0x40
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

const bad = (why) => new ApiError(400, 'bad_purchase', `Apple's purchase record didn't check out (${why}).`)
const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/**
 * Verify a JWS Apple signed (a transaction, or a server notification) and return its payload.
 * The chain in its header must run leaf -> intermediate -> Apple's root (pinned), each signed by
 * the next, valid when Apple signed, carrying Apple's markers; then the signature itself.
 */
export function verifyAppleJws(jws, { rootSha256 = APPLE_ROOT_G3_SHA256 } = {}) {
  const parts = String(jws || '').split('.')
  if (parts.length !== 3 || parts.some((x) => !x)) throw bad('not a signed record')
  let header
  let payload
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'))
    payload = JSON.parse(b64url(parts[1]).toString('utf8'))
  } catch {
    throw bad('unreadable')
  }
  if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3) throw bad('unexpected signature type')
  let leaf
  let inter
  let root
  try {
    ;[leaf, inter, root] = header.x5c.map((c) => new crypto.X509Certificate(Buffer.from(c, 'base64')))
  } catch {
    throw bad('unreadable certificates')
  }
  if (root.fingerprint256 !== rootSha256) throw bad('not signed under Apple’s root')
  if (!root.verify(root.publicKey) || !inter.verify(root.publicKey) || !leaf.verify(inter.publicKey)) throw bad('broken certificate chain')
  if (!inter.ca || leaf.ca) throw bad('wrong certificate roles')
  if (!leaf.raw.includes(OID_LEAF) || !inter.raw.includes(OID_INTER)) throw bad('not Apple’s purchase-signing certificate')
  // valid when Apple signed it (a purchase replayed years later still checks against its own date)
  const at = Number(payload.signedDate) || Date.now()
  for (const c of [leaf, inter, root]) if (at < Date.parse(c.validFrom) || at > Date.parse(c.validTo)) throw bad('certificate out of date')
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, b64url(parts[2]))
  if (!ok) throw bad('signature doesn’t match')
  return payload
}

/** A transaction Apple signed, checked against this app, its products and the buyer. */
export function checkTransaction(tx, { cfg = appleConfig(), uid } = {}) {
  if (tx.bundleId !== cfg.bundleId) throw bad('another app’s purchase')
  const product = cfg.products[tx.productId]
  if (!product) throw bad('unknown product')
  if (tx.type && tx.type !== product.type) throw bad('unexpected product type')
  if (tx.environment !== 'Production' && !(tx.environment === 'Sandbox' && cfg.sandbox)) throw bad('test purchase')
  if (tx.revocationDate) throw new ApiError(409, 'refunded', 'Apple refunded that purchase.')
  if (uid && String(tx.appAccountToken || '').toLowerCase() !== appAccountToken(uid)) throw new ApiError(403, 'not_yours', 'That purchase was made from another PropPickz account.')
  if (!tx.transactionId) throw bad('no transaction id')
  return product
}

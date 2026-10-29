// Invite codes and plan codes, redeemed through the API (POST /api/billing/redeem) or the old
// Firebase callable, with one set of rules:
// - a plain code marks the account as invited (users/{uid}.inviteVerifiedAt); it doesn't unlock
//   the AI, which takes a real Pro or Elite pass
// - a plan code ({ plan: 'pro' | 'elite', days: 30 | 'lifetime' }) adds that pass, stacking on
//   time the person already has; each person can use a given code once
// - every try is counted before the code is looked at (8 an hour per account; a code that
//   works is given back), and every kind of miss gets the same answer
import { ApiError } from '../lib/router.js'
import { applyPurchase, entitlementOf } from './service.js'
import { billingConfig, DAY_MS } from './config.js'

const MAX_TRIES = 8
const TRY_WINDOW_MS = 60 * 60_000
const MISS = 'That code isn’t valid, or it has expired or been used up.'

export function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\s+/g, '') : ''
}

const millis = (v) => (typeof v === 'number' ? v : typeof v?.toMillis === 'function' ? v.toMillis() : null)

async function takeTry(db, uid, t) {
  const ref = db.collection('inviteAttempts').doc(uid)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const d = snap.exists ? snap.data() : null
    const fresh = !d || !(d.windowStart > t - TRY_WINDOW_MS)
    const n = fresh ? 0 : d.n || 0
    if (n >= MAX_TRIES) throw new ApiError(429, 'tries', 'Too many tries. Wait an hour and check the code with whoever gave it to you.', { retryAfter: 3600 })
    tx.set(ref, { n: n + 1, windowStart: fresh ? t : d.windowStart, updatedAt: t })
  })
}

async function giveBackTry(db, uid, t) {
  const ref = db.collection('inviteAttempts').doc(uid)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return
    const d = snap.data()
    tx.set(ref, { ...d, n: Math.max(0, (d.n || 0) - 1), updatedAt: t })
  })
}

/**
 * Redeem `rawCode` for a signed-in Google user ({ uid, email, name }). `db` is a Firestore
 * (Admin SDK) instance. Returns { ok, alreadyVerified, plan, entitlement }.
 */
export async function redeemInvite(db, user, rawCode, { now = Date.now, cfg = billingConfig() } = {}) {
  if (!user?.uid || user.viaKey) throw new ApiError(401, 'signin', 'Sign in with Google first.')
  const code = normalizeCode(rawCode)
  if (code.length < 4 || code.length > 48 || !/^[A-Z0-9-]+$/.test(code)) throw new ApiError(400, 'bad_code', 'Enter the code exactly as you got it.')
  const uid = user.uid
  await takeTry(db, uid, now())
  const userRef = db.collection('users').doc(uid)
  const codeRef = db.collection('inviteCodes').doc(code)
  const redemptionRef = db.collection('inviteRedemptions').doc(`${code}_${uid}`)
  const subRef = db.collection('subscriptions').doc(uid)
  const miss = () => new ApiError(404, 'miss', MISS)

  const out = await db.runTransaction(async (tx) => {
    const [userSnap, codeSnap, redemptionSnap, subSnap] = await Promise.all([tx.get(userRef), tx.get(codeRef), tx.get(redemptionRef), tx.get(subRef)])
    const verifiedAt = userSnap.exists ? userSnap.data()?.inviteVerifiedAt ?? null : null
    const verified = verifiedAt != null
    if (!codeSnap.exists) throw miss()
    const data = codeSnap.data()
    const plan = data?.plan === 'pro' || data?.plan === 'elite' ? data.plan : null

    if (!plan && verified) return { ok: true, alreadyVerified: true, plan: null, entitlement: null }
    if (redemptionSnap.exists) {
      if (!plan) return { ok: true, alreadyVerified: verified, plan: null, entitlement: null }
      throw new ApiError(409, 'used', 'You already used this code.')
    }
    if (data?.active === false) throw miss()
    const expiresAt = millis(data?.expiresAt)
    const t = now()
    if (expiresAt && t > expiresAt) throw miss()
    const uses = data?.usesRemaining
    if (typeof uses === 'number') {
      if (uses <= 0) throw miss()
      tx.set(codeRef, { usesRemaining: uses - 1 }, { merge: true })
    }

    let entitlement = null
    if (plan) {
      const lifetime = data.days === 'lifetime'
      const days = lifetime ? null : Math.min(3650, Math.max(1, Math.round(Number(data.days) || 30)))
      const sub = subSnap.exists ? subSnap.data() : null
      const next = { ...applyPurchase(sub, plan, t, cfg, lifetime ? 'lifetime' : days * DAY_MS), source: 'invite', note: `code ${code}`, updatedAt: t, email: user.email ?? sub?.email ?? null }
      tx.set(subRef, next)
      entitlement = entitlementOf(next, t, cfg)
    }
    tx.set(redemptionRef, { code, uid, plan, at: t, email: user.email ?? null, name: user.name ?? null })
    tx.set(userRef, { inviteVerifiedAt: verified ? verifiedAt : t, inviteCodeUsed: code, email: user.email ?? null }, { merge: true })
    return { ok: true, alreadyVerified: verified, plan, entitlement }
  })
  await giveBackTry(db, uid, now()).catch(() => {})
  return out
}

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { applyPurchase, entitlementOf } from './apex/src/billing/service.js'
import { billingConfig, DAY_MS } from './apex/src/billing/config.js'

if (!getApps().length) {
  initializeApp()
}

const db = getFirestore()

// Wrong guesses per account: 8 an hour. A sign-in is needed to try at all, and every kind of
// miss gets the same answer, so there's nothing to learn from probing.
const MAX_MISSES = 8
const MISS_WINDOW_MS = 60 * 60_000
const MISS = 'That code isn’t valid, or it has expired or been used up.'

async function guardMisses(uid) {
  const ref = db.collection('inviteAttempts').doc(uid)
  const snap = await ref.get()
  const d = snap.exists ? snap.data() : null
  if (d && d.windowStart > Date.now() - MISS_WINDOW_MS && d.n >= MAX_MISSES) {
    throw new HttpsError('resource-exhausted', 'Too many tries. Wait an hour and check the code with whoever gave it to you.')
  }
}

async function noteMiss(uid) {
  const ref = db.collection('inviteAttempts').doc(uid)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const d = snap.exists ? snap.data() : null
    const fresh = !d || d.windowStart <= Date.now() - MISS_WINDOW_MS
    tx.set(ref, { n: fresh ? 1 : (d.n || 0) + 1, windowStart: fresh ? Date.now() : d.windowStart, updatedAt: Date.now() })
  })
}

function normalizeCode(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

/**
 * Callable: redeem an invite code.
 * - A plain code (no `plan`) unlocks the AI the way it always has: users/{uid}.inviteVerifiedAt.
 * - A plan code ({ plan: 'pro' | 'elite', days: 30 | 'lifetime' }) also adds that pass to the
 *   user's subscription, stacking on time they already have. Each person can use a code once.
 * Clients can't forge either: Firestore rules block their writes to these collections.
 */
export const redeemInvite = onCall(
  {
    region: 'us-central1',
    invoker: 'public',
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in with Google first.')
    }

    const code = normalizeCode(request.data?.code ?? '')
    if (code.length < 4 || code.length > 48 || !/^[A-Z0-9-]+$/.test(code)) {
      throw new HttpsError('invalid-argument', 'Enter the code exactly as you got it.')
    }

    const uid = request.auth.uid
    await guardMisses(uid)
    const token = request.auth.token
    const userRef = db.collection('users').doc(uid)
    const codeRef = db.collection('inviteCodes').doc(code)
    const redemptionRef = db.collection('inviteRedemptions').doc(`${code}_${uid}`)
    const subRef = db.collection('subscriptions').doc(uid)
    const cfg = billingConfig()

    const miss = () => new HttpsError('not-found', MISS, { miss: true })
    return db.runTransaction(async (transaction) => {
      const [userSnap, codeSnap, redemptionSnap, subSnap] = await Promise.all([transaction.get(userRef), transaction.get(codeRef), transaction.get(redemptionRef), transaction.get(subRef)])
      const verified = userSnap.exists && userSnap.data()?.inviteVerifiedAt != null

      if (!codeSnap.exists) throw miss()
      const data = codeSnap.data()
      const plan = data?.plan === 'pro' || data?.plan === 'elite' ? data.plan : null

      if (!plan && verified) return { ok: true, alreadyVerified: true }
      if (redemptionSnap.exists) {
        if (!plan) return { ok: true, alreadyVerified: verified }
        throw new HttpsError('already-exists', 'You already used this code.')
      }
      if (data?.active === false) throw miss()
      const expiresAt = data?.expiresAt?.toMillis?.() ?? (typeof data?.expiresAt === 'number' ? data.expiresAt : null)
      if (expiresAt && Date.now() > expiresAt) throw miss()

      const uses = data?.usesRemaining
      if (typeof uses === 'number') {
        if (uses <= 0) throw miss()
        transaction.update(codeRef, { usesRemaining: uses - 1 })
      }

      let ent = null
      if (plan) {
        const lifetime = data.days === 'lifetime'
        const days = lifetime ? null : Math.min(3650, Math.max(1, Math.round(Number(data.days) || 30)))
        const now = Date.now()
        const sub = subSnap.exists ? subSnap.data() : null
        const next = { ...applyPurchase(sub, plan, now, cfg, lifetime ? 'lifetime' : days * DAY_MS), source: 'invite', note: `code ${code}`, updatedAt: now, email: token.email ?? sub?.email ?? null }
        transaction.set(subRef, next)
        ent = entitlementOf(next, now, cfg)
      }

      transaction.set(redemptionRef, { code, uid, plan, at: Timestamp.now() })
      transaction.set(
        userRef,
        {
          inviteVerifiedAt: verified ? userSnap.data().inviteVerifiedAt : FieldValue.serverTimestamp(),
          inviteCodeUsed: code,
          email: token.email ?? null,
        },
        { merge: true },
      )
      transaction.set(
        db.collection('used_invites').doc(code),
        {
          inviteCode: code,
          redemptions: FieldValue.arrayUnion({
            uid,
            email: token.email ?? null,
            name: token.name ?? null,
            picture: token.picture ?? null,
            plan,
            redeemedAt: Timestamp.now(),
          }),
        },
        { merge: true },
      )

      return { ok: true, alreadyVerified: verified, plan, entitlement: ent }
    }).catch(async (e) => {
      if (e instanceof HttpsError && e.details?.miss) await noteMiss(uid).catch(() => {})
      throw e
    })
  },
)

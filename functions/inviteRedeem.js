import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { applyPurchase, entitlementOf } from './apex/src/billing/service.js'
import { billingConfig, DAY_MS } from './apex/src/billing/config.js'

if (!getApps().length) {
  initializeApp()
}

const db = getFirestore()

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
      throw new HttpsError('invalid-argument', 'Enter a valid invite code.')
    }

    const uid = request.auth.uid
    const token = request.auth.token
    const userRef = db.collection('users').doc(uid)
    const codeRef = db.collection('inviteCodes').doc(code)
    const redemptionRef = db.collection('inviteRedemptions').doc(`${code}_${uid}`)
    const subRef = db.collection('subscriptions').doc(uid)
    const cfg = billingConfig()

    return db.runTransaction(async (transaction) => {
      const [userSnap, codeSnap, redemptionSnap, subSnap] = await Promise.all([transaction.get(userRef), transaction.get(codeRef), transaction.get(redemptionRef), transaction.get(subRef)])
      const verified = userSnap.exists && userSnap.data()?.inviteVerifiedAt != null

      if (!codeSnap.exists) {
        throw new HttpsError('not-found', 'That invite code is not valid.')
      }
      const data = codeSnap.data()
      const plan = data?.plan === 'pro' || data?.plan === 'elite' ? data.plan : null

      if (!plan && verified) return { ok: true, alreadyVerified: true }
      if (redemptionSnap.exists) {
        if (!plan) return { ok: true, alreadyVerified: verified }
        throw new HttpsError('already-exists', 'You already used this code.')
      }
      if (data?.active === false) {
        throw new HttpsError('failed-precondition', 'This invite code is no longer active.')
      }
      const expiresAt = data?.expiresAt?.toMillis?.() ?? (typeof data?.expiresAt === 'number' ? data.expiresAt : null)
      if (expiresAt && Date.now() > expiresAt) {
        throw new HttpsError('failed-precondition', 'This invite code has expired.')
      }

      const uses = data?.usesRemaining
      if (typeof uses === 'number') {
        if (uses <= 0) {
          throw new HttpsError('resource-exhausted', 'This invite code has no uses left.')
        }
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
    })
  },
)

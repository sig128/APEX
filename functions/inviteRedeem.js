import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'

if (!getApps().length) {
  initializeApp()
}

const db = getFirestore()

function normalizeCode(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

/**
 * Callable: validates an invite code in Firestore, optionally decrements usesRemaining,
 * and records verification on users/{uid}. Client cannot forge verification (writes blocked by rules).
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
    const userRef = db.collection('users').doc(uid)

    return db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef)
      if (userSnap.exists && userSnap.data()?.inviteVerifiedAt != null) {
        return { ok: true, alreadyVerified: true }
      }

      const codeRef = db.collection('inviteCodes').doc(code)
      const codeSnap = await transaction.get(codeRef)

      if (!codeSnap.exists) {
        throw new HttpsError('not-found', 'That invite code is not valid.')
      }

      const data = codeSnap.data()
      if (data?.active === false) {
        throw new HttpsError('failed-precondition', 'This invite code is no longer active.')
      }

      const uses = data?.usesRemaining
      if (typeof uses === 'number') {
        if (uses <= 0) {
          throw new HttpsError('resource-exhausted', 'This invite code has no uses left.')
        }
        transaction.update(codeRef, { usesRemaining: uses - 1 })
      }

      transaction.set(
        userRef,
        {
          inviteVerifiedAt: FieldValue.serverTimestamp(),
          inviteCodeUsed: code,
          email: request.auth.token.email ?? null,
        },
        { merge: true },
      )

      const token = request.auth.token
      const usedRef = db.collection('used_invites').doc(code)
      transaction.set(
        usedRef,
        {
          inviteCode: code,
          redemptions: FieldValue.arrayUnion({
            uid,
            email: token.email ?? null,
            name: token.name ?? null,
            picture: token.picture ?? null,
            redeemedAt: Timestamp.now(),
          }),
        },
        { merge: true },
      )

      return { ok: true, alreadyVerified: false }
    })
  },
)

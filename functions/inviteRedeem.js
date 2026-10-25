import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { redeemInvite as redeem } from './apex/src/billing/invites.js'

if (!getApps().length) {
  initializeApp()
}

const db = getFirestore()

// API error codes -> callable error codes, so older sites keep showing the right message.
const CODES = { 400: 'invalid-argument', 401: 'unauthenticated', 404: 'not-found', 409: 'already-exists', 429: 'resource-exhausted', 503: 'unavailable' }

/**
 * Callable: redeem an invite code or a plan code. The site now calls POST /api/billing/redeem,
 * which runs the same rules (apex/src/billing/invites.js); this stays for older clients.
 */
export const redeemInvite = onCall(
  {
    region: 'us-central1',
    invoker: 'public',
  },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in with Google first.')
    const t = request.auth.token || {}
    try {
      return await redeem(db, { uid: request.auth.uid, email: t.email ?? null, name: t.name ?? null }, request.data?.code ?? '')
    } catch (e) {
      if (e?.status && CODES[e.status]) throw new HttpsError(CODES[e.status], e.message)
      throw e
    }
  },
)

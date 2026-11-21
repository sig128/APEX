// Deleting an account, from Account on the website or in the app (the App Store requires it in
// the app). Picks and the record, the picks page and its handle, group places, contest entries,
// alerts, limits, credits, passes and the consent record go; then the sign-in itself, last, so a
// failure on the way can simply be tried again while still signed in.
// Payment records stay (the law keeps them), under an id that no longer belongs to anyone;
// feedback notes and fair-play notes stay with the team.
import { ApiError } from '../lib/router.js'

export const USER_DOCS = ['alerts', 'rg', 'credits', 'subscriptions', 'billingUsers', 'users', 'inviteAttempts']

/** Firebase Auth's own record of the person (default: the Admin SDK). */
export async function deleteFirebaseUser(uid) {
  const { getAuth } = await import('firebase-admin/auth')
  const { getApps, initializeApp } = await import('firebase-admin/app')
  if (!getApps().length) initializeApp()
  try {
    await getAuth().deleteUser(uid)
  } catch (e) {
    if (e?.code !== 'auth/user-not-found') throw e
  }
  return true
}

export function createEraser({ docs, picks, groups, contests, push, members, deleteAuthUser = deleteFirebaseUser }) {
  return async function erase(user) {
    const uid = user?.uid
    if (!uid || uid === 'admin' || user.admin) throw new ApiError(400, 'bad_user', 'This account can’t be deleted here.')
    const groupsLeft = await groups.eraseUser(user)
    const { picks: picksDeleted, page } = await picks.eraseUser(uid)
    const contestEntries = await contests.eraseUser(uid)
    await push.eraseUser(uid)
    await members.eraseUser(uid)
    for (const col of USER_DOCS) await docs.del(col, uid).catch(() => null)
    await deleteAuthUser(uid)
    return { ok: true, deleted: { picks: picksDeleted, page, groups: groupsLeft, contestEntries } }
  }
}

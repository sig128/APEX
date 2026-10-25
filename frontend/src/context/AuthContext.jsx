import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db, firebaseConfigured, googleProvider } from '../firebase.js'
import { api, setTokenGetter } from '../lib/api.js'
import { invalidate } from '../lib/useApi.js'

// Requests made while Firebase is still restoring a saved session wait for it (briefly), so a
// signed-in visitor's first requests already carry their token.
const ready = auth?.authStateReady ? Promise.race([auth.authStateReady(), new Promise((r) => setTimeout(r, 2500))]) : Promise.resolve()
setTokenGetter(async (force) => {
  await ready
  return auth?.currentUser ? auth.currentUser.getIdToken(force) : null
})

const AuthContext = createContext(null)

// Google sign-in through Firebase. Who is an admin, and what plan someone has, is decided by
// the API from the signed-in token, never by the browser.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(Boolean(auth))
  /** null while loading the user's invite status (the legacy gate), then true/false. */
  const [inviteAccess, setInviteAccess] = useState(false)

  useEffect(() => {
    if (!auth) return undefined
    let first = true
    let lastUid = null
    return onAuthStateChanged(auth, (u) => {
      // signing in or out changes what some pages show (owner views, plans): refetch them
      if (!first && (u?.uid || null) !== lastUid) invalidate('/api/')
      first = false
      lastUid = u?.uid || null
      setUser(u)
      setInviteAccess(u ? null : false)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!user || !db) return undefined
    return onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => setInviteAccess(Boolean(snap.data()?.inviteVerifiedAt)),
      () => setInviteAccess(false),
    )
  }, [user?.uid])

  const signInGoogle = useCallback(async () => {
    if (!auth) throw new Error('Sign-in is not set up on this site yet (Firebase config missing).')
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (e) {
      // Popups are blocked in some in-app browsers (Instagram, X): fall back to a redirect.
      if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') await signInWithRedirect(auth, googleProvider)
      else if (e?.code !== 'auth/popup-closed-by-user' && e?.code !== 'auth/cancelled-popup-request') throw e
    }
  }, [])

  const signOutUser = useCallback(async () => {
    if (auth) await signOut(auth)
  }, [])

  const redeemInviteCode = useCallback(async (code) => {
    if (!auth) throw new Error('Sign-in is not set up on this site yet.')
    return api('/api/billing/redeem', { method: 'POST', body: { code } })
  }, [])

  const value = useMemo(
    () => ({
      user,
      loading,
      firebaseConfigured,
      signInGoogle,
      signOutUser,
      redeemInviteCode,
      inviteLoading: Boolean(user) && inviteAccess === null,
      hasInviteAccess: inviteAccess === true,
      // kept for the analyzer's older code paths; there is no client-side admin login any more
      adminDevSession: false,
    }),
    [user, loading, inviteAccess, signInGoogle, signOutUser, redeemInviteCode],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db, firebaseConfigured, getRedeemInviteCallable, googleProvider } from '../firebase.js'

const ADMIN_DEV_KEY = 'apex_admin_dev'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  /** Local dev bypass: password checked against VITE_ADMIN_DEV_PASSWORD (see .env). */
  const [adminDevSession, setAdminDevSession] = useState(
    () => typeof sessionStorage !== 'undefined' && sessionStorage.getItem(ADMIN_DEV_KEY) === '1',
  )
  /** `null` while resolving Firestore for the signed-in user; then true or false. */
  const [inviteAccess, setInviteAccess] = useState(false)

  useEffect(() => {
    if (!auth) {
      setLoading(false)
      return
    }
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u)
      if (u) setInviteAccess(null)
      else setInviteAccess(false)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!user || !db) {
      return
    }
    const ref = doc(db, 'users', user.uid)
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setInviteAccess(!!snap.data()?.inviteVerifiedAt)
      },
      () => {
        setInviteAccess(false)
      },
    )
    return () => unsub()
  }, [user?.uid])

  async function signInGoogle() {
    if (!auth) {
      throw new Error('Firebase Auth is not configured (missing VITE_FIREBASE_* in .env).')
    }
    await signInWithPopup(auth, googleProvider)
  }

  function clearAdminDevSession() {
    setAdminDevSession(false)
    try {
      sessionStorage.removeItem(ADMIN_DEV_KEY)
    } catch {
      /* ignore */
    }
  }

  function signInAdminDev(password) {
    const expected = import.meta.env.VITE_ADMIN_DEV_PASSWORD
    if (!expected || typeof expected !== 'string' || expected.length === 0) {
      throw new Error('Admin dev login is not configured (set VITE_ADMIN_DEV_PASSWORD in frontend/.env).')
    }
    if (password !== expected) {
      throw new Error('Incorrect password.')
    }
    try {
      sessionStorage.setItem(ADMIN_DEV_KEY, '1')
    } catch {
      /* ignore */
    }
    setAdminDevSession(true)
    return Promise.resolve()
  }

  async function signOutUser() {
    clearAdminDevSession()
    if (!auth) return
    await signOut(auth)
  }

  async function redeemInviteCode(code) {
    const fn = getRedeemInviteCallable()
    if (!fn) {
      throw new Error('Firebase is not configured.')
    }
    const result = await fn({ code })
    return result.data
  }

  const inviteLoading = Boolean(user) && inviteAccess === null && !adminDevSession
  const hasInviteAccess = inviteAccess === true || adminDevSession

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        firebaseConfigured,
        signInGoogle,
        signInAdminDev,
        signOutUser,
        redeemInviteCode,
        inviteLoading,
        hasInviteAccess,
        adminDevSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

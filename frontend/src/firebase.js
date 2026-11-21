import { initializeApp, getApps } from 'firebase/app'
import { getAuth, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, GoogleAuthProvider } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  ...(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
    ? { measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID }
    : {}),
}

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId,
)

function getOrCreateApp() {
  if (getApps().length) return getApps()[0]
  return initializeApp(firebaseConfig)
}

export const app = firebaseConfigured ? getOrCreateApp() : null
// In the iPhone app, sign-in comes from Apple's and Google's own sheets (signInWithCredential), so
// the web pop-up helper is left out: inside the app's web view it waits on a page that never
// loads, and the app would never learn who's signed in.
function makeAuth(a) {
  if (import.meta.env.VITE_NATIVE !== '1') return getAuth(a)
  try {
    return initializeAuth(a, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] })
  } catch {
    return getAuth(a) // already set up (a hot reload)
  }
}
export const auth = firebaseConfigured ? makeAuth(app) : null
export const googleProvider = new GoogleAuthProvider()
export const db = firebaseConfigured ? getFirestore(app) : null

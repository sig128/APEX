import { useState } from 'react'
import { Navigate, useSearchParams, Link } from 'react-router-dom'
import { useAuth, appleSignInAvailable } from '../context/AuthContext.jsx'
import { isNative } from '../lib/native.js'
import { useTitle } from '../lib/hooks.js'
import { Logo } from '../brand/Logo.jsx'

/** What went wrong with Google sign-in, in plain words (Firebase's codes otherwise). */
export function signInError(e) {
  switch (e?.code) {
    case 'auth/unauthorized-domain':
      return `Sign-in isn't switched on for ${window.location.hostname} yet. The site owner adds it in Firebase under Authentication, Settings, Authorized domains.`
    case 'auth/operation-not-allowed':
      return 'Google sign-in is turned off for this site. The site owner turns it on in Firebase under Authentication, Sign-in method.'
    case 'auth/network-request-failed':
      return "Couldn't reach Google. Check your connection and try again."
    case 'auth/too-many-requests':
      return 'Too many sign-in attempts. Wait a few minutes and try again.'
    case 'auth/user-disabled':
      return 'This account is disabled.'
    case 'auth/account-exists-with-different-credential':
      return 'That email already has a PropPickz account under another sign-in. Use the one you signed up with.'
    default:
      return e?.message || 'Sign-in failed. Try again.'
  }
}

// Apple's own logo from the system font, on Apple devices only (elsewhere the button is words)
const appleDevice = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent || '')

/** Sign in with Google or Apple. Stats don't need an account; picks pages, passes and the AI do. */
export function LoginPage() {
  const { user, loading, signInGoogle, signInApple, firebaseConfigured } = useAuth()
  const [q] = useSearchParams()
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  useTitle('Sign in')
  // only paths on this site: "/x", never "//host" or "/\\host" (both leave the site)
  const rawNext = q.get('next') || ''
  const next = /^\/(?![/\\])[^\s]*$/.test(rawNext) ? rawNext : '/account'
  if (!loading && user) return <Navigate to={next} replace />
  const apple = (
    <button
      type="button"
      className="btn btn--block btn--apple"
      disabled={Boolean(busy) || loading}
      onClick={async () => {
        setBusy('apple')
        setErr(null)
        try {
          await signInApple()
        } catch (e) {
          setErr(e)
        } finally {
          setBusy(false)
        }
      }}
    >
      {appleDevice() && (
        <span className="btn--apple__logo" aria-hidden="true">
          {'\uF8FF'}
        </span>
      )}
      {busy === 'apple' ? 'Opening Apple' : 'Continue with Apple'}
    </button>
  )
  return (
    <div className="container page login">
      <div className="login__card">
        <Logo height={44} className="logo--login" />
        <h1 className="login__title">Sign in</h1>
        <p className="muted">Your picks page, passes and model reads live on your account. Browsing props never needs one.</p>
        {!firebaseConfigured ? (
          <p className="form-err">Sign-in isn't set up on this site yet: the Firebase web config is missing (VITE_FIREBASE_* in frontend/.env).</p>
        ) : (
          <div className="login__ways">
            {appleSignInAvailable() && isNative() && apple}
            <button
              type="button"
              className="btn btn--lime btn--block btn--google"
              disabled={Boolean(busy) || loading}
              onClick={async () => {
                setBusy('google')
                setErr(null)
                try {
                  await signInGoogle()
                } catch (e) {
                  setErr(e)
                } finally {
                  setBusy(false)
                }
              }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 01-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3zM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0012 22zM6.4 14a6 6 0 010-3.9V7.5H3.1a10 10 0 000 9zM12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 003.1 7.5L6.4 10C7.2 7.8 9.4 6 12 6z" />
              </svg>
              {busy === 'google' ? 'Opening Google' : 'Continue with Google'}
            </button>
            {appleSignInAvailable() && !isNative() && apple}
          </div>
        )}
        {err && (
          <p className="form-err" role="alert">
            {signInError(err)}
          </p>
        )}
        <p className="small muted">
          <Link to="/" className="link">
            Back to props
          </Link>
        </p>
      </div>
    </div>
  )
}

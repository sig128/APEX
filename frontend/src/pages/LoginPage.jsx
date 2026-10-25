import { useState } from 'react'
import { Navigate, useSearchParams, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useTitle } from '../lib/hooks.js'
import { Wordmark } from '../ui/Shell.jsx'

/** Sign in with Google. Stats don't need an account; picks pages, passes and the AI do. */
export function LoginPage() {
  const { user, loading, signInGoogle, firebaseConfigured } = useAuth()
  const [q] = useSearchParams()
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  useTitle('Sign in')
  // only paths on this site: "/x", never "//host" or "/\\host" (both leave the site)
  const rawNext = q.get('next') || ''
  const next = /^\/(?![/\\])[^\s]*$/.test(rawNext) ? rawNext : '/account'
  if (!loading && user) return <Navigate to={next} replace />
  return (
    <div className="container page login">
      <div className="login__card">
        <Wordmark height={28} />
        <h1 className="login__title">Sign in</h1>
        <p className="muted">Your picks page, passes and AI reads live on your account. Browsing props never needs one.</p>
        {!firebaseConfigured ? (
          <p className="form-err">Sign-in isn't set up on this site yet: the Firebase web config is missing (VITE_FIREBASE_* in frontend/.env).</p>
        ) : (
          <button
            type="button"
            className="btn btn--gold btn--block btn--google"
            disabled={busy || loading}
            onClick={async () => {
              setBusy(true)
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
            {busy ? 'Opening Google' : 'Continue with Google'}
          </button>
        )}
        {err && (
          <p className="form-err" role="alert">
            {err.message}
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

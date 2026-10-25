import { useState, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { InviteCodeStep } from './InviteCodeStep.jsx'
import { AdminLoginCorner } from './AdminLoginCorner.jsx'
import mlbHero from '../assets/mlb.jpg'
import './LoginPage.css'
import { formatUserFacingError } from '../apex/humanReadableError.js'

function LoginHero() {
  return (
    <header className="login-hero" aria-label="APEX">
      <div className="login-hero-media" aria-hidden="true">
        <img className="login-hero-img" src={mlbHero} alt="" decoding="async" />
      </div>
      <div className="login-hero-content">
        <h1 className="login-hero-title">APEX</h1>
        <p className="login-hero-sub">Pre-game edges. Props. Parlays.</p>
      </div>
      <span className="login-beta-badge" aria-label="APEX version 3.2">
        v3.2
      </span>
    </header>
  )
}

function LoginPanel({ children }) {
  return <section className="login-panel">{children}</section>
}

function ContinueWithEmailSoon() {
  const [showTip, setShowTip] = useState(false)
  const hideTimerRef = useRef(0)

  function revealTip() {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    setShowTip(true)
    hideTimerRef.current = window.setTimeout(() => {
      setShowTip(false)
      hideTimerRef.current = 0
    }, 2200)
  }

  return (
    <div
      className={`login-soon-wrap${showTip ? ' login-soon-wrap--show' : ''}`}
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => {
        if (hideTimerRef.current) return
        setShowTip(false)
      }}
    >
      <button
        type="button"
        className="login-auth-btn login-email"
        aria-describedby="login-email-soon-tip"
        onClick={(e) => {
          e.preventDefault()
          revealTip()
        }}
      >
        Continue with email
      </button>
      <span
        id="login-email-soon-tip"
        className="login-soon-tooltip"
        role="tooltip"
      >
        Coming soon
      </span>
    </div>
  )
}

export function LoginPage() {
  const {
    user,
    loading,
    firebaseConfigured,
    signInGoogle,
    inviteLoading,
    hasInviteAccess,
    adminDevSession,
  } = useAuth()
  const [err, setErr] = useState(null)

  if (loading && !adminDevSession) {
    return (
      <div className="login-page">
        <AdminLoginCorner />
        <LoginHero />
        <LoginPanel>
          <p className="login-status">Loading…</p>
        </LoginPanel>
      </div>
    )
  }

  if (hasInviteAccess) {
    return <Navigate to="/apex" replace />
  }

  if (user && inviteLoading) {
    return (
      <div className="login-page">
        <AdminLoginCorner />
        <LoginHero />
        <LoginPanel>
          <p className="login-status">Verifying access…</p>
        </LoginPanel>
      </div>
    )
  }

  async function onGoogle() {
    setErr(null)
    try {
      await signInGoogle()
    } catch (e) {
      setErr(formatUserFacingError(e))
    }
  }

  return (
    <div className="login-page">
      <AdminLoginCorner />
      <LoginHero />
      <LoginPanel>
        {user ? (
          <InviteCodeStep />
        ) : (
          <div className="login-card">
            {!firebaseConfigured && (
              <p className="login-warn">
                Firebase is not configured. Add <code>VITE_FIREBASE_*</code> keys from your Firebase
                project to <code>frontend/.env</code> (see <code>frontend/.env.example</code>).
              </p>
            )}
            {err && <p className="login-err">{err}</p>}
            <div className="login-auth-actions">
              <button
                type="button"
                className="login-auth-btn login-google"
                onClick={onGoogle}
                disabled={!firebaseConfigured}
              >
                <span className="login-google-icon" aria-hidden="true" />
                Continue with Google
              </button>
              <ContinueWithEmailSoon />
            </div>
          </div>
        )}
      </LoginPanel>
    </div>
  )
}

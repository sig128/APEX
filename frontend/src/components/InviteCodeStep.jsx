import { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import './InviteCodeStep.css'

function mapInviteError(err) {
  const code = err?.code ?? ''
  const msg = err?.message ?? ''
  if (code === 'functions/not-found' || msg.includes('not valid')) {
    return 'That invite code is not valid.'
  }
  if (code === 'functions/failed-precondition') {
    return 'This invite code is no longer active.'
  }
  if (code === 'functions/resource-exhausted') {
    return 'This invite code has no uses left.'
  }
  if (code === 'functions/invalid-argument') {
    return 'Enter a valid invite code.'
  }
  if (code === 'functions/unauthenticated') {
    return 'Sign in with Google first.'
  }
  return msg || 'Something went wrong. Try again.'
}

export function InviteCodeStep() {
  const { redeemInviteCode, signOutUser } = useAuth()
  const [code, setCode] = useState('')
  const [err, setErr] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    setErr(null)
    const trimmed = code.trim()
    if (!trimmed) {
      setErr('Enter your invite code.')
      return
    }
    setSubmitting(true)
    try {
      await redeemInviteCode(trimmed)
    } catch (error) {
      setErr(mapInviteError(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="invite-step" aria-labelledby="invite-heading">
      <h2 id="invite-heading" className="invite-step-title">
        Invite code
      </h2>
      <p className="invite-step-hint">Enter your beta invite code to continue.</p>
      <form className="invite-step-form" onSubmit={onSubmit}>
        <label className="invite-step-label" htmlFor="invite-code-input">
          Code
        </label>
        <input
          id="invite-code-input"
          className="invite-step-input"
          type="text"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          placeholder="APEX-••••••••"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={submitting}
        />
        {err && <p className="invite-step-err">{err}</p>}
        <button type="submit" className="invite-step-submit" disabled={submitting}>
          {submitting ? 'Checking…' : 'Continue'}
        </button>
      </form>
      <button type="button" className="invite-step-back" onClick={() => signOutUser()} disabled={submitting}>
        Sign out
      </button>
    </section>
  )
}

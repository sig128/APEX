import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Dialog } from './Dialog.jsx'
import { api } from '../lib/api.js'
import { APP_VERSION } from '../lib/consent.js'
import { useAuth } from '../context/AuthContext.jsx'

const KINDS = [
  { key: 'bug', label: 'Something’s broken' },
  { key: 'feature', label: 'An idea' },
  { key: 'pick', label: 'A pick or a number' },
  { key: 'general', label: 'Anything else' },
]

/** Open the feedback form from anywhere: openFeedback({ kind: 'pick', about: 'nfl:123...' }). */
export function openFeedback(detail = {}) {
  window.dispatchEvent(new CustomEvent('apex:feedback', { detail }))
}

/**
 * The feedback form. It goes to the PropPickz team (kept on the server and emailed to the
 * team's inbox); the visitor's account goes with it only when they tick the box.
 */
export function FeedbackDialog() {
  const loc = useLocation()
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [about, setAbout] = useState(null)
  const [kind, setKind] = useState('general')
  const [message, setMessage] = useState('')
  const [rating, setRating] = useState(null)
  const [include, setInclude] = useState(false)
  const [trap, setTrap] = useState('')
  const [state, setState] = useState({ busy: false, err: null, sent: false })

  useEffect(() => {
    const on = (e) => {
      setKind(e.detail?.kind || 'general')
      setAbout(e.detail?.about || null)
      setMessage('')
      setRating(null)
      setState({ busy: false, err: null, sent: false })
      setOpen(true)
    }
    window.addEventListener('apex:feedback', on)
    return () => window.removeEventListener('apex:feedback', on)
  }, [])

  const send = async (e) => {
    e.preventDefault()
    setState({ busy: true, err: null, sent: false })
    try {
      await api('/api/members/feedback', { method: 'POST', body: { kind, message, rating, about, include: Boolean(user && include), page: loc.pathname + loc.search, app: APP_VERSION, website: trap } })
      setState({ busy: false, err: null, sent: true })
    } catch (err) {
      setState({ busy: false, err: err.message, sent: false })
    }
  }

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Feedback">
      {state.sent ? (
        <div className="fb fb--sent">
          <p className="fb__thanks">Thanks. Your note is with the PropPickz team.</p>
          <button type="button" className="btn btn--lime" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : (
        <form className="fb" onSubmit={send}>
          <p className="muted fb__intro">Tell us what to fix or build. It goes straight to the team.</p>
          <fieldset className="fb__kinds">
            <legend className="sr-only">What it’s about</legend>
            {KINDS.map((k) => (
              <label key={k.key} className={`fb__kind${kind === k.key ? ' is-on' : ''}`}>
                <input type="radio" name="fb-kind" value={k.key} checked={kind === k.key} onChange={() => setKind(k.key)} />
                {k.label}
              </label>
            ))}
          </fieldset>
          <label className="fb__field">
            <span>Your note</span>
            <textarea id="fb-message" rows={5} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={kind === 'bug' ? 'What happened, and what did you expect?' : kind === 'pick' ? 'Which pick or number, and what looked off?' : 'Your idea or question'} required />
          </label>
          <div className="fb__rating" role="group" aria-label="How’s PropPickz so far (optional)">
            <span className="muted">How’s PropPickz so far?</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className={`fb__star${rating && n <= rating ? ' is-on' : ''}`} aria-pressed={rating === n} aria-label={`${n} of 5`} onClick={() => setRating(rating === n ? null : n)}>
                ★
              </button>
            ))}
          </div>
          {/* only a script fills this in */}
          <label className="fb__trap" aria-hidden="true">
            Website
            <input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
          </label>
          {user && (
            <label className="fb__check">
              <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
              Include my account ({user.email}) so you can reply
            </label>
          )}
          <p className="fb__fine">We keep your note, the page you’re on and your device type to look into it. See the <a href="/privacy">Privacy Policy</a>.</p>
          {state.err && <p className="form-err">{state.err}</p>}
          <button type="submit" className="btn btn--lime" disabled={state.busy || message.trim().length < 3}>
            {state.busy ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
    </Dialog>
  )
}

/** "Was this helpful?" under a pick: one tap, and an offer to say more. */
export function Helpful({ about, label = 'Was this pick helpful?' }) {
  const [said, setSaid] = useState(null)
  const tap = (helpful) => {
    setSaid(helpful)
    api('/api/members/feedback', { method: 'POST', body: { kind: 'pick', helpful, about, page: window.location.pathname, app: APP_VERSION } }).catch(() => {})
  }
  return (
    <div className="helpful" role="group" aria-label={label}>
      {said === null ? (
        <>
          <span className="muted">{label}</span>
          <button type="button" className="helpful__btn" aria-label="Yes, helpful" onClick={() => tap(true)}>
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path d="M6 9l3-6c1.2 0 2 .8 2 2v3h4.2c.9 0 1.6.8 1.4 1.7l-1.2 5.6c-.1.7-.7 1.2-1.4 1.2H6zM3 9h3v8.5H3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="helpful__btn" aria-label="No, not helpful" onClick={() => tap(false)}>
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" style={{ transform: 'rotate(180deg)' }}>
              <path d="M6 9l3-6c1.2 0 2 .8 2 2v3h4.2c.9 0 1.6.8 1.4 1.7l-1.2 5.6c-.1.7-.7 1.2-1.4 1.2H6zM3 9h3v8.5H3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
        </>
      ) : (
        <span className="muted">
          Thanks.{' '}
          <button type="button" className="linkish" onClick={() => openFeedback({ kind: 'pick', about })}>
            {said ? 'Tell us what worked' : 'Tell us what was off'}
          </button>
        </span>
      )}
    </div>
  )
}

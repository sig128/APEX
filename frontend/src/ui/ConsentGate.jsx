import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Logo } from '../brand/Logo.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { hasConsented, giveConsent, sendConsent } from '../lib/consent.js'

/** The statements, kept in one place so the Terms page can repeat them word for word. */
export const CONSENT_POINTS = [
  'I’m of legal age to bet where I live (21+ in most US states, 19+ in Ontario).',
  'I’m not under the influence of alcohol, drugs or anything else, and I’m making my own decisions.',
  'Picks, projections and analysis are information only. Sports are uncertain, and no result is guaranteed.',
  'PropPickz isn’t a sportsbook. I’m responsible for every bet I place, and PropPickz isn’t liable for any bet won or lost.',
  'Past results don’t guarantee future ones.',
  'I know where to get help (1-800-MY-RESET in the US, ConnexOntario at 1-866-531-2600 in Ontario), and that I can set limits or take a break in my account at any time.',
]
// the Terms and Privacy pages stay readable before agreeing
const OPEN_PATHS = new Set(['/terms', '/privacy'])

/**
 * The first screen anyone sees: the consent statements, one box to tick, and nothing else
 * works until it's ticked. Asked again whenever the text's version changes.
 */
export function ConsentGate({ onAccepted }) {
  const loc = useLocation()
  const { user } = useAuth()
  const [ok, setOk] = useState(hasConsented)
  const [tick, setTick] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef(null)
  const open = !ok && !OPEN_PATHS.has(loc.pathname)

  // signed in after agreeing: the acceptance is tied to the account too (once per account)
  useEffect(() => {
    if (!ok || !user?.uid) return
    const k = `apex_consent_linked_${user.uid}`
    try {
      if (sessionStorage.getItem(k)) return
      sessionStorage.setItem(k, '1')
    } catch {
      /* blocked */
    }
    sendConsent()
  }, [ok, user?.uid])

  // while it's up, the page behind can't be reached by keyboard or screen reader
  useEffect(() => {
    if (!open) return undefined
    const behind = [...document.querySelectorAll('.app > *:not(.consent)')]
    behind.forEach((el) => el.setAttribute('inert', ''))
    document.documentElement.classList.add('is-consenting')
    box.current?.focus()
    return () => {
      behind.forEach((el) => el.removeAttribute('inert'))
      document.documentElement.classList.remove('is-consenting')
    }
  }, [open])

  if (!open) return null
  const accept = async () => {
    setBusy(true)
    await giveConsent()
    setOk(true)
    onAccepted?.()
  }
  return (
    <div className="consent" role="dialog" aria-modal="true" aria-labelledby="consent-h" aria-describedby="consent-d">
      <div className="consent__card">
        <Logo height={30} className="consent__logo" />
        <h2 id="consent-h" className="consent__title">
          Before you start
        </h2>
        <p id="consent-d" className="consent__lead">
          By continuing, I confirm that:
        </p>
        <ul className="consent__list">
          {CONSENT_POINTS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <label className="consent__agree">
          <input ref={box} type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} />
          <span>
            I agree to all of the above, the{' '}
            <Link to="/terms" target="_blank" rel="noopener">
              Terms of Service
            </Link>{' '}
            and the{' '}
            <Link to="/privacy" target="_blank" rel="noopener">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        <button type="button" className="btn btn--lime consent__go" disabled={!tick || busy} onClick={accept}>
          {busy ? 'One moment…' : 'Agree and continue'}
        </button>
        <p className="consent__fine">If you don’t agree, close this page. You can review these terms any time from the bottom of every page.</p>
      </div>
    </div>
  )
}

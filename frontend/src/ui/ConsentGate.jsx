import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Logo } from '../brand/Logo.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { hasConsented, giveConsent, sendConsent } from '../lib/consent.js'

/** The statements, kept in one place so the Consent and Terms pages say them word for word. */
export const CONSENT_POINTS = [
  { title: 'Legal age', text: 'I’m of legal age to bet where I live (21+ in most US states, 19+ in Ontario).' },
  { title: 'A clear head', text: 'I’m not under the influence of alcohol, drugs or anything else, and I’m making my own decisions.' },
  { title: 'Information, not advice', text: 'Picks, projections and analysis are information only. Sports are uncertain, and no result is guaranteed.' },
  { title: 'My bets are mine', text: 'PropPickz isn’t a sportsbook. I’m responsible for every bet I place, and PropPickz isn’t liable for any bet won or lost.' },
  { title: 'The past is not a promise', text: 'Past results don’t guarantee future ones.' },
  { title: 'My data', text: 'PropPickz collects and uses my data to run the site, keep my account and picks, and keep the service safe, as described on the Consent page and in the Privacy Policy.' },
  { title: 'Help is there', text: 'I know where to get help (1-800-MY-RESET in the US, ConnexOntario at 1-866-531-2600 in Ontario), and that I can set limits or take a break in my account at any time.' },
]
// the consent, Terms and Privacy pages stay readable before agreeing
const OPEN_PATHS = new Set(['/consent', '/terms', '/privacy'])

/**
 * The first thing on every visit: one box to tick, and nothing else works until it's ticked.
 * The statements themselves live on the Consent page (linked here and from every page's footer).
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
  const accept = () => {
    setBusy(true)
    // recorded in the background: entering never waits on the network
    giveConsent()
    // the intro (when it plays) covers the screen before this one goes, so the site never flashes between them
    onAccepted?.()
    setOk(true)
  }
  return (
    <div className="consent" role="dialog" aria-modal="true" aria-labelledby="consent-h">
      <div className="consent__card">
        <Logo height={28} className="consent__logo" />
        <h2 id="consent-h" className="consent__title">
          Welcome
        </h2>
        <label className="consent__agree">
          <input ref={box} type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} />
          <span>
            I’m of legal betting age where I live, I’m not under the influence, and I agree to the{' '}
            <Link to="/consent" target="_blank" rel="noopener">
              consent terms
            </Link>
            ,{' '}
            <Link to="/terms" target="_blank" rel="noopener">
              Terms
            </Link>{' '}
            and{' '}
            <Link to="/privacy" target="_blank" rel="noopener">
              Privacy Policy
            </Link>
            , including how PropPickz uses my data.
          </span>
        </label>
        <button type="button" className="btn btn--lime consent__go" disabled={!tick || busy} onClick={accept}>
          {busy ? 'One moment…' : 'Enter PropPickz'}
        </button>
      </div>
    </div>
  )
}

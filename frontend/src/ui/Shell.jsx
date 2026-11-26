import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { SPORTS, sportInfo, useSport, apiOf, sp, isSharedPath, setLeague, leagueSwitchPath } from '../lib/sport.js'
import { Logo } from '../brand/Logo.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { useSlip } from '../lib/useSlip.js'
import { useApi } from '../lib/useApi.js'
import { Search } from './Search.jsx'
import { SlipPanel } from './SlipPanel.jsx'
import { backFromBook, clearAway } from './Books.jsx'
import { ConsentGate } from './ConsentGate.jsx'
import { Tour, replayTour } from './Tour.jsx'
import { Welcome } from './Welcome.jsx'
import { loadPrefs, usePrefs, setupDue, withSetup, markSetupPending } from '../lib/prefs.js'
import { hasConsented } from '../lib/consent.js'
import { FeedbackDialog, openFeedback } from './Feedback.jsx'
import { getSlip } from '../lib/slip.js'
import { PickNudge } from './PickNudge.jsx'
import { playIntro } from '../intro/intro.js'
import { DAY } from './time.js'
import { Headshot } from './Img.jsx'
import { isNative } from '../lib/native.js'

/**
 * Once a visit per account: the account's setup comes to this device, and a member who hasn't been
 * through the setup (signed up before it existed, or left it on another device) gets it over the
 * page they're on, after the consent screen. Signing in on the sign-in page runs it from there.
 */
function syncSetup(uid, go) {
  const k = `apex_prefs_loaded_${uid}`
  try {
    if (sessionStorage.getItem(k)) return
    sessionStorage.setItem(k, '1')
  } catch {
    /* storage off: once per load */
  }
  let prefs = null
  const open = () => {
    const { pathname, search, hash } = window.location
    if (!prefs || !hasConsented() || !setupDue(prefs, { pathname, search })) return
    prefs = null
    window.removeEventListener('apex:consented', open)
    go(withSetup(`${pathname}${search}${hash}`))
  }
  window.addEventListener('apex:consented', open)
  const load = (tries) =>
    loadPrefs().then((p) => {
      if (!p) {
        // the server didn't answer (a deploy under way, a bad connection): try again shortly, and
        // if it still can't say, the next visit asks again
        if (tries > 0) return setTimeout(() => load(tries - 1), 4000)
        try {
          sessionStorage.removeItem(k)
        } catch {
          /* storage off */
        }
        return window.removeEventListener('apex:consented', open)
      }
      if (p.onboarded) return window.removeEventListener('apex:consented', open)
      prefs = p
      markSetupPending(true)
      open()
    })
  load(3)
}

/** The PropPickz lockup at a given mark height (kept under this name for older imports). */
export function Wordmark({ height = 28 }) {
  return <Logo height={height} />
}

/** The main links for the league on screen (Picks and Tools are the same everywhere). */
const navFor = (sport) => [
  { to: sp(sport, ''), label: 'Today', end: true },
  { to: sp(sport, '/lock'), label: 'Lock' },
  { to: sp(sport, '/props'), label: 'Props' },
  { to: sp(sport, '/live'), label: 'Live', live: true },
  { to: '/picks', label: 'Picks' },
  { to: '/tools', label: 'Tools' },
]

/** The league switcher: the chip next to the wordmark. */
function SportPicker() {
  const sport = useSport()
  const nav = useNavigate()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  // which leagues this site runs, and which are between seasons
  const meta = useApi('/api/sports', { maxAgeMs: 10 * 60_000 }).data
  const month = new Date().getMonth() + 1
  const on = meta?.sports ? new Map(meta.sports.map((x) => [x.key, x])) : null
  // the member's leagues first, in their order (their setup), then the rest
  const favs = usePrefs().leagues
  const rank = (k) => (favs.includes(k) ? favs.indexOf(k) : favs.length + SPORTS.findIndex((s) => s.key === k))
  const list = SPORTS.filter((s) => !on || on.has(s.key) || s.key === sport).sort((a, b) => rank(a.key) - rank(b.key))
  // on a league's pages, go to the same section of the other league; on the tools and picks
  // pages, stay put and switch the league they work on
  const choose = (key) => {
    setOpen(false)
    if (isSharedPath(pathname)) setLeague(key)
    else nav(leagueSwitchPath(pathname, key))
  }
  useEffect(() => {
    if (!open) return undefined
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return
      if (e.type === 'pointerdown' && e.target.closest?.('.league')) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  useEffect(() => setOpen(false), [pathname])
  return (
    <div className="league">
      <button type="button" className="league__btn" aria-expanded={open} aria-controls="league-menu" aria-label={`League: ${sportInfo(sport).title}. Change league`} onClick={() => setOpen((o) => !o)}>
        <span className="brand__chip" data-apex-chip>
          {sportInfo(sport).name}
        </span>
        <svg className="league__caret" viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="league__menu" id="league-menu">
          {list.map((s, k) => {
            const off = on?.get(s.key)?.offseason?.includes(month)
            // a line under the member's own leagues
            const lastFav = favs.length > 0 && k === favs.filter((f) => list.some((x) => x.key === f)).length - 1 && k < list.length - 1
            return (
              <li key={s.key} className={lastFav ? 'league__fav-end' : undefined}>
                <button type="button" aria-current={s.key === sport ? 'true' : undefined} className={`league__item${s.key === sport ? ' is-on' : ''}`} onClick={() => choose(s.key)}>
                  <b>{s.name}</b>
                  <span>{s.title !== s.name ? s.title : ''}</span>
                  {off && <em className="league__off">Off-season</em>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function Shell({ children }) {
  // back from a sportsbook the slip opened, even if the phone reloaded the page meanwhile: the slip
  // is open again, where you left it
  const [slipOpen, setSlipOpen] = useState(() => backFromBook() && getSlip().legs.length > 0)
  const [searchOpen, setSearchOpen] = useState(false)
  const loc = useLocation()
  const slip = useSlip()
  const { user } = useAuth()

  // signed in: the account's setup comes to this device once a visit (the app, a new browser), and
  // someone who hasn't been through it yet gets it then
  const nav = useNavigate()
  const go = useRef(nav)
  go.current = nav
  useEffect(() => {
    if (user?.uid) syncSetup(user.uid, (to) => go.current(to, { replace: true }))
  }, [user?.uid])

  useEffect(() => {
    setSearchOpen(false)
    window.scrollTo({ top: 0 })
  }, [loc.pathname])

  useEffect(() => {
    const open = () => setSlipOpen(true)
    window.addEventListener('apex:open-slip', open)
    return () => window.removeEventListener('apex:open-slip', open)
  }, [])

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header onSlip={() => setSlipOpen((o) => !o)} slipCount={slip.legs.length} onSearch={() => setSearchOpen((s) => !s)} />
      {searchOpen && (
        <div className="search-sheet">
          <Search autoFocus onDone={() => setSearchOpen(false)} />
        </div>
      )}
      <RenewBanner />
      <main id="main" className="main">
        {children}
      </main>
      <Footer />
      <TabBar slipCount={slip.legs.length} onSlip={() => setSlipOpen(true)} />
      <ConsentGate onAccepted={() => window.dispatchEvent(new Event('apex:consented'))} />
      <Welcome />
      <Tour />
      <FeedbackDialog />
      <SlipPanel
        open={slipOpen}
        onClose={() => {
          setSlipOpen(false)
          clearAway()
        }}
      />
      {!slipOpen && <PickNudge />}
    </div>
  )
}

function Header({ onSlip, slipCount, onSearch }) {
  const { user } = useAuth()
  const { plan, paywall, isAdmin } = useBilling()
  const sport = useSport()
  const week = useApi(`${apiOf(sport)}/week`, { maxAgeMs: 60_000 }).data
  const liveCount = (week?.games || []).filter((g) => g.status?.state === 'in').length
  return (
    <header className="header">
      <div className="header__inner">
        <div className="brand">
          <Link to={sp(sport, '')} className="brand__home" aria-label="PropPickz home">
            <Logo height={30} className="logo--header" />
          </Link>
          <SportPicker />
        </div>
        <nav className="header__nav" aria-label="Main">
          {navFor(sport).map((n) => (
            <NavLink key={n.label} to={n.to} end={n.end} data-tour={n.label === 'Picks' ? 'picks' : n.label === 'Live' ? 'live' : undefined} className={({ isActive }) => `header__link${isActive ? ' is-on' : ''}`}>
              {n.label}
              {n.live && liveCount > 0 && <span className="header__count num">{liveCount}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="header__tools">
          <div className="header__search">
            <Search />
          </div>
          <button type="button" className="icon-btn header__search-btn" onClick={onSearch} aria-label="Search players">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M13.2 13.2L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button type="button" className="slip-btn" data-tour="slip" onClick={onSlip} aria-label={`Bet slip, ${slipCount} legs`}>
            Slip
            <span className={`slip-btn__n num${slipCount ? ' is-on' : ''}`}>{slipCount}</span>
          </button>
          {user ? (
            <Link to="/account" className="avatar-btn" aria-label="Your account">
              <Headshot src={user.photoURL} name={user.displayName || user.email} size={34} />
              {paywall && plan !== 'free' && <span className={`avatar-btn__plan is-${plan}`}>{plan === 'elite' ? 'E' : 'P'}</span>}
              {isAdmin && <span className="sr-only">admin</span>}
            </Link>
          ) : (
            <Link to="/login" className="btn btn--quiet btn--s">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}

function TabBar({ slipCount, onSlip }) {
  const sport = useSport()
  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink to={sp(sport, '')} end className={({ isActive }) => `tabbar__item${isActive ? ' is-on' : ''}`}>
        <Icon d="M3 10.5L10 4l7 6.5V17h-4.5v-4h-5v4H3z" />
        Today
      </NavLink>
      <NavLink to={sp(sport, '/props')} className={({ isActive }) => `tabbar__item${isActive ? ' is-on' : ''}`}>
        <Icon d="M4 5h12M4 10h12M4 15h7" />
        Props
      </NavLink>
      <NavLink to={sp(sport, '/live')} data-tour="live" className={({ isActive }) => `tabbar__item${isActive ? ' is-on' : ''}`}>
        <Icon d="M10 3v7l4 3M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
        Live
      </NavLink>
      <button type="button" className="tabbar__item" data-tour="slip" onClick={onSlip}>
        <Icon d="M5 3h10v14l-2.5-1.6L10 17l-2.5-1.6L5 17zM7.5 7h5M7.5 10h5" />
        Slip
        {slipCount > 0 && <span className="tabbar__badge num">{slipCount}</span>}
      </button>
      <NavLink to="/picks" data-tour="picks" className={({ isActive }) => `tabbar__item${isActive ? ' is-on' : ''}`}>
        <Icon d="M10 3l2.2 4.6 5 .7-3.6 3.5.9 5L10 14.4 5.5 16.8l.9-5L2.8 8.3l5-.7z" />
        Picks
      </NavLink>
    </nav>
  )
}

function Icon({ d }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RenewBanner() {
  const { ent, paywall } = useBilling()
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem('apex_renew_hidden') === '1'
    } catch {
      return false
    }
  })
  if (!paywall || hidden) return null
  const plan = ent?.paidPlan === 'elite' ? 'Elite' : 'Pro'
  let text = null
  if (ent?.status === 'grace') text = `Your ${plan} pass ran out. You keep it for ${ent.daysLeft} more ${ent.daysLeft === 1 ? 'day' : 'days'}, then model reads and ${ent.paidPlan === 'elite' ? 'your showcase' : 'Kelly tools'} lock.`
  else if (ent?.status === 'active' && ent.daysLeft != null && ent.daysLeft <= 3) text = `Your ${plan} pass ends in ${ent.daysLeft} ${ent.daysLeft === 1 ? 'day' : 'days'}.`
  else if (ent?.status === 'expired' && ent.paidPlan && Date.now() - (ent.graceUntil || 0) < 14 * DAY) text = `Your ${plan} pass has ended. Stats stay free; model reads are locked.`
  if (!text) return null
  return (
    <div className={`renew renew--${ent.status}`} role="status">
      <p>{text}</p>
      <Link to={`/account?buy=${ent.paidPlan || 'pro'}`} className="btn btn--lime btn--s">
        Renew {plan}
      </Link>
      <button
        type="button"
        className="icon-btn"
        aria-label="Hide"
        onClick={() => {
          setHidden(true)
          try {
            sessionStorage.setItem('apex_renew_hidden', '1')
          } catch {
            /* ignore */
          }
        }}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

function Footer() {
  const { isAdmin } = useBilling()
  const sport = useSport()
  return (
    <footer className="footer">
      <div className="footer__inner">
        <Logo height={24} className="logo--footer" />
        <p className="footer__note">
          Stats and probabilities for research. PropPickz doesn't take bets. Bet within your means; if gambling stops being fun, call <a href="tel:18006973738">1-800-MY-RESET</a> (US) or ConnexOntario at{' '}
          <a href="tel:18665312600">1-866-531-2600</a> (Ontario).
        </p>
        <nav className="footer__links" aria-label="More">
          <Link to="/pricing">Plans</Link>
          {!isNative() && <Link to="/contests">Weekly contest</Link>}
          <Link to={sp(sport, '/dvp')}>Defense vs position</Link>
          <Link to="/apex">Game analyzer</Link>
          <Link to="/calibration">Calibration</Link>
          <Link to="/learn">Tips &amp; Tricks</Link>
          <Link to="/consent">Consent</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/support">Support</Link>
          {isAdmin && !isNative() && <Link to="/admin">Admin</Link>}
          <button type="button" className="linkish" onClick={() => playIntro({ force: true, chipText: sportInfo(sport).name })}>
            Replay intro
          </button>
          <button type="button" className="linkish" onClick={replayTour}>
            Take the tour
          </button>
          <button type="button" className="linkish" onClick={() => openFeedback()}>
            Feedback
          </button>
        </nav>
      </div>
    </footer>
  )
}

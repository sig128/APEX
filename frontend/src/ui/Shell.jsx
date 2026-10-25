import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { WORDMARK } from '../brand/wordmark.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { useSlip } from '../lib/useSlip.js'
import { useApi } from '../lib/useApi.js'
import { Search } from './Search.jsx'
import { SlipPanel } from './SlipPanel.jsx'
import { playIntro } from '../intro/intro.js'
import { DAY } from './time.js'
import { Headshot } from './Img.jsx'

export function Wordmark({ height = 20 }) {
  return (
    <svg data-apex-logo className="wordmark" viewBox={`0 0 ${WORDMARK.w} ${WORDMARK.h}`} height={height} width={(height * WORDMARK.w) / WORDMARK.h} role="img" aria-label="APEX">
      <path fillRule="evenodd" d={WORDMARK.d} fill="currentColor" />
    </svg>
  )
}

const NAV = [
  { to: '/', label: 'Today', end: true },
  { to: '/nfl/props', label: 'Props' },
  { to: '/nfl/live', label: 'Live' },
  { to: '/picks', label: 'Picks' },
  { to: '/kelly', label: 'Kelly' },
]

export function Shell({ children }) {
  const [slipOpen, setSlipOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const loc = useLocation()
  const slip = useSlip()

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
      <SlipPanel open={slipOpen} onClose={() => setSlipOpen(false)} />
    </div>
  )
}

function Header({ onSlip, slipCount, onSearch }) {
  const { user } = useAuth()
  const { plan, paywall, isAdmin } = useBilling()
  const week = useApi('/api/nfl/week', { maxAgeMs: 60_000 }).data
  const liveCount = (week?.games || []).filter((g) => g.status?.state === 'in').length
  return (
    <header className="header">
      <div className="header__inner">
        <Link to="/" className="brand" aria-label="APEX home">
          <Wordmark height={20} />
          <span className="brand__chip" data-apex-chip>
            NFL
          </span>
        </Link>
        <nav className="header__nav" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `header__link${isActive ? ' is-on' : ''}`}>
              {n.label}
              {n.to === '/nfl/live' && liveCount > 0 && <span className="header__count num">{liveCount}</span>}
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
          <button type="button" className="slip-btn" onClick={onSlip} aria-label={`Bet slip, ${slipCount} legs`}>
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
  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink to="/" end className={({ isActive }) => `tabbar__item${isActive ? ' is-on' : ''}`}>
        <Icon d="M3 10.5L10 4l7 6.5V17h-4.5v-4h-5v4H3z" />
        Today
      </NavLink>
      <NavLink to="/nfl/props" className={({ isActive }) => `tabbar__item${isActive ? ' is-on' : ''}`}>
        <Icon d="M4 5h12M4 10h12M4 15h7" />
        Props
      </NavLink>
      <NavLink to="/nfl/live" className={({ isActive }) => `tabbar__item${isActive ? ' is-on' : ''}`}>
        <Icon d="M10 3v7l4 3M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
        Live
      </NavLink>
      <button type="button" className="tabbar__item" onClick={onSlip}>
        <Icon d="M5 3h10v14l-2.5-1.6L10 17l-2.5-1.6L5 17zM7.5 7h5M7.5 10h5" />
        Slip
        {slipCount > 0 && <span className="tabbar__badge num">{slipCount}</span>}
      </button>
      <NavLink to="/picks" className={({ isActive }) => `tabbar__item${isActive ? ' is-on' : ''}`}>
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
  if (ent?.status === 'grace') text = `Your ${plan} pass ran out. You keep it for ${ent.daysLeft} more ${ent.daysLeft === 1 ? 'day' : 'days'}, then AI picks and ${ent.paidPlan === 'elite' ? 'your showcase' : 'Kelly tools'} lock.`
  else if (ent?.status === 'active' && ent.daysLeft != null && ent.daysLeft <= 3) text = `Your ${plan} pass ends in ${ent.daysLeft} ${ent.daysLeft === 1 ? 'day' : 'days'}.`
  else if (ent?.status === 'expired' && ent.paidPlan && Date.now() - (ent.graceUntil || 0) < 14 * DAY) text = `Your ${plan} pass has ended. Stats stay free; AI picks are locked.`
  if (!text) return null
  return (
    <div className={`renew renew--${ent.status}`} role="status">
      <p>{text}</p>
      <Link to={`/account?buy=${ent.paidPlan || 'pro'}`} className="btn btn--gold btn--s">
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
  return (
    <footer className="footer">
      <div className="footer__inner">
        <Wordmark height={14} />
        <p className="footer__note">Stats and probabilities for research. APEX doesn't take bets. Bet within your means; if gambling stops being fun, call 1-800-GAMBLER.</p>
        <nav className="footer__links" aria-label="More">
          <Link to="/pricing">Plans</Link>
          <Link to="/nfl/dvp">Defense vs position</Link>
          <Link to="/apex">Game analyzer</Link>
          {isAdmin && <Link to="/admin">Admin</Link>}
          <button type="button" className="linkish" onClick={() => playIntro({ force: true })}>
            Replay intro
          </button>
        </nav>
      </div>
    </footer>
  )
}

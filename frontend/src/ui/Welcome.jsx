import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { useApi } from '../lib/useApi.js'
import { api } from '../lib/api.js'
import { SPORTS, isSport, sp, setLeague } from '../lib/sport.js'
import { readPrefs, savePrefs, withSetup } from '../lib/prefs.js'
import { US_STATES, CA_PROVINCES, flagOf } from '../lib/regions.js'
import { bookName } from '../lib/format.js'
import { pushEnv, enablePush } from '../lib/push.js'
import { isNative, enableNativePush } from '../lib/native.js'
import { BookLogo, FEATURED_BOOKS } from './Books.jsx'
import './Welcome.css'

// The setup right after signing up, in the app and on the website: the leagues you follow, how
// odds read, where you bet, your sportsbooks, the record we keep in public, alerts, and last Pro,
// with the real site showing through behind it. It opens over any page as ?welcome=1 (signing up
// sends you to it; Account runs it again) and each answer is saved as you go (lib/prefs.js).

const KIND = { nfl: 'football', ncaaf: 'football', nba: 'basketball', ncaab: 'basketball', wnba: 'basketball', mlb: 'baseball', nhl: 'hockey' }
const SPORT_WORD = { football: 'Football', basketball: 'Basketball', baseball: 'Baseball', hockey: 'Hockey', soccer: 'Soccer' }
const ICON = {
  football: (
    <>
      <ellipse cx="12" cy="12" rx="9.6" ry="5.6" transform="rotate(-40 12 12)" />
      <path d="M9 15l6-6M9.7 12.7l1.6 1.6M11.2 11.2l1.6 1.6M12.7 9.7l1.6 1.6" />
    </>
  ),
  basketball: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3v18M5.7 5.6c3.3 3.3 3.3 9.5 0 12.8M18.3 5.6c-3.3 3.3-3.3 9.5 0 12.8" />
    </>
  ),
  baseball: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M7.4 4.3c2.3 2.4 2.3 13 0 15.4M16.6 4.3c-2.3 2.4-2.3 13 0 15.4" />
    </>
  ),
  hockey: (
    <>
      <ellipse cx="12" cy="9.5" rx="8" ry="3.2" />
      <path d="M4 9.5v4.6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V9.5" />
    </>
  ),
  soccer: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8.3l3.5 2.5-1.3 4.1H9.8l-1.3-4.1zM12 8.3V3.2M15.5 10.8l4.8-1.7M14.2 14.9l2.9 4.1M9.8 14.9l-2.9 4.1M8.5 10.8L3.7 9.1" />
    </>
  ),
}
function SportIcon({ league }) {
  return (
    <svg className="wl-tile__icon" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {ICON[KIND[league] || 'soccer']}
    </svg>
  )
}

// Each league's own logo (ESPN's versions for dark backgrounds; the college leagues have ESPN's
// sport marks), and the color its tile glows in
const ESPN = 'https://a.espncdn.com'
const LOGO = {
  nfl: `${ESPN}/i/teamlogos/leagues/500-dark/nfl.png`,
  nba: `${ESPN}/i/teamlogos/leagues/500-dark/nba.png`,
  mlb: `${ESPN}/i/teamlogos/leagues/500-dark/mlb.png`,
  nhl: `${ESPN}/i/teamlogos/leagues/500-dark/nhl.png`,
  wnba: `${ESPN}/i/teamlogos/leagues/500-dark/wnba.png`,
  ncaaf: `${ESPN}/redesign/assets/img/icons/ESPN-icon-football-college.png`,
  ncaab: `${ESPN}/redesign/assets/img/icons/ESPN-icon-basketball.png`,
  epl: `${ESPN}/i/leaguelogos/soccer/500-dark/23.png`,
  laliga: `${ESPN}/i/leaguelogos/soccer/500-dark/15.png`,
  seriea: `${ESPN}/i/leaguelogos/soccer/500-dark/12.png`,
  bundesliga: `${ESPN}/i/leaguelogos/soccer/500-dark/10.png`,
  mls: `${ESPN}/i/leaguelogos/soccer/500-dark/19.png`,
}
const GLOW = { nfl: '33, 82, 196', nba: '201, 8, 42', mlb: '191, 13, 62', nhl: '170, 178, 182', wnba: '250, 77, 0', ncaaf: '176, 98, 52', ncaab: '242, 140, 40', epl: '150, 80, 230', laliga: '255, 75, 68', seriea: '26, 142, 211', bundesliga: '210, 5, 21', mls: '46, 107, 191' }

function LeagueLogo({ league }) {
  const [bad, setBad] = useState(false)
  if (bad || !LOGO[league]) return <SportIcon league={league} />
  return <img className="wl-tile__logo" src={LOGO[league]} alt="" width="40" height="40" decoding="async" onError={() => setBad(true)} />
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** The month a league's season comes back, from its off-season months. */
function backIn(off, month) {
  for (let k = 1; k <= 12; k++) {
    const m = ((month - 1 + k) % 12) + 1
    if (!off.includes(m)) return MONTHS[m - 1]
  }
  return null
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const ALERT_PREFS = { results: true, injuries: true, ticker: 'big' }

/** Whether this device can take alerts now (a step that can't work isn't shown). */
function alertsPossible(cfg) {
  if (!cfg) return false
  if (isNative()) return Boolean(cfg.native)
  const env = pushEnv()
  return Boolean(cfg.enabled && cfg.publicKey && env.supported && env.permission === 'default' && !(env.ios && !env.standalone))
}

// ---- the steps ------------------------------------------------------------------------------

function Leagues({ value, onChange, offseason }) {
  const month = new Date().getMonth() + 1
  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])
  return (
    <ul className="wl-grid" aria-label="Leagues">
      {SPORTS.map((s) => {
        const at = value.indexOf(s.key)
        const months = offseason?.get(s.key) || []
        const off = months.includes(month)
        const back = off ? backIn(months, month) : null
        return (
          <li key={s.key}>
            <button type="button" className="wl-tile wl-tile--league" style={{ '--lg': GLOW[s.key] || '120, 132, 125' }} aria-pressed={at >= 0} onClick={() => toggle(s.key)}>
              <LeagueLogo league={s.key} />
              <span className="wl-tile__name">{s.name}</span>
              <span className={`wl-tile__sub${off ? ' is-off' : ''}`}>{off ? (back ? `Off-season, back in ${back}` : 'Off-season') : s.title !== s.name ? s.title : SPORT_WORD[KIND[s.key] || 'soccer']}</span>
              {at >= 0 && (
                <span className="wl-tile__rank num" aria-label={at === 0 ? 'opens first' : `number ${at + 1}`}>
                  {at + 1}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function Odds({ value, onChange }) {
  const options = [
    ['american', 'American', '-110', '+150'],
    ['decimal', 'Decimal', '1.91', '2.50'],
  ]
  return (
    <ul className="wl-list" aria-label="Odds format">
      {options.map(([k, name, a, b]) => (
        <li key={k}>
          <button type="button" className="wl-row" aria-pressed={value === k} onClick={() => onChange(k)}>
            <span className="wl-row__name">{name}</span>
            <span className="wl-row__eg num">
              {a}
              <span>{b}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A state's or province's flag; a globe for somewhere else, or when the picture won't load. */
function Flag({ code }) {
  const [bad, setBad] = useState(false)
  const src = flagOf(code)
  if (!src || bad) {
    return (
      <span className="wl-flag wl-flag--globe" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z" />
        </svg>
      </span>
    )
  }
  return <img className="wl-flag" src={src} alt="" width="40" height="27" loading="lazy" decoding="async" onError={() => setBad(true)} />
}

function Region({ value, onChange }) {
  const [q, setQ] = useState('')
  const hit = (name, code) => !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase()) || code.toLowerCase() === q.trim().toLowerCase()
  const groups = [
    ['United States', US_STATES.filter(([k, n]) => hit(n, k)).map(([k, n]) => [`US-${k}`, n])],
    ['Canada', CA_PROVINCES.filter(([k, n]) => hit(n, k)).map(([k, n]) => [`CA-${k}`, n])],
    ['Somewhere else', hit('Outside the US and Canada', 'other') ? [['other', 'Outside the US and Canada']] : []],
  ].filter(([, rows]) => rows.length)
  return (
    <>
      <label className="wl-search">
        <span className="sr-only">Search states and provinces</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search states and provinces" autoComplete="off" enterKeyHint="search" />
      </label>
      {groups.length === 0 && <p className="wl-none">Nothing matches “{q}”.</p>}
      {groups.map(([title, rows]) => (
        <section key={title} className="wl-group" aria-label={title}>
          <p className="wl-group__title">{title}</p>
          <ul className="wl-list">
            {rows.map(([code, name]) => (
              <li key={code}>
                <button type="button" className="wl-row wl-row--place" aria-pressed={value === code} onClick={() => onChange(code)}>
                  <Flag code={code} />
                  <span className="wl-row__name">{name}</span>
                  {value === code ? (
                    <span className="wl-row__check">
                      <Check />
                    </span>
                  ) : (
                    <span className="wl-row__code num">{code === 'other' ? '' : code.slice(3)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function Books({ value, onChange }) {
  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])
  return (
    <ul className="wl-grid" aria-label="Sportsbooks">
      {FEATURED_BOOKS.map((k) => (
        <li key={k}>
          <button type="button" className="wl-tile wl-tile--book" aria-pressed={value.includes(k)} onClick={() => toggle(k)}>
            <BookLogo book={k} size={30} />
            <span className="wl-tile__name wl-tile__name--book">{bookName(k)}</span>
            {value.includes(k) && (
              <span className="wl-tile__tick">
                <Check />
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The record we keep in public: this season's graded props, from the Calibration page. */
function Record({ cal }) {
  const o = cal?.overall
  const bands = (cal?.bands || []).filter((b) => b.n >= 300)
  if (!o) return <div className="wl-record wl-record--wait" aria-busy="true" />
  const p1 = (x) => `${(x * 100).toFixed(1)}%`
  return (
    <div className="wl-record">
      <p className="wl-record__big num">{o.n.toLocaleString('en-US')}</p>
      <p className="wl-record__k">props graded against the final result this season</p>
      <p className="wl-record__line">
        We rated them <b className="num">{p1(o.avg)}</b> on average. They hit <b className="num">{p1(o.hit)}</b>.
      </p>
      {bands.length > 0 && (
        <ul className="wl-bands" aria-label="Hit rate by rating">
          {bands.map((b) => (
            <li key={b.key}>
              <span className="wl-bands__label">Rated {b.label.replace(' to ', '–')}</span>
              <span className="wl-bands__bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, b.hit * 100)}%` }} />
                <em style={{ left: `${Math.min(100, b.avg * 100)}%` }} />
              </span>
              <span className="wl-bands__hit num">{p1(b.hit)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="wl-fine">The bar is how often they hit; the tick is what we rated them. The whole record, day by day, is on the Calibration page.</p>
    </div>
  )
}

function Alerts({ format }) {
  const price = (a) => (format === 'decimal' ? (a > 0 ? 1 + a / 100 : 1 + 100 / -a).toFixed(2) : a > 0 ? `+${a}` : String(a))
  const rows = [
    ['Result', 'Your 3-leg parlay: two legs in, one to go'],
    ['Injury', 'A player on your open pick was ruled out'],
    ['Line move', `Your pick’s price moved from ${price(-110)} to ${price(-135)}`],
  ]
  return (
    <div className="wl-alerts">
      <p className="wl-fine">What they look like:</p>
      <ul>
        {rows.map(([k, t]) => (
          <li key={k}>
            <span className="wl-alerts__k">{k}</span>
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const PRO_POINTS = ['The model’s written take on every prop', 'Both lineups, with photos and the matchups that decide it', 'The game analyzer for any matchup', 'Kelly stake sizing on every pick']

function Pro({ plans, plan, setPlan, paywall, native }) {
  return (
    <div className="wl-pro">
      <ul className="wl-pro__points">
        {PRO_POINTS.map((t) => (
          <li key={t}>
            <span className="wl-pro__tick">
              <Check />
            </span>
            {t}
          </li>
        ))}
      </ul>
      <p className="wl-fine">None of it uses credits.</p>
      {paywall && plans.length > 0 && (
        <ul className="wl-plans" aria-label="Passes">
          {plans.map((p) => (
            <li key={p.id}>
              <button type="button" className="wl-plan" aria-pressed={plan === p.id} onClick={() => setPlan(p.id)}>
                <span className="wl-plan__name">{p.name}</span>
                <span className="wl-plan__what">{p.id === 'elite' ? 'Everything in Pro, plus a public picks page' : 'The full read on every prop'}</span>
                <span className="wl-plan__price num">{native ? '30 days' : `$${p.priceUsd}`}</span>
                {!native && <span className="wl-plan__per">for 30 days</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- the flow -------------------------------------------------------------------------------

const COPY = {
  leagues: ['Pick your leagues', 'PropPickz opens on the first one, and they all come first in the league menu.'],
  odds: ['How do you read odds?', 'Every price on PropPickz shows this way. You can change it in Account.'],
  region: ['Where do you bet?', 'Sportsbook links open in your state’s version of each book.'],
  books: ['Pick your sportsbooks', 'Their prices come first on your slip, and a tap opens their app.'],
  record: ['Graded in public', 'Every prop we rate is checked against the result, and the record is open to anyone.'],
  alerts: ['Get the alerts that matter', 'Results as your games end, injury news on your picks, and big line moves.'],
  pro: ['PropPickz Pro', 'The full read on every prop.'],
}

export function Welcome() {
  const loc = useLocation()
  const nav = useNavigate()
  const open = new URLSearchParams(loc.search).get('welcome') === '1'
  const { user, loading } = useAuth()
  return open && !loading && user ? <Flow key={user.uid} loc={loc} nav={nav} /> : null
}

/** The steps themselves (Welcome decides when they show). */
export function Flow({ loc, nav }) {
  const { member, paywall, config } = useBilling()
  const sports = useApi('/api/sports', { maxAgeMs: 10 * 60_000 }).data
  const pushCfg = useApi('/api/push/config', { maxAgeMs: 10 * 60_000 }).data
  const cal = useApi('/api/calibration', { maxAgeMs: 10 * 60_000 }).data
  const saved = useMemo(readPrefs, [])
  const here = loc.pathname.split('/')[1]
  const [leagues, setLeagues] = useState(() => (saved.leagues.length ? saved.leagues : [isSport(here) ? here : 'nfl']))
  const [odds, setOdds] = useState(saved.odds || 'american')
  const [region, setRegion] = useState(saved.region || null)
  const [books, setBooks] = useState(saved.books || [])
  const [plan, setPlan] = useState('pro')
  const [busy, setBusy] = useState(false)
  const [i, setI] = useState(0)
  const title = useRef(null)
  const root = useRef(null)
  const native = isNative()
  const plans = (config?.plans || []).filter((p) => p.id === 'pro' || p.id === 'elite')
  const offseason = sports?.sports ? new Map(sports.sports.map((s) => [s.key, s.offseason || []])) : null

  // the steps this member gets: no alerts step where alerts can't work, no Pro for a member
  const steps = useMemo(() => ['leagues', 'odds', 'region', 'books', 'record', ...(alertsPossible(pushCfg) ? ['alerts'] : []), ...(member ? [] : ['pro'])], [pushCfg, member])
  const step = steps[Math.min(i, steps.length - 1)]
  const last = i >= steps.length - 1

  // the page behind can't be reached or scrolled while the setup is up
  useEffect(() => {
    const behind = [...document.querySelectorAll('.app > *:not(.welcome)')]
    behind.forEach((el) => el.setAttribute('inert', ''))
    document.documentElement.classList.add('is-welcoming')
    return () => {
      behind.forEach((el) => el.removeAttribute('inert'))
      document.documentElement.classList.remove('is-welcoming')
    }
  }, [])
  useEffect(() => {
    title.current?.focus({ preventScroll: true })
    root.current?.querySelector('.welcome__body')?.scrollTo?.({ top: 0 })
  }, [step])

  const close = () => {
    const q = new URLSearchParams(loc.search)
    q.delete('welcome')
    nav({ pathname: loc.pathname, search: q.toString() ? `?${q}` : '', hash: loc.hash }, { replace: true })
  }
  const finish = async (then = null) => {
    setBusy(true)
    await savePrefs({ leagues, odds, region, books }, { done: true })
    setBusy(false)
    if (then) nav(then)
    else close()
  }
  // `o` carries an answer set in the same tap ("I don't have one yet"), before the state catches up
  const next = (o = {}) => {
    if (step === 'leagues') {
      savePrefs({ leagues })
      setLeague(leagues[0])
      // a home page behind becomes the first league's, so that's what shows through at the end
      const homeBehind = loc.pathname === '/' || (isSport(here) && loc.pathname.replace(/\/+$/, '') === `/${here}`)
      if (homeBehind && sp(leagues[0]) !== loc.pathname) nav(withSetup(sp(leagues[0])), { replace: true })
    }
    if (step === 'odds') savePrefs({ odds })
    if (step === 'region') savePrefs({ region })
    if (step === 'books') savePrefs({ books: o.books ?? books })
    if (last) return finish()
    setI(i + 1)
  }
  const turnOnAlerts = async () => {
    setBusy(true)
    try {
      if (native) await enableNativePush({ prefs: ALERT_PREFS, register: (token, p) => api('/api/push/native/subscribe', { method: 'POST', body: { token, prefs: p, device: 'iPhone app' } }) })
      else await enablePush({ publicKey: pushCfg.publicKey, prefs: ALERT_PREFS })
    } catch {
      /* declined or failed: Account has the switch for later */
    }
    setBusy(false)
    next()
  }
  // skipping keeps what's answered and finishes, ending on Pro like everyone else
  const skip = () => {
    savePrefs({ leagues, odds, region, books }, { done: true })
    const pro = steps.indexOf('pro')
    if (pro >= 0 && i < pro) setI(pro)
    else close()
  }

  const ready = step === 'leagues' ? leagues.length > 0 : step === 'region' ? Boolean(region) : step === 'books' ? books.length > 0 : true
  const [head, sub] = COPY[step]
  const over = step === 'pro'
  let cta = 'Continue'
  if (step === 'alerts') cta = 'Turn on alerts'
  if (over) cta = paywall ? `Get ${plans.find((p) => p.id === plan)?.name || 'Pro'}` : 'Start exploring'
  const act = step === 'alerts' ? turnOnAlerts : over && paywall ? () => finish(`/account?buy=${plan}`) : () => next()

  return (
    <div ref={root} className={`welcome${over ? ' is-over' : ''}`} role="dialog" aria-modal="true" aria-labelledby="welcome-h">
      <div className="welcome__top">
        {over ? (
          <span />
        ) : i > 0 ? (
          <button type="button" className="welcome__icon" onClick={() => setI(i - 1)} aria-label="Back">
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <path d="M12.5 4.5L7 10l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span />
        )}
        {over ? (
          <span />
        ) : (
          <ol className="welcome__dots" aria-label={`Step ${i + 1} of ${steps.length}`}>
            {steps.map((s, k) => (
              <li key={s} className={k === i ? 'is-on' : k < i ? 'is-done' : ''} />
            ))}
          </ol>
        )}
        {!over ? (
          <button type="button" className="welcome__skip" onClick={skip}>
            Skip
          </button>
        ) : (
          <button type="button" className="welcome__icon welcome__close" onClick={() => finish()} aria-label="Close">
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="welcome__body" key={step}>
        <h2 id="welcome-h" className="welcome__title" tabIndex={-1} ref={title}>
          {head}
        </h2>
        <p className="welcome__sub">{sub}</p>
        {step === 'leagues' && <Leagues value={leagues} onChange={setLeagues} offseason={offseason} />}
        {step === 'odds' && <Odds value={odds} onChange={setOdds} />}
        {step === 'region' && <Region value={region} onChange={setRegion} />}
        {step === 'books' && <Books value={books} onChange={setBooks} />}
        {step === 'record' && <Record cal={cal} />}
        {step === 'alerts' && <Alerts format={odds} />}
        {over && <Pro plans={plans} plan={plan} setPlan={setPlan} paywall={paywall} native={native} />}
      </div>
      <div className="welcome__foot">
        <button type="button" className="btn btn--lime btn--block welcome__cta" disabled={!ready || busy} onClick={act}>
          {cta}
        </button>
        {step === 'books' && (
          <button
            type="button"
            className="welcome__alt"
            onClick={() => {
              setBooks([])
              next({ books: [] })
            }}
          >
            I don’t have one yet
          </button>
        )}
        {step === 'alerts' && (
          <button type="button" className="welcome__alt" onClick={() => next()}>
            Not now
          </button>
        )}
        {over && <p className="welcome__note">{paywall ? (native ? '30 days, no auto-renew. Apple shows the price at checkout.' : '30 days, no auto-renew.') : 'Passes aren’t on sale yet, so everything but the model reads is open while PropPickz is in beta.'}</p>}
      </div>
    </div>
  )
}

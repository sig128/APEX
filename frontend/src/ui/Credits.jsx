import { Link } from 'react-router-dom'
import { useApi, load } from '../lib/useApi.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'

// Credits: a monthly allotment for members, spent on the heavy features (a full simulation, a bet
// breakdown, a parlay build), with top-up packs. The server keeps the count; this just shows it.
export const CREDITS_URL = '/api/billing/credits'
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** Your credits, for members (null for everyone else). */
export function useCredits() {
  const { user } = useAuth()
  const { member } = useBilling()
  return useApi(user && member ? CREDITS_URL : null, { maxAgeMs: 30_000 }).data || null
}
export const refreshCredits = () => load(CREDITS_URL, { force: true }).catch(() => {})

/** What an action costs, from the server's price list. */
export function useCost(action) {
  const { config } = useBilling()
  return config?.credits?.costs?.[action] ?? null
}

/** One line: what's left, and when it resets. Says so when it's running low or out. */
export function CreditsLine({ c, cost }) {
  if (!c) return null
  if (c.unlimited) return <p className="credits-line">Credits aren’t counted for your account.</p>
  return (
    <p className={`credits-line${c.warn ? ` is-${c.warn}` : ''}`}>
      <b className="num">{c.left}</b> {c.left === 1 ? 'credit' : 'credits'} left
      {cost != null && <span>{cost > c.left ? `, this needs ${cost}` : `, this uses ${cost}`}</span>}
      <span className="credits-line__muted">
        {' '}
        Monthly credits reset {day(c.resetsAt)}
        {c.topup > 0 ? `, plus ${c.topup} from top-ups` : ''}.
      </span>
      {c.warn && (
        <>
          {' '}
          <Link to="/account#credits">{c.warn === 'out' ? 'Add credits' : 'Running low: add credits'}</Link>
        </>
      )}
    </p>
  )
}

/** The account page: the month's meter, top-ups, packs and recent uses. */
export function CreditsCard({ onBuy }) {
  const c = useCredits()
  const { paywall } = useBilling()
  if (!c) return null
  const pct = c.allot ? Math.min(100, Math.round((c.used / c.allot) * 100)) : 0
  return (
    <section className="acct-credits" id="credits" aria-labelledby="credits-h">
      <div className="acct-credits__head">
        <h2 id="credits-h" className="acct-plan__k">
          Credits
        </h2>
        {!c.unlimited && (
          <p className="acct-credits__big">
            <b className="num">{c.left}</b> left
          </p>
        )}
      </div>
      {c.unlimited ? (
        <p className="muted small">Your account isn’t charged credits.</p>
      ) : (
        <>
          <div className={`acct-credits__bar${c.warn ? ` is-${c.warn}` : ''}`} role="meter" aria-valuemin={0} aria-valuemax={c.allot} aria-valuenow={c.used} aria-label="Monthly credits used">
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="small">
            {c.used} of {c.allot} monthly credits used. They reset {day(c.resetsAt)} and don’t roll over.
            {c.topup > 0 ? ` Top-up credits: ${c.topup}. They don’t expire, and they’re used after the monthly ones.` : ''}
          </p>
          {c.warn === 'low' && <p className="credits-warn">You’ve used 80% of this month’s credits.</p>}
          {c.warn === 'out' && <p className="credits-warn is-out">You’re out of credits until {day(c.resetsAt)}. A top-up adds more now. The rest of your pass stays on.</p>}
        </>
      )}
      <details className="acct-credits__costs">
        <summary>What uses credits</summary>
        <ul>
          <li>A simulation: {c.costs.sim} (a large one, 50,000+ runs or 7+ legs: {c.costs.simLarge})</li>
          <li>A bet breakdown: {c.costs.breakdown}. Looking at it again is free.</li>
          <li>A parlay build: {c.costs.build}</li>
          <li>Everything else uses none: model reads, lineups and matchups, the game analyzer, Kelly sizing, the slip’s quick check, live tracking, news and leaderboards. It all stays on when your credits run out.</li>
        </ul>
        <p className="muted small">A use that fails gives its credits back. Credits have no cash value and can’t be refunded otherwise.</p>
      </details>
      {!c.unlimited && (
        <div className="acct-credits__packs">
          <p className="acct-plan__k">Top-ups</p>
          {paywall ? (
            <div className="row">
              {c.packs.map((p) => (
                <button key={p.id} type="button" className="btn btn--quiet" onClick={() => onBuy?.(p.id)}>
                  {p.credits} credits (${p.priceUsd})
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">Top-ups go on sale with passes.</p>
          )}
        </div>
      )}
      {c.log?.length > 0 && (
        <details className="acct-credits__log">
          <summary>Recent</summary>
          <ul>
            {c.log.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span>{day(e.at)}</span>
                <span>{e.label}</span>
                <b className={`num${e.credits > 0 ? ' is-plus' : ''}`}>{e.credits > 0 ? `+${e.credits}` : e.credits}</b>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'

const COPY = {
  pro: { plan: 'Pro', what: 'AI picks on every prop, the game analyzer, and Kelly stake sizing.' },
  elite: { plan: 'Elite', what: 'your public picks page with X and Instagram links, the Elite badge, the picks feed and the leaderboard.' },
}

/**
 * Shows children when the person has `need`; otherwise says what unlocks it and how. With the
 * paywall off (no passes on sale yet), everyone has every plan, so children always show, except
 * for `ai`: the AI costs money per use, so it takes a real Pro or Elite pass either way.
 */
export function Locked({ need = 'pro', children, title, inline = false, ai = false }) {
  const { user } = useAuth()
  const { has, ent, paywall, loading, config, canAI, me } = useBilling()
  const loc = useLocation()
  if (ai) {
    if (canAI) return children
    if (loading) return <div className={`locked${inline ? ' locked--inline' : ''}`} aria-busy="true" />
    return <AiLocked title={title} inline={inline} signedIn={Boolean(user)} paywall={paywall} lapsed={me?.ai?.status === 'expired'} price={config?.plans?.find((p) => p.id === 'pro')?.priceUsd} next={loc.pathname + loc.search} />
  }
  if (!paywall || has(need)) return children
  if (loading) return <div className={`locked${inline ? ' locked--inline' : ''}`} aria-busy="true" />
  const c = COPY[need]
  const price = config?.plans?.find((p) => p.id === need)?.priceUsd
  const lapsed = ent?.status === 'expired' && ent.paidPlan
  return (
    <div className={`locked${inline ? ' locked--inline' : ''}`}>
      <p className="locked__title">{title || `Part of ${c.plan}`}</p>
      <p className="locked__body">
        {lapsed ? `Your ${ent.paidPlan === 'elite' ? 'Elite' : 'Pro'} pass has ended. Renew to get back ` : `${c.plan} adds `}
        {c.what}
      </p>
      <div className="locked__actions">
        {!user ? (
          <Link className="btn btn--gold" to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`}>
            Sign in
          </Link>
        ) : (
          <Link className="btn btn--gold" to={`/account?buy=${need}`}>
            {lapsed ? 'Renew' : `Get ${c.plan}`}
            {price ? ` for $${price}` : ''}
          </Link>
        )}
        <Link className="btn btn--quiet" to="/pricing">
          Compare plans
        </Link>
      </div>
    </div>
  )
}

/** The AI's lock: members with a Pro or Elite pass only, with or without passes on sale. */
function AiLocked({ title, inline, signedIn, paywall, lapsed, price, next }) {
  return (
    <div className={`locked${inline ? ' locked--inline' : ''}`}>
      <p className="locked__title">{title || 'The AI'}</p>
      <p className="locked__body">
        {lapsed ? 'Your pass has ended, and the AI goes with it. ' : ''}
        The AI (prop reads, the parlay check, game intel and the game analyzer) is for members with a Pro or Elite pass.
        {!paywall && ' Passes aren’t on sale yet.'}
      </p>
      <div className="locked__actions">
        {!signedIn ? (
          <Link className="btn btn--gold" to={`/login?next=${encodeURIComponent(next)}`}>
            Sign in
          </Link>
        ) : (
          paywall && (
            <Link className="btn btn--gold" to="/account?buy=pro">
              {lapsed ? 'Renew' : 'Get Pro'}
              {price ? ` for $${price}` : ''}
            </Link>
          )
        )}
        <Link className="btn btn--quiet" to="/pricing">
          Compare plans
        </Link>
      </div>
    </div>
  )
}

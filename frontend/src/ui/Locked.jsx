import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'

const COPY = {
  pro: { plan: 'Pro', what: 'AI picks on every prop, the game analyzer, and Kelly stake sizing.' },
  elite: { plan: 'Elite', what: 'your public picks page with X and Instagram links, the Elite badge, the picks feed and the leaderboard.' },
}

/**
 * Shows children when the person has `need`; otherwise says what unlocks it and how. With the
 * paywall off (no passes on sale yet), everyone has every plan, so children always show.
 */
export function Locked({ need = 'pro', children, title, inline = false }) {
  const { user } = useAuth()
  const { has, ent, paywall, loading, config } = useBilling()
  const loc = useLocation()
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

import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { isNative } from '../lib/native.js'
import './ProTeaser.css'

/**
 * Under a prop's free reasons, for anyone without a Pro or Elite pass: what Pro adds and the way
 * to get it. The reasons above stay free; the blurred lines under the card stand in for what a
 * pass opens. Members never see it.
 */
export function ProTeaser() {
  const { user } = useAuth()
  const { member, paywall, loading, config, me } = useBilling()
  const loc = useLocation()
  if (loading || member) return null
  const native = isNative()
  // the app shows Apple's own price at checkout, in the member's currency
  const price = native ? null : config?.plans?.find((x) => x.id === 'pro')?.priceUsd
  const lapsed = me?.ai?.status === 'expired'
  const next = loc.pathname + loc.search
  const cta = !paywall
    ? { to: '/pricing', label: 'See what Pro adds' }
    : !user
      ? { to: `/login?next=${encodeURIComponent(next)}`, label: 'Sign in to get Pro' }
      : { to: '/account?buy=pro', label: `${lapsed ? 'Renew Pro' : 'Get Pro'}${price ? ` for $${price}` : ''}` }
  return (
    <aside className="pro-teaser" aria-label="PropPickz Pro">
      <div className="pro-teaser__card">
        <p className="pro-teaser__title">{lapsed ? 'Your Pro pass has ended' : 'Get the full read with Pro'}</p>
        <p className="pro-teaser__body">The model’s written take on this prop, both lineups with the matchups that decide it, the game analyzer and Kelly stake sizing. None of it uses credits.</p>
        <p className="pro-teaser__price">
          {!paywall ? (
            'Passes aren’t on sale yet.'
          ) : price ? (
            <>
              <b className="num">${price}</b> for 30 days, no auto-renew
            </>
          ) : (
            '30 days, no auto-renew'
          )}
        </p>
        <Link className="btn btn--lime btn--block pro-teaser__cta" to={cta.to}>
          {cta.label}
        </Link>
        {paywall && (
          <Link className="link pro-teaser__more" to="/pricing">
            Compare plans
          </Link>
        )}
      </div>
      <div className="pro-teaser__ghost" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </aside>
  )
}

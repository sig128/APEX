import { Link } from 'react-router-dom'
import { useBilling } from '../context/BillingContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useTitle } from '../lib/hooks.js'

const FREE = ['Every prop with hit rates over the last 5, 10 and 20 games, this season, vs the opponent and home/away', 'Cheatsheets, streaks, matchups and line moves', 'Live tracking for every prop and your slip', 'Bet slip with fair odds, copy and share', 'Your own picks page with an auto-graded record']

/** Free stats; Pro adds the AI and Kelly; Elite adds the showcase. */
export function PricingPage() {
  const { config, ent, paywall, plan } = useBilling()
  const { user } = useAuth()
  useTitle('Plans')
  const plans = config?.plans || []
  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Plans</h1>
        <p className="page-sub">The stats are free. Passes run 30 days, paid in USDC on {config?.networkName || 'Base'}, with no card and no auto-renew.</p>
      </header>
      {!paywall && config && <p className="notice">Passes aren't on sale yet, so everything is open while Propify is in beta.</p>}
      <div className="plans">
        <section className="plan">
          <h2 className="plan__name">Free</h2>
          <p className="plan__price">
            <span className="num">$0</span>
          </p>
          <ul className="plan__list">
            {FREE.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
        {plans.map((p) => {
          const current = paywall && plan === p.id && (ent.status === 'active' || ent.status === 'grace')
          const included = paywall && plan === 'elite' && p.id === 'pro' && (ent.status === 'active' || ent.status === 'grace' || ent.status === 'admin')
          return (
            <section key={p.id} className={`plan plan--${p.id}`}>
              <h2 className="plan__name">{p.name}</h2>
              <p className="plan__price">
                <span className="num">${p.priceUsd}</span> per 30 days
              </p>
              <ul className="plan__list">
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
                <li>
                  {p.limits.aiReads} AI prop reads and {p.limits.analyses} game analyses a day
                </li>
              </ul>
              {paywall &&
                (included ? (
                  <p className="muted">Included in your Elite pass.</p>
                ) : current ? (
                  <Link to="/account" className="btn btn--quiet btn--block">
                    {ent.status === 'grace' ? 'Renew now' : `Active, ${ent.daysLeft ?? ''} days left`}
                  </Link>
                ) : (
                  <Link to={user ? `/account?buy=${p.id}` : `/login?next=${encodeURIComponent(`/account?buy=${p.id}`)}`} className={`btn btn--block ${p.id === 'elite' ? 'btn--gold' : 'btn--quiet'}`}>
                    Get {p.name}
                  </Link>
                ))}
            </section>
          )
        })}
      </div>
      <section className="faq">
        <h2 className="section__title">How passes work</h2>
        <dl>
          <dt>How do I pay?</dt>
          <dd>Each payment request has an exact USDC amount, down to the last digit, so it can only match your payment. Send it from any wallet or exchange on Base, or connect a wallet and approve it there. Propify confirms it on-chain, usually within a minute.</dd>
          <dt>What happens when 30 days are up?</dt>
          <dd>You get 7 days of grace with everything still on. Renew during those days and the new 30 start where your pass ended. After that, AI reads and Kelly tools lock (and Elite showcase features hide) until you renew. Stats, your picks and your record stay.</dd>
          <dt>Can I renew early or switch plans?</dt>
          <dd>Renewing adds 30 days to the end of your current pass. Switching from Pro to Elite converts your unused Pro days into Elite days at the price ratio.</dd>
          <dt>Does Propify take bets?</dt>
          <dd>No. Propify is research: stats, probabilities and AI reads. You place bets with your own sportsbook.</dd>
        </dl>
      </section>
    </div>
  )
}

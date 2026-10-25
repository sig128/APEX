import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { useTitle } from '../lib/hooks.js'
import { Dialog } from '../ui/Dialog.jsx'
import { PayFlow } from '../billing/PayFlow.jsx'
import { Skeleton } from '../ui/Bits.jsx'

const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '')
const PLAN = { free: 'Free', pro: 'Pro', elite: 'Elite' }

export function AccountPage() {
  const { user, loading, signOutUser, redeemInviteCode, hasInviteAccess } = useAuth()
  const { me, ent, paywall, config, refresh, isAdmin, usage } = useBilling()
  const [q, setQ] = useSearchParams()
  const [buy, setBuy] = useState(null)
  useTitle('Account')

  useEffect(() => {
    const b = q.get('buy')
    if (paywall && (b === 'pro' || b === 'elite')) setBuy(b)
  }, [q, paywall])

  if (loading) return <div className="container page"><Skeleton rows={4} /></div>
  if (!user) return <Navigate to="/login?next=/account" replace />

  const closeBuy = () => {
    setBuy(null)
    if (q.get('buy')) {
      q.delete('buy')
      setQ(q, { replace: true })
    }
  }
  const plans = config?.plans || []
  return (
    <div className="container page narrow">
      <header className="page-head page-head--row">
        <div>
          <h1 className="page-title">Account</h1>
          <p className="page-sub">{user.email}</p>
        </div>
        <button type="button" className="btn btn--quiet" onClick={signOutUser}>
          Sign out
        </button>
      </header>

      <section className="acct-plan">
        <p className="acct-plan__k">Your plan</p>
        <p className="acct-plan__v">
          {!paywall ? 'Everything is open during the beta' : PLAN[ent.plan] || 'Free'}
          {ent.status === 'grace' && <span className="tag tag--warn">grace period</span>}
          {ent.status === 'admin' && <span className="tag">admin</span>}
        </p>
        {paywall && <PlanLine ent={ent} />}
        {paywall && ent.status !== 'admin' && (
          <div className="row">
            {plans.map((p) => (
              <button key={p.id} type="button" className={`btn ${p.id === (ent.paidPlan || 'elite') ? 'btn--gold' : 'btn--quiet'}`} onClick={() => setBuy(p.id)}>
                {ent.paidPlan === p.id && ent.status !== 'expired' ? `Add 30 days of ${p.name}` : ent.paidPlan === 'elite' && p.id === 'pro' ? 'Switch to Pro' : `Get ${p.name}`} (${p.priceUsd})
              </button>
            ))}
          </div>
        )}
      </section>

      {usage && paywall && (ent.plan !== 'free' || ent.status === 'admin') && (
        <section className="acct-usage">
          <p className="acct-plan__k">Today's AI allowance</p>
          <Meter label="AI prop reads" u={usage.aiReads} />
          <Meter label="Game analyses" u={usage.analyses} />
          <Meter label="Follow-up questions" u={usage.followups} />
          <p className="muted small">Resets at {new Date(usage.resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. A read that fails doesn't count.</p>
        </section>
      )}

      {me?.open?.length > 0 && (
        <section className="acct-list">
          <p className="acct-plan__k">Payment requests waiting</p>
          <ul>
            {me.open.map((inv) => (
              <li key={inv.id}>
                {inv.planName}: {inv.amount} USDC, until {new Date(inv.expiresAt).toLocaleString()}{' '}
                <button type="button" className="linkish" onClick={() => setBuy(inv.plan)}>
                  Pay or check it
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {me?.payments?.length > 0 && (
        <section className="acct-list">
          <p className="acct-plan__k">Payments</p>
          <ul>
            {me.payments.map((p) => (
              <li key={p.id}>
                {fmtDay(p.at)}: {PLAN[p.plan]}, {p.amount} USDC{' '}
                <a className="link" href={`${p.explorer}/tx/${p.txHash}`} target="_blank" rel="noopener noreferrer">
                  transaction
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Redeem redeem={redeemInviteCode} after={refresh} verified={hasInviteAccess} paywall={paywall} />

      <nav className="acct-links">
        <Link to="/me" className="link">
          My picks page
        </Link>
        {isAdmin && (
          <Link to="/admin" className="link">
            Admin
          </Link>
        )}
      </nav>

      <Dialog open={Boolean(buy)} onClose={closeBuy} title={`Get ${PLAN[buy] || ''}`}>
        {buy && <PayFlow plan={buy} onDone={closeBuy} />}
      </Dialog>
    </div>
  )
}

function PlanLine({ ent }) {
  if (ent.status === 'active') return <p>{ent.lifetime ? 'Lifetime pass.' : `Active until ${fmtDay(ent.paidUntil)} (${ent.daysLeft} ${ent.daysLeft === 1 ? 'day' : 'days'} left).`}</p>
  if (ent.status === 'grace') return <p>Your pass ended {fmtDay(ent.paidUntil)}. Everything stays on until {fmtDay(ent.graceUntil)}; renew before then to keep going without a break (the new 30 days start {fmtDay(ent.paidUntil)}).</p>
  if (ent.status === 'expired' && ent.paidPlan) return <p>Your {PLAN[ent.paidPlan]} pass ended {fmtDay(ent.paidUntil)}. Stats are still free; AI picks and Kelly are locked.</p>
  if (ent.status === 'admin') return <p>Admins have every plan.</p>
  return <p>Stats, the slip, live tracking and your picks page are free. Pro adds the AI and Kelly; Elite adds the showcase.</p>
}

function Meter({ label, u }) {
  if (!u || u.limit == null) return null
  const share = u.limit ? Math.min(1, u.used / u.limit) : 0
  return (
    <div className="meter">
      <span>{label}</span>
      <span className="meter__bar" aria-hidden="true">
        <span style={{ width: `${share * 100}%` }} />
      </span>
      <span className="num">
        {u.used}/{u.limit}
      </span>
    </div>
  )
}

function Redeem({ redeem, after, verified, paywall }) {
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!paywall && verified) return null
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const r = await redeem(code.trim())
      setMsg({ ok: true, text: r?.plan ? `Code applied: ${PLAN[r.plan]} is on your account.` : 'Code accepted. The AI is unlocked.' })
      setCode('')
      after()
    } catch (err) {
      // the API's messages are written for people (a miss, a code already used, too many tries)
      setMsg({ ok: false, text: err?.message || 'That code did not work.' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="acct-list">
      <p className="acct-plan__k">{paywall ? 'Have a code?' : 'Invite code'}</p>
      <form className="row" onSubmit={submit}>
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="APEX-XXXX-XXXX-XXXX-XXXX" aria-label="Code" autoCapitalize="characters" spellCheck="false" />
        <button type="submit" className="btn btn--quiet" disabled={busy || code.trim().length < 4}>
          {busy ? 'Checking' : 'Redeem'}
        </button>
      </form>
      {msg && <p className={msg.ok ? 'form-ok' : 'form-err'}>{msg.text}</p>}
    </section>
  )
}

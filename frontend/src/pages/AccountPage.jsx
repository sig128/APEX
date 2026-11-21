import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { useTitle } from '../lib/hooks.js'
import { Dialog } from '../ui/Dialog.jsx'
import { PayFlow } from '../billing/PayFlow.jsx'
import { Skeleton } from '../ui/Bits.jsx'
import { CreditsCard } from '../ui/Credits.jsx'
import { PushCard } from '../ui/PushCard.jsx'
import { replayTour } from '../ui/Tour.jsx'
import { api } from '../lib/api.js'
import { isNative, openSite } from '../lib/native.js'

const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '')
const PLAN = { free: 'Free', pro: 'Pro', elite: 'Elite' }

export function AccountPage() {
  const { user, loading, signOutUser, redeemInviteCode } = useAuth()
  const { me, ent, paywall, config, refresh, isAdmin, usage } = useBilling()
  const [q, setQ] = useSearchParams()
  const [buy, setBuy] = useState(null)
  useTitle('Account')

  useEffect(() => {
    const b = q.get('buy')
    if (paywall && (b === 'pro' || b === 'elite' || /^c\d{2,4}$/.test(b || ''))) setBuy(b)
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
  const native = isNative()
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
          {!paywall ? (me?.ai?.allowed ? `${PLAN[me.ai.plan] || 'Pro'}: the whole site and the model reads` : 'Everything but the model reads is open during the beta') : PLAN[ent.plan] || 'Free'}
          {ent.status === 'grace' && <span className="tag tag--warn">grace period</span>}
          {(ent.status === 'admin' || me?.ai?.status === 'admin') && <span className="tag">admin</span>}
        </p>
        {paywall && <PlanLine ent={ent} />}
        {!paywall && !me?.ai?.allowed && <p className="muted small">Model reads (prop reads, the parlay check, game intel and the analyzer) take a Pro or Elite pass. Passes aren’t on sale yet; a plan code below works.</p>}
        {paywall && ent.status !== 'admin' && native && (
          <div className="row">
            <button type="button" className="btn btn--lime" onClick={() => openSite(`/account?buy=${ent.paidPlan || 'elite'}`)}>
              Get or renew a pass on proppickz.com
            </button>
          </div>
        )}
        {paywall && ent.status !== 'admin' && !native && (
          <div className="row">
            {plans.map((p) => (
              <button key={p.id} type="button" className={`btn ${p.id === (ent.paidPlan || 'elite') ? 'btn--lime' : 'btn--quiet'}`} onClick={() => setBuy(p.id)}>
                {ent.paidPlan === p.id && ent.status !== 'expired' ? `Add 30 days of ${p.name}` : ent.paidPlan === 'elite' && p.id === 'pro' ? 'Switch to Pro' : `Get ${p.name}`} (${p.priceUsd})
              </button>
            ))}
          </div>
        )}
      </section>

      {usage && me?.ai?.allowed && (
        <section className="acct-usage">
          <p className="acct-plan__k">Today's model allowance</p>
          <Meter label="Model prop reads" u={usage.aiReads} />
          <Meter label="Game analyses" u={usage.analyses} />
          <Meter label="Follow-up questions" u={usage.followups} />
          <p className="muted small">Resets at {new Date(usage.resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. A read that fails doesn't count.</p>
        </section>
      )}

      <CreditsCard onBuy={native ? (id) => openSite(`/account?buy=${id}`) : setBuy} />
      <PushCard />

      {!native && me?.open?.length > 0 && (
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

      {!native && me?.payments?.length > 0 && (
        <section className="acct-list">
          <p className="acct-plan__k">Payments</p>
          <ul>
            {me.payments.map((p) => (
              <li key={p.id}>
                {fmtDay(p.at)}: {PLAN[p.plan] || (/^c\d+$/.test(p.plan) ? `${p.plan.slice(1)} credits` : p.plan)}, {p.amount} USDC{' '}
                <a className="link" href={`${p.explorer}/tx/${p.txHash}`} target="_blank" rel="noopener noreferrer">
                  transaction
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {native && <p className="muted small">Passes, credit packs and receipts are on proppickz.com, under Account.</p>}

      <Redeem redeem={redeemInviteCode} after={refresh} />

      <nav className="acct-links">
        <Link to="/me" className="link">
          My picks page
        </Link>
        <button type="button" className="linkish" onClick={replayTour}>
          Replay the tour
        </button>
        {isAdmin && !native && (
          <Link to="/admin" className="link">
            Admin
          </Link>
        )}
      </nav>

      <DeleteAccount after={signOutUser} />

      <Dialog open={Boolean(buy)} onClose={closeBuy} title={PLAN[buy] ? `Get ${PLAN[buy]}` : `Add ${String(buy || '').slice(1)} credits`}>
        {buy && native ? (
          <div className="stack">
            <p>Passes and credit packs are bought on proppickz.com. Sign in there with this account and they show up here as soon as they're paid.</p>
            <button
              type="button"
              className="btn btn--lime btn--block"
              onClick={() => {
                openSite(`/account?buy=${buy}`)
                closeBuy()
              }}
            >
              Open proppickz.com
            </button>
          </div>
        ) : (
          buy && <PayFlow plan={buy} onDone={closeBuy} />
        )}
      </Dialog>
    </div>
  )
}

function PlanLine({ ent }) {
  if (ent.status === 'active') return <p>{ent.lifetime ? 'Lifetime pass.' : `Active until ${fmtDay(ent.paidUntil)} (${ent.daysLeft} ${ent.daysLeft === 1 ? 'day' : 'days'} left).`}</p>
  if (ent.status === 'grace') return <p>Your pass ended {fmtDay(ent.paidUntil)}. Everything stays on until {fmtDay(ent.graceUntil)}; renew before then to keep going without a break (the new 30 days start {fmtDay(ent.paidUntil)}).</p>
  if (ent.status === 'expired' && ent.paidPlan) return <p>Your {PLAN[ent.paidPlan]} pass ended {fmtDay(ent.paidUntil)}. Stats are still free; model reads and Kelly are locked.</p>
  if (ent.status === 'admin') return <p>Admins have every plan.</p>
  return <p>Stats, the slip, live tracking and your picks page are free. Pro adds model reads and Kelly; Elite adds the showcase.</p>
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

function Redeem({ redeem, after }) {
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const r = await redeem(code.trim())
      setMsg({ ok: true, text: r?.plan ? `Code applied: ${PLAN[r.plan]} is on your account.` : 'Code accepted.' })
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
      <p className="acct-plan__k">Have a code?</p>
      <form className="row" onSubmit={submit}>
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="PROPPICKZ-XXXX-XXXX-XXXX-XXXX" aria-label="Code" autoCapitalize="characters" spellCheck="false" />
        <button type="submit" className="btn btn--quiet" disabled={busy || code.trim().length < 4}>
          {busy ? 'Checking' : 'Redeem'}
        </button>
      </form>
      {msg && <p className={msg.ok ? 'form-ok' : 'form-err'}>{msg.text}</p>}
    </section>
  )
}

/**
 * Delete account: everything goes (picks and record, the picks page and its handle, groups,
 * alerts, limits, credits and passes), then the sign-in. Typing DELETE makes it deliberate.
 */
function DeleteAccount({ after }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const ready = typed.trim().toUpperCase() === 'DELETE'
  const close = () => {
    if (busy) return
    setOpen(false)
    setTyped('')
    setErr(null)
  }
  const go = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api('/api/account/delete', { method: 'POST', body: { confirm: 'DELETE' } })
      await after().catch(() => {})
      navigate('/?deleted=1', { replace: true })
    } catch (e) {
      setErr(e?.message || 'Deleting the account failed. Try again in a minute.')
      setBusy(false)
    }
  }
  return (
    <section className="acct-danger" aria-labelledby="del-h">
      <h2 id="del-h" className="acct-plan__k">
        Delete account
      </h2>
      <p className="muted small">Deletes your picks and record, your picks page and handle, your groups, alerts and limits, and any credits or pass time left. It can’t be undone.</p>
      <button type="button" className="btn btn--danger btn--s" onClick={() => setOpen(true)}>
        Delete my account
      </button>
      <Dialog open={open} onClose={close} title="Delete your account?">
        <div className="stack">
          <p>Your picks, record, picks page, groups, alerts, credits and pass time go for good, and you’re signed out. Payment records are kept, as the law requires.</p>
          <label className="field">
            <span>Type DELETE to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck="false" disabled={busy} />
          </label>
          {err && (
            <p className="form-err" role="alert">
              {err}
            </p>
          )}
          <div className="row">
            <button type="button" className="btn btn--danger" disabled={!ready || busy} onClick={go}>
              {busy ? 'Deleting' : 'Delete my account'}
            </button>
            <button type="button" className="btn btn--quiet" onClick={close} disabled={busy}>
              Keep it
            </button>
          </div>
        </div>
      </Dialog>
    </section>
  )
}

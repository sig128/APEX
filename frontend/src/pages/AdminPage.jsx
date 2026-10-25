import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useBilling } from '../context/BillingContext.jsx'
import { useTitle } from '../lib/hooks.js'
import { Skeleton } from '../ui/Bits.jsx'

const day = (ms) => (ms ? new Date(ms).toLocaleString() : '')

/** Payments, passes, comps and revokes. Admins only (the API checks too). */
export function AdminPage() {
  const { isAdmin, loading } = useBilling()
  const [pays, setPays] = useState(null)
  const [subs, setSubs] = useState(null)
  const [form, setForm] = useState({ email: '', plan: 'pro', days: '30', note: '' })
  const [msg, setMsg] = useState(null)
  const [hide, setHide] = useState('')
  useTitle('Admin')
  const load = () => {
    api('/api/billing/admin/payments').then((r) => setPays(r.payments)).catch((e) => setMsg({ ok: false, text: e.message }))
    api('/api/billing/admin/subscriptions').then((r) => setSubs(r.subscriptions)).catch(() => {})
  }
  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin])
  if (loading) return <div className="container page"><Skeleton rows={4} /></div>
  if (!isAdmin) return <Navigate to="/" replace />
  const act = async (path, body, ok) => {
    setMsg(null)
    try {
      await api(path, { method: 'POST', body })
      setMsg({ ok: true, text: ok })
      load()
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    }
  }
  return (
    <div className="container page">
      <header className="page-head page-head--row">
        <h1 className="page-title">Admin</h1>
        <Link to="/adminn" className="btn btn--quiet">
          Sport toggles
        </Link>
      </header>
      <section className="admin-box">
        <h2 className="section__title">Give or take a pass</h2>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault()
            act('/api/billing/admin/grant', { email: form.email.trim(), plan: form.plan, days: form.days === 'lifetime' ? 'lifetime' : Number(form.days), note: form.note }, `Gave ${form.email} ${form.plan} for ${form.days} days.`)
          }}
        >
          <label className="field">
            <span>Email (they must have signed in once)</span>
            <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            <span>Plan</span>
            <select value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
              <option value="pro">Pro</option>
              <option value="elite">Elite</option>
            </select>
          </label>
          <label className="field">
            <span>Days</span>
            <select value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
              {['7', '30', '90', '365', 'lifetime'].map((d) => (
                <option key={d} value={d}>
                  {d === 'lifetime' ? 'Lifetime' : d}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Note</span>
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Why" />
          </label>
          <div className="row">
            <button type="submit" className="btn btn--gold">
              Give pass
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => form.email && window.confirm(`Revoke ${form.email}'s pass?`) && act('/api/billing/admin/revoke', { email: form.email.trim() }, `Revoked ${form.email}.`)}>
              Revoke
            </button>
          </div>
        </form>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            act('/api/picks/admin/hide', { handle: hide.trim().replace(/^@/, ''), hidden: true }, `Hid @${hide}.`)
          }}
        >
          <input className="input" value={hide} onChange={(e) => setHide(e.target.value)} placeholder="@handle" aria-label="Handle to hide" />
          <button type="submit" className="btn btn--quiet">
            Hide page
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => act('/api/picks/admin/hide', { handle: hide.trim().replace(/^@/, ''), hidden: false }, `Showed @${hide}.`)}>
            Unhide
          </button>
        </form>
        {msg && <p className={msg.ok ? 'form-ok' : 'form-err'}>{msg.text}</p>}
      </section>
      <section className="admin-box">
        <h2 className="section__title">Payments</h2>
        {!pays ? (
          <Skeleton rows={3} />
        ) : !pays.length ? (
          <p className="muted">No payments yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="log">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Plan</th>
                  <th className="num-col">USDC</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {pays.map((p) => (
                  <tr key={p.invoiceId || p.id}>
                    <td>{day(p.createdAt)}</td>
                    <td>{p.email || p.uid}</td>
                    <td>{p.plan}</td>
                    <td className="num-col num">{p.amount}</td>
                    <td>
                      <a className="link" href={`${p.explorer}/tx/${p.txHash}`} target="_blank" rel="noopener noreferrer">
                        {p.txHash.slice(0, 10)}…
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="admin-box">
        <h2 className="section__title">Passes</h2>
        {!subs ? (
          <Skeleton rows={3} />
        ) : (
          <div className="table-wrap">
            <table className="log">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Until</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.uid}>
                    <td>{s.email || s.uid}</td>
                    <td>{s.paidPlan}</td>
                    <td>{s.status}</td>
                    <td>{s.lifetime ? 'lifetime' : day(s.paidUntil)}</td>
                    <td>
                      {s.source}
                      {s.note ? `: ${s.note}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

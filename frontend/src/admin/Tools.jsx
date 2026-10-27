// Passes by hand, hiding a picks page, and how each league's log is doing.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { ago } from '../lib/format.js'
import { LEAGUE, dayLabel } from './numbers.js'

export function Tools({ data, onChanged }) {
  const [form, setForm] = useState({ email: '', plan: 'pro', days: '30', note: '' })
  const [msg, setMsg] = useState(null)
  const [hide, setHide] = useState('')
  const act = async (path, body, ok) => {
    setMsg(null)
    try {
      await api(path, { method: 'POST', body })
      setMsg({ ok: true, text: ok })
      onChanged?.()
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    }
  }
  const status = data?.model?.status || {}
  return (
    <div className="adm-tools">
      <section className="adm-panel">
        <h3 className="adm-h3">Give or take a pass</h3>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault()
            act('/api/billing/admin/grant', { email: form.email.trim(), plan: form.plan, days: form.days === 'lifetime' ? 'lifetime' : Number(form.days), note: form.note }, `Gave ${form.email} ${form.plan === 'elite' ? 'Elite' : 'Pro'} for ${form.days === 'lifetime' ? 'life' : `${form.days} days`}.`)
          }}
        >
          <label className="field">
            <span>Email</span>
            <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            <span>Pass</span>
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
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Why (only you see it)" />
          </label>
          <div className="row">
            <button type="submit" className="btn btn--gold">
              Give pass
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => form.email && window.confirm(`Take away ${form.email}'s pass?`) && act('/api/billing/admin/revoke', { email: form.email.trim() }, `Took away ${form.email}'s pass.`)}>
              Take it away
            </button>
          </div>
        </form>
        <p className="adm-note">They need to have signed in to Propify once. A pass you give shows as free in Money, not as revenue.</p>
      </section>
      <section className="adm-panel">
        <h3 className="adm-h3">Hide a picks page</h3>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            act('/api/picks/admin/hide', { handle: hide.trim().replace(/^@/, ''), hidden: true }, `Hid @${hide.replace(/^@/, '')}.`)
          }}
        >
          <input className="input" value={hide} onChange={(e) => setHide(e.target.value)} placeholder="@handle" aria-label="Handle to hide" />
          <button type="submit" className="btn btn--quiet">
            Hide page
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => act('/api/picks/admin/hide', { handle: hide.trim().replace(/^@/, ''), hidden: false }, `Showed @${hide.replace(/^@/, '')} again.`)}>
            Show it again
          </button>
        </form>
        <p className="adm-note">
          League switches for the old analyzer are on <Link to="/adminn">their own page</Link> and need your admin key.
        </p>
      </section>
      {msg && <p className={msg.ok ? 'form-ok' : 'form-err'}>{msg.text}</p>}
      <section className="adm-panel">
        <h3 className="adm-h3">The board’s log, league by league</h3>
        {!Object.keys(status).length ? (
          <p className="adm-empty">No league has started its log on this server yet.</p>
        ) : (
          <table className="adm-table adm-table--tight">
            <thead>
              <tr>
                <th scope="col">League</th>
                <th scope="col" className="num-col">
                  Days on file
                </th>
                <th scope="col" className="num-col">
                  Waiting on results
                </th>
                <th scope="col" className="adm-hide-s">
                  First day
                </th>
                <th scope="col" className="adm-hide-s">
                  Last saved here
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(status).map(([k, s]) => (
                <tr key={k}>
                  <th scope="row">{LEAGUE[k] || k}</th>
                  <td className="num-col num">{s.onFile}</td>
                  <td className="num-col num">{s.open}</td>
                  <td className="adm-hide-s num">{s.first ? dayLabel(s.first) : '–'}</td>
                  <td className="adm-hide-s muted">
                    {s.lastRecord ? ago(s.lastRecord) : 'not on this server yet'}
                    {s.error && <span className="form-err"> {s.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="adm-note">Lines are saved whenever someone opens a league, and once a day in the late morning (Eastern) by a scheduled run, which also grades finished games.</p>
      </section>
    </div>
  )
}

// Members (who joined, who's active, who pays, how their picks are doing) and money (what
// came in, by month and payment by payment).
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Headshot } from '../ui/Img.jsx'
import { ago } from '../lib/format.js'
import { Columns } from './charts.jsx'
import { dayKey, shiftDay, dayLabel, unitsTxt, money, compact } from './numbers.js'

const PLAN = { free: 'Free', pro: 'Pro', elite: 'Elite' }
const when = (ms) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '–')

export function Members({ users }) {
  const [q, setQ] = useState('')
  const [plan, setPlan] = useState('all')
  const today = dayKey(Date.now())
  const days = useMemo(() => Array.from({ length: 60 }, (_, i) => shiftDay(today, i - 59)), [today])
  const cols = days.map((d) => ({ key: d, label: dayLabel(d), short: dayLabel(d), value: users?.signups?.[d] || 0, sub: 'new members' }))
  const list = (users?.list || []).filter((m) => {
    if (plan !== 'all' && m.plan !== plan) return false
    if (!q.trim()) return true
    const s = q.trim().toLowerCase().replace(/^@/, '')
    return [m.name, m.email, m.handle].some((x) => x && String(x).toLowerCase().includes(s))
  })
  if (!users) return <p className="adm-empty">Members couldn’t be loaded.</p>
  return (
    <div className="adm-people">
      <div className="adm-strip adm-strip--4">
        <Cell label="Members" value={compact(users.total)} sub={users.source === 'auth' ? 'signed in with Google' : 'with a picks page'} />
        <Cell label="New this week" value={`+${users.new7}`} sub={`+${users.new30} in 30 days`} />
        <Cell label="Active this week" value={compact(users.active7)} sub={users.total ? `${Math.round((users.active7 / users.total) * 100)}% of members` : ''} />
        <Cell label="Paying" value={users.paid} sub={`${users.plans.pro || 0} Pro, ${users.plans.elite || 0} Elite · ${users.comps} free passes`} />
      </div>
      <h3 className="adm-h3">New members, last 60 days</h3>
      <Columns data={cols} format={(v) => String(v)} label="New members per day, last 60 days" />
      <div className="adm-people__bar">
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or @handle" aria-label="Search members" />
        <label className="adm-select">
          <span className="sr-only">Plan</span>
          <select value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="all">Every plan</option>
            <option value="elite">Elite</option>
            <option value="pro">Pro</option>
            <option value="free">Free</option>
          </select>
        </label>
        <span className="muted small">{list.length.toLocaleString()} shown</span>
      </div>
      <table className="adm-table adm-table--people">
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col" className="adm-hide-s">
              Email
            </th>
            <th scope="col">Plan</th>
            <th scope="col" className="adm-hide-s">
              Joined
            </th>
            <th scope="col" className="adm-hide-s">
              Last seen
            </th>
            <th scope="col" className="num-col">
              Picks, 30 days
            </th>
          </tr>
        </thead>
        <tbody>
          {list.slice(0, 300).map((m) => (
            <tr key={m.uid}>
              <th scope="row">
                <span className="adm-member">
                  <Headshot src={m.photo} name={m.name || m.email || m.handle} size={32} />
                  <span>
                    <b>{m.name || m.email || 'No name'}</b>
                    {m.handle ? (
                      <Link to={`/u/${m.handle}`} className="link adm-member__handle">
                        @{m.handle}
                      </Link>
                    ) : (
                      <span className="muted adm-member__handle">no picks page</span>
                    )}
                  </span>
                </span>
              </th>
              <td className="adm-hide-s muted">{m.email || '–'}</td>
              <td>
                <span className={`adm-plan is-${m.plan}`}>{PLAN[m.plan] || m.plan}</span>
                {m.plan !== 'free' && m.source && m.source !== 'usdc' && <span className="muted small"> free pass</span>}
              </td>
              <td className="adm-hide-s num">{when(m.joined)}</td>
              <td className="adm-hide-s muted">{m.lastSeen ? ago(m.lastSeen) : '–'}</td>
              <td className="num-col num">{m.record?.d30 && m.record.d30.wins + m.record.d30.losses ? `${m.record.d30.wins}-${m.record.d30.losses}, ${unitsTxt(m.record.d30.units, 1)}` : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length > 300 && <p className="adm-note">Showing the newest 300. Search to find anyone else.</p>}
    </div>
  )
}

export function Money({ cash, users }) {
  if (!cash) return <p className="adm-empty">Payments couldn’t be loaded.</p>
  const months = Object.keys(cash.byMonth || {}).sort()
  const now = new Date()
  const last12 = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 15))
    return d.toISOString().slice(0, 7)
  })
  const cols = last12.map((m) => ({ key: m, label: new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), short: new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), value: cash.byMonth?.[m] || 0 }))
  const passes = (users?.list || []).filter((m) => m.plan !== 'free')
  const prev = last12[10]
  const prevName = new Date(`${prev}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  return (
    <div className="adm-money">
      <div className="adm-strip adm-strip--3">
        <Cell label="All time" value={money(cash.total)} sub={`${cash.count} payments in USDC`} />
        <Cell label="This month" value={money(cash.month)} sub={months.length ? `${money(cash.byMonth?.[prev] || 0)} in ${prevName}` : 'no payments yet'} />
        <Cell label="Passes running" value={passes.length} sub={`${passes.filter((m) => m.source === 'usdc').length} paid, ${passes.filter((m) => m.source !== 'usdc').length} free`} />
      </div>
      <h3 className="adm-h3">By month</h3>
      <Columns data={cols} format={(v) => money(v)} label="Revenue by month, last 12 months" />
      <h3 className="adm-h3">Payments</h3>
      {!cash.recent.length ? (
        <p className="adm-empty">No payments yet. Passes go on sale once your wallet address is set in Vercel (APEX_TREASURY_ADDRESS).</p>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Pass</th>
              <th scope="col" className="num-col">
                Amount
              </th>
              <th scope="col" className="adm-hide-s">
                Transaction
              </th>
            </tr>
          </thead>
          <tbody>
            {cash.recent.map((p) => (
              <tr key={p.id}>
                <td className="num">{when(p.at)}</td>
                <th scope="row">{p.email || p.uid}</th>
                <td>
                  <span className={`adm-plan is-${p.plan}`}>{PLAN[p.plan] || p.plan}</span>
                </td>
                <td className="num-col num">{money(p.usd ?? Number(p.amount))}</td>
                <td className="adm-hide-s">
                  {p.explorer && p.txHash ? (
                    <a className="link" href={`${p.explorer}/tx/${p.txHash}`} target="_blank" rel="noopener noreferrer">
                      {p.txHash.slice(0, 10)}…
                    </a>
                  ) : (
                    '–'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="adm-h3">Who has a pass</h3>
      {!passes.length ? (
        <p className="adm-empty">Nobody has a pass right now.</p>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Pass</th>
              <th scope="col">Until</th>
              <th scope="col" className="adm-hide-s">
                How
              </th>
            </tr>
          </thead>
          <tbody>
            {passes.map((m) => (
              <tr key={m.uid}>
                <th scope="row">{m.name || m.email || m.uid}</th>
                <td>
                  <span className={`adm-plan is-${m.plan}`}>{PLAN[m.plan]}</span>
                  {m.status === 'grace' && <span className="muted small"> grace days</span>}
                </td>
                <td className="num">{m.until === 'lifetime' ? 'Lifetime' : when(m.until)}</td>
                <td className="adm-hide-s muted">{m.source === 'usdc' ? 'Paid' : m.source === 'invite' ? 'Code' : 'Given by you'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** One scoreboard cell: the label, the number, one line of context. */
export function Cell({ label, value, sub, tone, big = false }) {
  return (
    <div className={`adm-cell${big ? ' is-big' : ''}`}>
      <span className="adm-cell__label">{label}</span>
      <span className={`adm-cell__value${tone ? ` is-${tone}` : ''}`}>{value}</span>
      {sub && <span className="adm-cell__sub">{sub}</span>}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { units as fmtUnits, odds, ago, kickoff } from '../lib/format.js'
import { clvText } from './PickCard.jsx'

const roiText = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}%` : '–')
const dateText = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** Load once, with a way to replace the data after a change. */
function useLoad(path) {
  const [state, setState] = useState({ data: null, err: null, loading: true })
  useEffect(() => {
    let live = true
    api(path)
      .then((data) => live && setState({ data, err: null, loading: false }))
      .catch((err) => live && setState({ data: null, err, loading: false }))
    return () => {
      live = false
    }
  }, [path])
  return [state, (data) => setState({ data, err: null, loading: false })]
}

/** Status changes for players on your open picks. */
export function AlertsCard() {
  const [{ data, err }, set] = useLoad('/api/picks/me/alerts')
  if (err || !data) return null
  const seen = async () => {
    await api('/api/picks/me/alerts/seen', { method: 'POST', body: {} }).catch(() => {})
    set({ ...data, unread: 0, seenAt: Date.now() })
  }
  return (
    <section className="tool-card" aria-labelledby="alerts-title">
      <div className="tool-card__head">
        <h2 id="alerts-title" className="tool-card__title">
          Alerts {data.unread > 0 && <span className="count-dot">{data.unread}</span>}
        </h2>
        {data.unread > 0 && (
          <button type="button" className="linkish" onClick={seen}>
            Mark as read
          </button>
        )}
      </div>
      {!data.items.length ? (
        <p className="muted small">When a player on one of your open picks changes status on the injury report, it shows up here.</p>
      ) : (
        <ul className="alerts">
          {data.items.slice(0, 12).map((a) => (
            <li key={a.id} className={a.at > (data.seenAt || 0) ? 'is-new' : ''}>
              <span className={`inj-chip is-${a.tag || 'clear'}`}>{a.to}</span>
              <span>
                <b>{a.name}</b> {a.label}: was {a.from.toLowerCase()}. {a.kickoff ? `Game ${kickoff(new Date(a.kickoff).toISOString())}.` : ''}
              </span>
              <span className="muted small">{ago(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The coach: patterns in your graded picks, with their numbers and the picks behind them. */
export function CoachCard() {
  const [{ data, err }] = useLoad('/api/picks/me/coach')
  const [open, setOpen] = useState(null)
  if (err || !data) return null
  const w = data.week
  return (
    <section className="tool-card" aria-labelledby="coach-title">
      <div className="tool-card__head">
        <h2 id="coach-title" className="tool-card__title">
          Your betting habits
        </h2>
        <span className="muted small">from {data.decided} graded picks</span>
      </div>
      <dl className="week">
        <div>
          <dt>Posted this week</dt>
          <dd className="num">{w.made}</dd>
        </div>
        <div>
          <dt>Graded</dt>
          <dd className="num">
            {w.wins}-{w.losses}
          </dd>
        </div>
        <div>
          <dt>Units</dt>
          <dd className={`num ${w.units > 0 ? 'is-plus' : w.units < 0 ? 'is-minus' : ''}`}>{fmtUnits(w.units)}</dd>
        </div>
        <div>
          <dt>ROI</dt>
          <dd className="num">{roiText(w.roi)}</dd>
        </div>
        <div>
          <dt>CLV</dt>
          <dd className="num">{clvText(w.clv)}</dd>
        </div>
      </dl>
      {data.clvTrend?.length >= 2 && <ClvTrend weeks={data.clvTrend} />}
      {!data.insights.length ? (
        <p className="muted small">
          Nothing to flag. A pattern shows up here once each group it compares has at least {data.threshold} graded picks.
        </p>
      ) : (
        <ul className="insights">
          {data.insights.map((x) => (
            <li key={x.id} className={`insight is-${x.tone}`}>
              <p className="insight__title">{x.title}</p>
              <p>{x.text}</p>
              <button type="button" className="linkish" aria-expanded={open === x.id} onClick={() => setOpen(open === x.id ? null : x.id)}>
                {open === x.id ? 'Hide the picks' : `See the ${x.picks.length} picks`}
              </button>
              {open === x.id && (
                <ul className="insight__picks">
                  {x.picks.map((id) => data.refs[id]).filter(Boolean).map((p) => (
                    <li key={p.id}>
                      <span className="ip__legs">{p.legs.join(' + ')}</span>
                      <span className="ip__meta muted">
                        {dateText(p.createdAt)}, {odds(p.price)}, {p.units}u{Number.isFinite(p.clv) ? `, CLV ${clvText(p.clv)}` : ''}
                      </span>
                      <span className={`ip__res num ${p.profit > 0 ? 'is-plus' : p.profit < 0 ? 'is-minus' : ''}`}>
                        {p.result === 'win' ? 'Won' : p.result === 'loss' ? 'Lost' : p.result} {fmtUnits(p.profit || 0)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Average CLV week by week: bars above the line beat the close, below trailed it. */
function ClvTrend({ weeks }) {
  const w = 300
  const h = 90
  const pad = 14
  const max = Math.max(0.02, ...weeks.map((x) => Math.abs(x.avg)))
  const bw = (w - pad * 2) / 12
  const y0 = h / 2
  const label = weeks.map((x) => `${x.weeksAgo === 0 ? 'This week' : `${x.weeksAgo} wk ago`}: ${clvText(x.avg)} over ${x.n}`).join('; ')
  return (
    <figure className="clv-trend">
      <figcaption className="small muted">Average CLV by week, last 12 weeks</figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        <line x1={pad} x2={w - pad} y1={y0} y2={y0} className="clv-trend__zero" />
        {weeks.map((x) => {
          const i = 11 - x.weeksAgo
          const bh = Math.max(1.5, (Math.abs(x.avg) / max) * (h / 2 - 6))
          return (
            <rect key={x.weeksAgo} x={pad + i * bw + 2} width={bw - 4} y={x.avg >= 0 ? y0 - bh : y0} height={bh} rx="2" className={x.avg >= 0 ? 'is-plus' : 'is-minus'}>
              <title>{`${x.weeksAgo === 0 ? 'This week' : `${x.weeksAgo} ${x.weeksAgo === 1 ? 'week' : 'weeks'} ago`}: ${clvText(x.avg)} average over ${x.n} ${x.n === 1 ? 'pick' : 'picks'}`}</title>
            </rect>
          )
        })}
      </svg>
    </figure>
  )
}

const LIMITS = [
  { key: 'picksDay', label: 'Picks a day', step: 1, min: 1, max: 20 },
  { key: 'unitsDay', label: 'Units staked a day', step: 0.5, min: 0.5, max: 200 },
  { key: 'unitsWeek', label: 'Units staked in 7 days', step: 0.5, min: 1, max: 1000 },
  { key: 'lossWeek', label: 'Units lost in 7 days', step: 0.5, min: 1, max: 1000 },
]

/** Limits on your own picks, a break, and self-exclusion. */
export function LimitsCard() {
  const [{ data, err }, set] = useLoad('/api/picks/me/rg')
  const [form, setForm] = useState(null)
  const [state, setState] = useState({ busy: false, err: null, msg: null })
  const [confirm, setConfirm] = useState(null)
  useEffect(() => {
    if (data) setForm(Object.fromEntries(LIMITS.map((l) => [l.key, data.limits?.[l.key] ?? ''])))
  }, [data])
  // arriving from "Limits and breaks" links: bring the card into view once it's there
  useEffect(() => {
    if (form && window.location.hash === '#limits') document.getElementById('limits')?.scrollIntoView({ block: 'start' })
  }, [Boolean(form)])
  if (err) return null
  if (!data || !form) return null
  const save = async (e) => {
    e.preventDefault()
    setState({ busy: true, err: null, msg: null })
    try {
      const out = await api('/api/picks/me/rg', { method: 'PUT', body: Object.fromEntries(LIMITS.map((l) => [l.key, form[l.key] === '' ? null : Number(form[l.key])])) })
      set(out)
      setState({ busy: false, err: null, msg: out.pending ? `Saved. Lower limits apply now; higher ones start ${new Date(out.pending.at).toLocaleString()}.` : 'Saved.' })
    } catch (er) {
      setState({ busy: false, err: er, msg: null })
    }
  }
  const pause = async (body) => {
    setState({ busy: true, err: null, msg: null })
    try {
      const out = await api('/api/picks/me/rg/pause', { method: 'POST', body })
      set(out)
      setConfirm(null)
      setState({ busy: false, err: null, msg: null })
    } catch (er) {
      setState({ busy: false, err: er, msg: null })
    }
  }
  const u = data.usage
  return (
    <section className="tool-card" id="limits" aria-labelledby="limits-title">
      <div className="tool-card__head">
        <h2 id="limits-title" className="tool-card__title">
          Limits and breaks
        </h2>
      </div>
      {data.pausedUntil && (
        <p className="rg-paused" role="status">
          {data.excludedUntil && data.excludedUntil >= data.pausedUntil ? 'You’ve excluded yourself from picks, tailing and contests' : 'You’re on a break from picks, tailing and contests'} until <b>{dateText(data.pausedUntil)}</b>. It can’t be ended early.
        </p>
      )}
      <p className="muted small">
        Today: {u.picksToday} {u.picksToday === 1 ? 'pick' : 'picks'}, {u.unitsToday} units. Last 7 days: {u.unitsWeek} units staked, {fmtUnits(u.netWeek)} net.
      </p>
      <form className="rg-form" onSubmit={save}>
        {LIMITS.map((l) => (
          <label key={l.key} className="field">
            <span>{l.label}</span>
            <input type="number" inputMode="decimal" min={l.min} max={l.max} step={l.step} placeholder="No limit" value={form[l.key]} onChange={(e) => setForm((f) => ({ ...f, [l.key]: e.target.value }))} />
          </label>
        ))}
        <div className="rg-form__foot">
          <button type="submit" className="btn btn--gold" disabled={state.busy}>
            Save limits
          </button>
          <span className="muted small">Lower limits apply at once. Raising or removing one takes 24 hours.</span>
        </div>
      </form>
      {data.pending && <p className="small">Waiting to apply: {LIMITS.filter((l) => data.pending.limits[l.key] !== data.limits[l.key]).map((l) => `${l.label.toLowerCase()} ${data.pending.limits[l.key] ?? 'no limit'}`).join(', ')} on {new Date(data.pending.at).toLocaleString()}.</p>}
      <div className="rg-pause">
        <p className="rg-pause__title">Take a break</p>
        <div className="row">
          {data.options.coolDays.map((d) => (
            <button key={d} type="button" className="btn btn--quiet btn--s" onClick={() => setConfirm({ kind: 'cool', days: d, text: `Take a ${d === 1 ? '24-hour' : `${d}-day`} break from posting picks, tailing and contests? It can’t be ended early.` })}>
              {d === 1 ? '24 hours' : `${d} days`}
            </button>
          ))}
        </div>
        <p className="rg-pause__title">Exclude yourself</p>
        <div className="row">
          {data.options.excludeMonths.map((m) => (
            <button key={m} type="button" className="btn btn--quiet btn--s" onClick={() => setConfirm({ kind: 'exclude', months: m, text: `Exclude yourself from picks, tailing and contests for ${m >= 12 ? `${m / 12} ${m === 12 ? 'year' : 'years'}` : `${m} months`}? It can’t be ended early.` })}>
              {m >= 12 ? `${m / 12} ${m === 12 ? 'year' : 'years'}` : `${m} months`}
            </button>
          ))}
        </div>
        {confirm && (
          <div className="rg-confirm" role="alertdialog" aria-label="Confirm">
            <p>{confirm.text}</p>
            <div className="row">
              <button type="button" className="btn btn--gold" disabled={state.busy} onClick={() => pause(confirm.kind === 'cool' ? { kind: 'cool', days: confirm.days } : { kind: 'exclude', months: confirm.months })}>
                Yes, start it
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {state.err && (
        <p className="form-err" role="alert">
          {state.err.message}
        </p>
      )}
      {state.msg && <p className="form-ok">{state.msg}</p>}
      <p className="small rg-help">
        Gambling problem? Call <a href="tel:18006973738">1-800-MY-RESET</a> or visit <a href="https://www.ncpgambling.org/help-treatment/" target="_blank" rel="noopener noreferrer">ncpgambling.org</a>. Sportsbooks run their own limits and self-exclusion, and most states have a self-exclusion list that covers every licensed book.
      </p>
    </section>
  )
}

/** Elite: who sees your subscriber picks before kickoff. */
export function SubscribersCard() {
  const [{ data, err }, set] = useLoad('/api/picks/me/subscribers')
  const [handle, setHandle] = useState('')
  const [state, setState] = useState({ busy: false, err: null })
  if (err || !data) return null
  const add = async (e) => {
    e.preventDefault()
    setState({ busy: true, err: null })
    try {
      set({ ...data, ...(await api('/api/picks/me/subscribers', { method: 'POST', body: { handle } })) })
      setHandle('')
      setState({ busy: false, err: null })
    } catch (er) {
      setState({ busy: false, err: er })
    }
  }
  const drop = async (h) => {
    try {
      set({ ...data, ...(await api(`/api/picks/me/subscribers/${encodeURIComponent(h)}`, { method: 'DELETE' })) })
    } catch (er) {
      setState({ busy: false, err: er })
    }
  }
  return (
    <section className="tool-card" aria-labelledby="subs-title">
      <div className="tool-card__head">
        <h2 id="subs-title" className="tool-card__title">
          Subscribers
        </h2>
        <span className="muted small">{data.subscribers.length}</span>
      </div>
      <p className="muted small">Picks you post as subscribers only show their legs to these people until kickoff. After that everyone sees them, so your record stays public.</p>
      <form className="row" onSubmit={add}>
        <div className="field__prefix">
          <span>@</span>
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="handle" aria-label="Subscriber handle" autoCapitalize="none" required />
        </div>
        <button type="submit" className="btn btn--quiet" disabled={state.busy}>
          Add
        </button>
      </form>
      {state.err && (
        <p className="form-err" role="alert">
          {state.err.message}
        </p>
      )}
      {data.subscribers.length > 0 && (
        <ul className="subs-list">
          {data.subscribers.map((s) => (
            <li key={s.handle}>
              <Link to={`/u/${s.handle}`}>@{s.handle}</Link>
              <span className="muted small">since {dateText(s.since)}</span>
              <button type="button" className="linkish is-minus" onClick={() => drop(s.handle)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminApi } from '../admin/adminApi.js'
import { useTitle } from '../lib/hooks.js'
import { Skeleton } from '../ui/Bits.jsx'
import { SPORTS } from '../lib/leagues.js'
import { UnitsLine } from '../admin/charts.jsx'
import { SeasonCalendar, SERIES, dayValue } from '../admin/Calendar.jsx'
import { EdgeFinder, Confidence } from '../admin/Edge.jsx'
import { Members, Money, Cell } from '../admin/People.jsx'
import { Tools } from '../admin/Tools.jsx'
import { ZERO, add, stats, standouts, pctTxt, signedPct, unitsTxt, record, money, compact, dayKey, shiftDay, dayLabel } from '../admin/numbers.js'

const PERIODS = [
  { key: 7, label: '7 days' },
  { key: 30, label: '30 days' },
  { key: 90, label: '90 days' },
  { key: 180, label: 'Season' },
]
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'edge', label: 'Edge finder' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'members', label: 'Members' },
  { key: 'money', label: 'Money' },
  { key: 'tools', label: 'Tools' },
]
const tabFromHash = () => {
  const h = (typeof window !== 'undefined' && window.location.hash.slice(1)) || ''
  return TABS.some((t) => t.key === h) ? h : 'overview'
}

/** The admin page: is the board making money at real prices, where, and how the business is doing. */
export function AdminPage() {
  // checking | locked | open | unset: the admin password is the only way in, checked by the server
  const [gate, setGate] = useState('checking')
  const [period, setPeriod] = useState(30)
  const [sport, setSport] = useState('')
  const [tab, setTab] = useState(tabFromHash)
  const [series, setSeries] = useState('all')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  useTitle('Admin')
  const to = dayKey(Date.now())
  const from = shiftDay(to, -(period - 1))
  useEffect(() => {
    adminApi('/api/admin/session')
      .then((s) => setGate(!s?.configured ? 'unset' : s.open ? 'open' : 'locked'))
      .catch(() => setGate('locked'))
  }, [])
  const locked = (e) => {
    if (e?.code !== 'admin_password') return false
    setData(null)
    setGate('locked')
    return true
  }
  const load = useCallback(() => {
    setBusy(true)
    setErr(null)
    return adminApi(`/api/admin/overview?from=${from}&to=${to}${sport ? `&sport=${sport}` : ''}`)
      .then(setData)
      .catch((e) => locked(e) || setErr(e.message))
      .finally(() => setBusy(false))
  }, [from, to, sport])
  useEffect(() => {
    if (gate === 'open') load()
  }, [gate, load])
  useEffect(() => {
    const on = () => setTab(tabFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const pickTab = (k) => {
    setTab(k)
    window.history.replaceState(null, '', k === 'overview' ? window.location.pathname : `#${k}`)
  }
  const runNow = async () => {
    setRunning(true)
    try {
      await adminApi('/api/admin/run', { method: 'POST', body: {} })
      await load()
    } catch (e) {
      if (!locked(e)) setErr(e.message)
    } finally {
      setRunning(false)
    }
  }
  const lockNow = async () => {
    await adminApi('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {})
    setData(null)
    setGate('locked')
  }

  if (gate === 'checking') return <div className="container page"><Skeleton rows={6} /></div>
  if (gate !== 'open') return <PasswordGate unset={gate === 'unset'} onOpen={() => setGate('open')} />
  return (
    <div className="container page adm">
      <header className="adm-head">
        <div>
          <h1 className="page-title">Admin</h1>
          <p className="page-sub">How the board does against real prices, where it makes money and where it leaks, and how the site is doing.</p>
        </div>
        <div className="adm-head__actions">
          <button type="button" className="btn btn--quiet adm-run" onClick={runNow} disabled={running}>
            {running ? 'Updating…' : 'Update now'}
          </button>
          <button type="button" className="btn btn--quiet adm-run" onClick={lockNow} title="Close the admin page on this device until the password is entered again">
            Lock
          </button>
        </div>
      </header>
      <nav className="adm-tabs" aria-label="Admin sections">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`adm-tabs__tab${tab === t.key ? ' is-on' : ''}`} aria-current={tab === t.key ? 'page' : undefined} onClick={() => pickTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      {(tab === 'overview' || tab === 'edge' || tab === 'calendar') && (
        <div className="adm-filters">
          {tab !== 'calendar' && (
            <div className="pills" role="group" aria-label="Period">
              {PERIODS.map((p) => (
                <button key={p.key} type="button" className={`pill${period === p.key ? ' is-on' : ''}`} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <label className="adm-select">
            <span className="sr-only">League</span>
            <select value={sport} onChange={(e) => setSport(e.target.value)}>
              <option value="">Every league</option>
              {SPORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          {tab !== 'calendar' && (
            <span className="adm-range muted">
              {dayLabel(from)} to {dayLabel(to)}
            </span>
          )}
        </div>
      )}
      {err && <p className="form-err">{err}</p>}
      {!data ? (
        <Skeleton rows={8} />
      ) : (
        <div className={`adm-body${busy ? ' is-loading' : ''}`}>
          {tab === 'overview' && <Overview data={data} series={series} onSeries={setSeries} goTo={pickTab} />}
          {tab === 'edge' && <EdgeFinder model={data.model} labels={data.labels} />}
          {tab === 'calendar' && <SeasonCalendar data={data} series={series} onSeries={setSeries} sport={sport} />}
          {tab === 'members' && <Members users={data.users} />}
          {tab === 'money' && <Money cash={data.money} users={data.users} />}
          {tab === 'tools' && <Tools data={data} onChanged={load} onLocked={locked} />}
        </div>
      )}
    </div>
  )
}

/** The lock screen: one password, checked by the server; a right one opens this device for 7 days. */
function PasswordGate({ unset, onOpen }) {
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    if (!pw.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      await adminApi('/api/admin/login', { method: 'POST', body: { password: pw } })
      setPw('')
      onOpen()
    } catch (e2) {
      setErr(e2.code === 'admin_password_wrong' ? 'That password isn’t right.' : e2.code === 'admin_locked' ? 'Too many wrong passwords. Try again in 15 minutes.' : e2.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="container page">
      <form className="adm-panel adm-gate" onSubmit={submit}>
        <h1 className="page-title">Admin</h1>
        <p>{unset ? 'The admin password isn’t set up on the server yet.' : 'Enter the admin password to open the dashboard.'}</p>
        {/* lets a password manager save and fill it */}
        <input className="sr-only" type="text" name="username" autoComplete="username" value="Propify admin" readOnly tabIndex={-1} aria-hidden="true" />
        <div className="field">
          <label htmlFor="adm-password">Password</label>
          <div className="adm-pw">
            <input
              id="adm-password"
              type={show ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={unset}
              aria-invalid={err ? 'true' : undefined}
              aria-describedby={err ? 'adm-password-err' : undefined}
              autoFocus
            />
            <button type="button" className="adm-pw__show" onClick={() => setShow(!show)} aria-pressed={show} disabled={unset}>
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {err && (
          <p className="form-err" id="adm-password-err" role="alert">
            {err}
          </p>
        )}
        <button type="submit" className="btn btn--gold btn--block" disabled={busy || unset || !pw.trim()}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
        <p className="adm-note">You stay unlocked on this device for 7 days, or until you press Lock.</p>
      </form>
    </div>
  )
}

function Overview({ data, series, onSeries, goTo }) {
  const leagues = Object.values(data.model?.leagues || {})
  const sum = (k) => leagues.reduce((a, l) => add(a, l[k]), ZERO)
  const all = stats(sum('all'))
  const seg = data.model?.seg || {}
  const moved = ['with', 'against', 'flat'].map((k) => stats(seg[`cl:${k}`]).n)
  const movedTotal = moved[0] + moved[1] + moved[2]
  const locks = (data.locks || []).filter((l) => l.status === 'graded')
  const lockRec = locks.reduce((o, l) => ({ w: o.w + (l.result === 'win' ? 1 : 0), l: o.l + (l.result === 'loss' ? 1 : 0), p: o.p + (l.result === 'push' ? 1 : 0), units: o.units + (l.profit || 0) }), { w: 0, l: 0, p: 0, units: 0 })
  const days = useMemo(() => {
    const out = []
    for (let d = data.range.from; d <= data.range.to; d = shiftDay(d, 1)) out.push(d)
    return out
  }, [data.range.from, data.range.to])
  const points = days.map((d) => {
    const v = dayValue(data, series, d)
    return { day: d, units: v?.units || 0, n: v ? v.w + v.l + v.p : 0, played: Boolean(v) }
  })
  const firstPlayed = points.findIndex((p) => p.played)
  const line = firstPlayed >= 0 ? points.slice(firstPlayed) : []
  const { up, down } = standouts(seg, data.labels, { min: 30 })
  const u = data.users
  const cash = data.money
  const status = Object.values(data.model?.status || {})
  const onFile = status.reduce((s, x) => s + (x.onFile || 0), 0)
  return (
    <div className="adm-overview">
      <div className="adm-strip adm-strip--6">
        <Cell big label="Profit per bet" value={all.risked ? signedPct(all.roi) : '–'} tone={all.roi > 0 ? 'plus' : all.roi < 0 ? 'minus' : null} sub={all.risked ? `${all.risked.toLocaleString()} priced bets, ${unitsTxt(all.units)}` : 'No graded bets in this range yet'} />
        <Cell label="Hit rate" value={pctTxt(all.hit)} sub={all.expected ? `the board said ${pctTxt(all.expected)}` : 'once games are graded'} />
        <Cell label="Price moved our way" value={movedTotal ? pctTxt(moved[0] / movedTotal, 0) : '–'} sub={movedTotal ? `of ${movedTotal.toLocaleString()} lines after we saw them` : 'shows sharp agreement'} />
        <Cell label="Members" value={u ? compact(u.total) : '–'} sub={u ? `+${u.new7} this week` : ''} />
        <Cell label="Revenue" value={cash ? money(cash.total) : '–'} sub={cash ? `${money(cash.month)} this month` : ''} />
        <Cell label="3-Leg Lock" value={locks.length ? record(lockRec) : '–'} sub={locks.length ? unitsTxt(lockRec.units, 2) : 'no graded locks yet'} />
      </div>

      {!all.n && (
        <section className="adm-panel adm-start">
          <h2 className="adm-h2">The board’s record starts now</h2>
          <p>
            Before every game, the side the board backs on each line is saved with its probability, the book’s price and the best price anywhere. After the game it’s graded from the box score. The first results land the morning after the next games,
            and the edge finder fills in as the bets pile up: a few hundred graded bets per slice before a number means much.
          </p>
          <p className="muted">{onFile ? `${onFile} game days on file so far, waiting on results.` : 'Nothing on file yet: the log starts the next time a league’s board loads.'}</p>
        </section>
      )}

      <section className="adm-section">
        <div className="adm-series" role="tablist" aria-label="Strategy">
          {SERIES.filter((s) => s.key !== 'crowd').map((s) => {
            const v = summaryOf(data, s.key)
            return (
              <button key={s.key} type="button" role="tab" aria-selected={series === s.key} className={`adm-series__tab${series === s.key ? ' is-on' : ''}`} onClick={() => onSeries(s.key)}>
                <span className="adm-series__name">{s.label}</span>
                <span className={`adm-series__u num ${v.units > 0 ? 'is-plus' : v.units < 0 ? 'is-minus' : ''}`}>{v.n ? unitsTxt(v.units) : '–'}</span>
                <span className="adm-series__rec muted">{v.n ? `${record(v)}${v.roi != null ? `, ${signedPct(v.roi)} a bet` : ''}` : 'nothing graded'}</span>
              </button>
            )
          })}
        </div>
        {line.length ? (
          <UnitsLine points={line} label={SERIES.find((s) => s.key === series)?.label} />
        ) : (
          <p className="adm-empty">No graded days for this one in the range yet.</p>
        )}
      </section>

      <div className="adm-split">
        <section className="adm-panel">
          <h2 className="adm-h2">Where it’s working</h2>
          {up.length ? <Standouts rows={up} /> : <p className="adm-empty">Nothing with 30+ priced bets is ahead yet.</p>}
        </section>
        <section className="adm-panel">
          <h2 className="adm-h2">Where it’s leaking</h2>
          {down.length ? <Standouts rows={down} /> : <p className="adm-empty">Nothing with 30+ priced bets is behind yet.</p>}
        </section>
      </div>
      <p className="adm-note">
        These are past results, not promises: even a real edge loses for weeks at a time, and books limit winning accounts. Bet what you can afford to lose.{' '}
        <button type="button" className="linkish" onClick={() => goTo('edge')}>
          Open the edge finder
        </button>
      </p>
    </div>
  )
}

function summaryOf(data, key) {
  const out = { units: 0, w: 0, l: 0, p: 0, n: 0, risked: 0 }
  if (key === 'all' || key === 'top' || key === 'edge') {
    const s = stats(Object.values(data.model?.leagues || {}).reduce((a, l) => add(a, l[key]), ZERO))
    return { ...out, ...s }
  }
  for (let d = data.range.from; d <= data.range.to; d = shiftDay(d, 1)) {
    const v = dayValue(data, key, d)
    if (!v) continue
    out.units += v.units
    out.w += v.w
    out.l += v.l
    out.p += v.p
    out.n += v.w + v.l + v.p
  }
  return { ...out, roi: null }
}

function Standouts({ rows }) {
  return (
    <ul className="adm-stand">
      {rows.map((r) => (
        <li key={r.key} className="adm-stand__row">
          <span className="adm-stand__name">
            <b>{r.name}</b>
            <span className="muted">
              {groupLabel(r.group)} · {record(r)} · hit {pctTxt(r.hit)} · {unitsTxt(r.units)}
            </span>
          </span>
          <span className="adm-stand__right">
            <span className={`adm-stand__roi num ${r.roi >= 0 ? 'is-plus' : 'is-minus'}`}>
              {signedPct(r.roi)}
              <small> a bet</small>
            </span>
            <Confidence s={r} />
          </span>
        </li>
      ))}
    </ul>
  )
}
const GROUP_LABEL = { m: 'Bet type', s: 'Side', pb: 'Probability', eb: 'Edge', ld: 'The read', mu: 'Matchup', pr: 'Price', bk: 'Book', sc: 'Score', h: 'Venue', cl: 'Line move' }
const groupLabel = (g) => GROUP_LABEL[g] || g

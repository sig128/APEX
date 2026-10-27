// The season wall: one tile per day with the units it made or lost for the chosen series
// (the board's leans, its top 10, edge 3+, the 3-Leg Lock, your own bets or everyone's), and
// the day's bets underneath when you open one.
import { useEffect, useMemo, useState } from 'react'
import { adminApi } from './adminApi.js'
import { odds, bookName } from '../lib/format.js'
import { stats, unitsTxt, record, dayKey, shiftDay, dayLong, pctTxt, signedPct, LEAGUE } from './numbers.js'

export const SERIES = [
  { key: 'all', label: 'Every lean', note: 'The board’s side on every line it priced, 1 unit each at the best price seen.' },
  { key: 'top', label: 'Top 10 a day', note: 'The 10 highest Propify scores each day.' },
  { key: 'edge', label: 'Edge 3+', note: 'Leans at least 3 points better than the book’s no-vig price.' },
  { key: 'lock', label: '3-Leg Lock', note: 'The lock in every league, at its posted stake.' },
  { key: 'mine', label: 'Your bets', note: 'What you posted on your picks page, graded from the box score.' },
  { key: 'crowd', label: 'Everyone’s picks', note: 'Every pick posted on the site.' },
]
const MODEL = new Set(['all', 'top', 'edge'])

/** One day's result for a series: { units, w, l, p, n } or null when nothing played. */
export function dayValue(data, series, day) {
  if (MODEL.has(series)) {
    const a = data.model?.days?.[day]?.[series]
    if (!a || !a[0]) return null
    const s = stats(a)
    return { units: s.units, w: s.w, l: s.l, p: s.p, n: s.n }
  }
  if (series === 'lock') {
    const list = (data.locks || []).filter((l) => l.day === day && l.status === 'graded')
    if (!list.length) return null
    return list.reduce((o, l) => ({ units: o.units + (l.profit || 0), w: o.w + (l.result === 'win' ? 1 : 0), l: o.l + (l.result === 'loss' ? 1 : 0), p: o.p + (l.result === 'push' ? 1 : 0), n: o.n + 1 }), { units: 0, w: 0, l: 0, p: 0, n: 0 })
  }
  const b = data.picks?.[series]?.[day]
  if (!b || !(b.w + b.l + b.p)) return null
  return { units: b.u, w: b.w, l: b.l, p: b.p, n: b.n }
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** Monday-first weeks covering a month: days as YYYY-MM-DD, null outside the month. */
function monthGrid(ym) {
  const first = new Date(`${ym}-01T12:00:00Z`)
  const lead = (first.getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  const cells = Array(lead).fill(null)
  for (let d = 1; d <= days; d++) cells.push(`${ym}-${String(d).padStart(2, '0')}`)
  while (cells.length % 7) cells.push(null)
  return cells
}
const addMonth = (ym, n) => {
  const d = new Date(`${ym}-15T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 7)
}

const monthEnd = (ym) => {
  const d = new Date(`${ym}-01T12:00:00Z`)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10)
}

export function SeasonCalendar({ data: loaded, series, onSeries, sport = '' }) {
  const today = dayKey(Date.now())
  const [month, setMonth] = useState(today.slice(0, 7))
  const [open, setOpen] = useState(null)
  const [paged, setPaged] = useState({})
  const [paging, setPaging] = useState(false)
  // the page loads the chosen period; a month outside it is fetched on its own (the board only)
  const start = `${month}-01`
  const end = monthEnd(month) < today ? monthEnd(month) : today
  const covered = loaded.range.from <= start && loaded.range.to >= end
  const pk = `${month}|${sport}|${loaded.at}`
  useEffect(() => {
    if (covered || paged[pk]) return undefined
    let live = true
    setPaging(true)
    adminApi(`/api/admin/overview?from=${start}&to=${end}${sport ? `&sport=${sport}` : ''}&parts=board`)
      .then((d) => live && setPaged((p) => ({ ...p, [pk]: d })))
      .catch(() => {})
      .finally(() => live && setPaging(false))
    return () => {
      live = false
    }
  }, [pk, covered])
  const data = useMemo(() => (covered || !paged[pk] ? loaded : { ...loaded, model: paged[pk].model }), [covered, paged, pk, loaded])
  const cells = useMemo(() => monthGrid(month), [month])
  const values = useMemo(() => Object.fromEntries(cells.filter(Boolean).map((d) => [d, dayValue(data, series, d)])), [cells, data, series])
  const maxAbs = Math.max(1, ...Object.values(values).filter(Boolean).map((v) => Math.abs(v.units)))
  const monthTotal = Object.values(values)
    .filter(Boolean)
    .reduce((o, v) => ({ units: o.units + v.units, w: o.w + v.w, l: o.l + v.l, p: o.p + v.p, days: o.days + 1, up: o.up + (v.units > 0 ? 1 : 0) }), { units: 0, w: 0, l: 0, p: 0, days: 0, up: 0 })
  const meta = SERIES.find((s) => s.key === series)
  useEffect(() => setOpen(null), [series, month])
  return (
    <div className="adm-cal">
      <div className="adm-cal__series pills-scroll" role="tablist" aria-label="What the calendar shows">
        {SERIES.map((s) => (
          <button key={s.key} type="button" role="tab" aria-selected={series === s.key} className={`pill${series === s.key ? ' is-on' : ''}`} onClick={() => onSeries(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="adm-note">{meta?.note}</p>
      <div className="adm-cal__head">
        <button type="button" className="icon-btn" onClick={() => setMonth(addMonth(month, -1))} aria-label="Previous month">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path d="M12.5 4.5L7 10l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h3 className="adm-cal__month">{monthFmt.format(new Date(`${month}-15T12:00:00Z`))}</h3>
        <button type="button" className="icon-btn" onClick={() => setMonth(addMonth(month, 1))} aria-label="Next month" disabled={month >= today.slice(0, 7)}>
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path d="M7.5 4.5L13 10l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <p className="adm-cal__total">
          {monthTotal.days ? (
            <>
              <b className={`num ${monthTotal.units >= 0 ? 'is-plus' : 'is-minus'}`}>{unitsTxt(monthTotal.units)}</b>
              <span className="muted">
                {' '}
                {record(monthTotal)} · {monthTotal.up} of {monthTotal.days} days up
              </span>
            </>
          ) : (
            <span className="muted">Nothing graded this month yet</span>
          )}
        </p>
      </div>
      <div className={`adm-cal__grid${paging && !covered && MODEL.has(series) ? ' is-loading' : ''}`} role="grid" aria-label={`${meta?.label} by day`} aria-busy={paging && !covered}>
        {WEEK.map((w) => (
          <div key={w} className="adm-cal__dow" role="columnheader">
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`x${i}`} className="adm-cal__cell is-out" aria-hidden="true" />
          const v = values[d]
          const strength = v ? Math.min(1, Math.abs(v.units) / maxAbs) : 0
          const tone = !v ? '' : v.units > 0.0001 ? 'is-up' : v.units < -0.0001 ? 'is-down' : 'is-flat'
          const label = v ? `${dayLong(d)}: ${unitsTxt(v.units)}, ${record(v)}` : `${dayLong(d)}: nothing graded`
          return (
            <button
              key={d}
              type="button"
              role="gridcell"
              className={`adm-cal__cell ${tone}${d === today ? ' is-today' : ''}${d > today ? ' is-future' : ''}${open === d ? ' is-open' : ''}`}
              style={v ? { '--wash': (0.12 + strength * 0.5).toFixed(3) } : undefined}
              onClick={() => setOpen(open === d ? null : d)}
              aria-label={label}
              aria-expanded={open === d}
              disabled={!v && d > today}
            >
              <span className="adm-cal__day num">{Number(d.slice(8))}</span>
              {v && (
                <>
                  <span className="adm-cal__u num">{unitsTxt(v.units)}</span>
                  <span className="adm-cal__wl num">{record(v)}</span>
                </>
              )}
            </button>
          )
        })}
      </div>
      {open && <DayDetail key={`${open}|${series}`} data={data} series={series} day={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

const RES = { w: 'Won', l: 'Lost', p: 'Push', v: 'Void', win: 'Won', loss: 'Lost', push: 'Push', void: 'Void' }
const resKey = (r) => (r === 'w' || r === 'win' ? 'w' : r === 'l' || r === 'loss' ? 'l' : r === 'p' || r === 'push' ? 'p' : 'v')

function sideText(r) {
  if (r.side === 'y') return r.marketLabel
  return `${r.side === 'u' ? 'Under' : 'Over'} ${r.line} ${r.marketLabel}`
}

/** The bets behind one tile. */
function DayDetail({ data, series, day, onClose }) {
  const v = dayValue(data, series, day)
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)
  const [more, setMore] = useState(false)
  const leagues = data.model?.days?.[day]?.leagues || []
  useEffect(() => {
    if (!MODEL.has(series)) return undefined
    let live = true
    setRows(null)
    setErr(null)
    Promise.all(leagues.map((s) => adminApi(`/api/admin/day?sport=${s}&day=${day}`).then((d) => d.rows.map((r) => ({ ...r, sport: s }))).catch(() => [])))
      .then((all) => live && setRows(all.flat()))
      .catch((e) => live && setErr(e.message))
    return () => {
      live = false
    }
  }, [day, series, leagues.join(',')])

  let list = null
  if (MODEL.has(series) && rows) {
    let graded = rows.filter((r) => r.res && r.res !== 'v').sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.p ?? 0) - (a.p ?? 0))
    if (series === 'top') {
      // the top 10 is per league, the way each day was scored
      const by = {}
      graded = graded.filter((r) => ((by[r.sport] = (by[r.sport] || 0) + 1), by[r.sport] <= 10))
    }
    if (series === 'edge') graded = graded.filter((r) => Number.isFinite(r.edge) && r.edge >= 0.03 && (Number.isFinite(r.best) || Number.isFinite(r.price)))
    list = graded
  }
  const locks = series === 'lock' ? (data.locks || []).filter((l) => l.day === day) : null
  const mine = series === 'mine' ? (data.picks?.myPicks || []).filter((p) => dayKey(p.lockAt || p.at) === day) : null
  return (
    <section className="adm-day" aria-label={`Bets on ${dayLong(day)}`}>
      <header className="adm-day__head">
        <div>
          <h3 className="adm-day__title">{dayLong(day)}</h3>
          {v && (
            <p className="adm-day__sum">
              <b className={`num ${v.units >= 0 ? 'is-plus' : 'is-minus'}`}>{unitsTxt(v.units, 2)}</b> <span className="muted">{record(v)}</span>
            </p>
          )}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the day">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      {MODEL.has(series) && !rows && !err && <p className="muted">Loading the day’s bets…</p>}
      {err && <p className="form-err">{err}</p>}
      {list && !list.length && <p className="muted">No graded bets in this series that day.</p>}
      {list && list.length > 0 && (
        <ul className="adm-bets">
          {list.slice(0, more ? 80 : 20).map((r) => {
            const price = Number.isFinite(r.best) ? r.best : r.price
            return (
              <li key={`${r.sport}:${r.id}`} className={`adm-bet is-${resKey(r.res)}`}>
                <span className="adm-bet__res" aria-hidden="true">
                  {resKey(r.res) === 'w' ? 'W' : resKey(r.res) === 'l' ? 'L' : 'P'}
                </span>
                <span className="adm-bet__what">
                  <b>{r.name}</b> <span className="muted">{[r.team, r.opp && `vs ${r.opp}`, LEAGUE[r.sport]].filter(Boolean).join(' ')}</span>
                  <span className="adm-bet__line">
                    {sideText(r)}
                    {r.val != null && <span className="muted"> · went {r.val}</span>}
                  </span>
                </span>
                <span className="adm-bet__nums num">
                  <span>{pctTxt(r.p, 0)}</span>
                  <span className="muted">{Number.isFinite(price) ? `${odds(price)}${r.book ? ` ${bookName(r.book)}` : ''}` : 'no price'}</span>
                  {Number.isFinite(r.edge) && <span className="muted">edge {signedPct(r.edge, 1)}</span>}
                </span>
                <span className="sr-only">{RES[r.res]}</span>
              </li>
            )
          })}
        </ul>
      )}
      {list && list.length > 20 && (
        <p className="adm-day__more">
          <span className="muted small">
            The {Math.min(list.length, more ? 80 : 20)} highest scores of {list.length}.
          </span>
          {!more && (
            <button type="button" className="btn btn--quiet btn--s" onClick={() => setMore(true)}>
              Show {Math.min(list.length, 80) - 20} more
            </button>
          )}
        </p>
      )}
      {locks && (
        <ul className="adm-bets">
          {locks.map((l) => (
            <li key={`${l.sport}:${l.key}`} className={`adm-bet is-${resKey(l.result)}`}>
              <span className="adm-bet__res" aria-hidden="true">
                {resKey(l.result) === 'w' ? 'W' : resKey(l.result) === 'l' ? 'L' : l.status === 'live' ? '…' : 'P'}
              </span>
              <span className="adm-bet__what">
                <b>{LEAGUE[l.sport]} 3-Leg Lock</b>
                {l.legs.map((g, i) => (
                  <span key={i} className="adm-bet__line">
                    {g.result ? `${RES[g.result]}: ` : ''}
                    {g.name} {g.label}
                  </span>
                ))}
              </span>
              <span className="adm-bet__nums num">
                <span>{l.price != null ? odds(l.price) : ''}</span>
                <span className="muted">{l.profit != null ? unitsTxt(l.profit, 2) : l.status}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {mine && (
        <ul className="adm-bets">
          {mine.map((p) => (
            <li key={p.id} className={`adm-bet is-${resKey(p.result)}`}>
              <span className="adm-bet__res" aria-hidden="true">
                {p.status === 'open' ? '…' : resKey(p.result) === 'w' ? 'W' : resKey(p.result) === 'l' ? 'L' : 'P'}
              </span>
              <span className="adm-bet__what">
                <b>{p.legs.length > 1 ? `${p.legs.length}-leg parlay` : p.legs[0]?.name}</b>
                {p.legs.map((g, i) => (
                  <span key={i} className="adm-bet__line">
                    {p.legs.length > 1 && g.result ? `${RES[g.result]}: ` : ''}
                    {p.legs.length > 1 ? `${g.name} ` : ''}
                    {g.label}
                  </span>
                ))}
              </span>
              <span className="adm-bet__nums num">
                <span>{odds(p.price)}</span>
                <span className="muted">{p.profit != null ? unitsTxt(p.profit, 2) : `${p.units}u open`}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {series === 'crowd' && v && <p className="muted">{v.n} picks played that day. Each member’s page has their own record.</p>}
    </section>
  )
}

export { shiftDay }

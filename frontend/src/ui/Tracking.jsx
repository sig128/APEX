import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { HelpTip } from './HelpTip.jsx'

// Tracking: your graded picks as a running P&L line, your record, and trends by leg count,
// league and market. Descriptive: wins and losses alike, every group with its sample size,
// small samples marked. Members see the line and the trends; everyone sees their record.

const RANGES = [
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
]
const sign = (x, d = 1) => (x == null ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`)
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`)
const odds = (a) => (a == null ? '–' : a > 0 ? `+${a}` : `${a}`)
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** The running total, one point a day. A single series: no legend, the title names it. */
function PnlChart({ series }) {
  const [hover, setHover] = useState(null)
  const box = useRef(null)
  const W = 640
  const H = 220
  const P = { l: 44, r: 12, t: 14, b: 26 }
  const pts = useMemo(() => [{ day: null, cum: 0 }, ...series], [series])
  const ys = pts.map((p) => p.cum)
  const lo = Math.min(0, ...ys)
  const hi = Math.max(0, ...ys)
  const pad = Math.max(1, (hi - lo) * 0.1)
  const y0 = lo - pad
  const y1 = hi + pad
  const x = (i) => P.l + (i / Math.max(1, pts.length - 1)) * (W - P.l - P.r)
  const y = (v) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b)
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join('')
  const area = `${path}L${x(pts.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`
  // four quiet gridlines at round numbers
  const step = niceStep((y1 - y0) / 4)
  const ticks = []
  for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) ticks.push(Math.round(v * 100) / 100)
  const move = (e) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const px = ((e.clientX - r.left) / r.width) * W
    const i = Math.max(1, Math.min(pts.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (pts.length - 1))))
    setHover(i)
  }
  const h = hover != null ? pts[hover] : null
  const last = pts[pts.length - 1]
  return (
    <div className="pnl">
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} className="pnl__svg" role="img" aria-label={`Running total over ${series.length} days, ending at ${sign(last.cum)} units`} onPointerMove={move} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="pnl-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--lime)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--lime)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className={v === 0 ? 'pnl__zero' : 'pnl__grid'} />
            <text x={P.l - 8} y={y(v) + 4} className="pnl__tick" textAnchor="end">
              {v === 0 ? '0' : `${sign(v, Number.isInteger(v) ? 0 : 1)}u`}
            </text>
          </g>
        ))}
        <path d={area} fill="url(#pnl-fill)" />
        <path d={path} className="pnl__line" />
        {series.length > 0 && (
          <>
            <text x={x(1)} y={H - 6} className="pnl__tick" textAnchor="start">
              {dayText(series[0].day)}
            </text>
            <text x={x(pts.length - 1)} y={H - 6} className="pnl__tick" textAnchor="end">
              {dayText(series[series.length - 1].day)}
            </text>
          </>
        )}
        {h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} className="pnl__cross" />
            <circle cx={x(hover)} cy={y(h.cum)} r="5" className="pnl__dot" />
          </g>
        )}
        <rect x={P.l} y={P.t} width={W - P.l - P.r} height={H - P.t - P.b} fill="transparent" />
      </svg>
      {h && (
        <div className="pnl__tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
          <b>{dayText(h.day)}</b>
          <span>
            Total <b className="num">{sign(h.cum)}u</b>
          </span>
          <span>
            That day {sign(h.units)}u, {h.w}-{h.l}
          </span>
        </div>
      )}
    </div>
  )
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 0.01)))
  const n = raw / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

function Trend({ title, rows, legs = false }) {
  if (!rows?.length) return null
  return (
    <div className="trend">
      <p className="trend__h">{title}</p>
      <table className="trend__t">
        <thead>
          <tr>
            <th scope="col">{legs ? 'Market' : 'Group'}</th>
            <th scope="col">{legs ? 'Legs' : 'Picks'}</th>
            <th scope="col">W-L</th>
            <th scope="col">Hit</th>
            {!legs && <th scope="col">Units</th>}
            {!legs && <th scope="col">ROI</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.small ? 'is-small' : ''}>
              <th scope="row">
                {r.label}
                {r.small && <span className="trend__small">small sample</span>}
              </th>
              <td className="num">{r.picks}</td>
              <td className="num">
                {r.w}-{r.l}
                {r.p ? `-${r.p}` : ''}
              </td>
              <td className="num">{pct(r.hit)}</td>
              {!legs && <td className={`num${r.units > 0 ? ' is-plus' : r.units < 0 ? ' is-minus' : ''}`}>{sign(r.units)}</td>}
              {!legs && <td className="num">{r.roi == null ? '–' : sign(r.roi * 100, 0) + '%'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function TrackingCard() {
  const [range, setRange] = useState('30d')
  const { data, error } = useApi(`/api/picks/me/tracking?range=${range}`, { maxAgeMs: 60_000 })
  const r = data?.record
  return (
    <section className="tool-card track" aria-labelledby="track-h">
      <div className="track__head">
        <h2 id="track-h" className="tool-card__title">
          Your tracking
        </h2>
        <div className="seg seg--s" role="group" aria-label="Range">
          {RANGES.map(([k, label]) => (
            <button key={k} type="button" className={range === k ? 'is-on' : ''} aria-pressed={range === k} onClick={() => setRange(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="form-err">{error.message}</p>}
      {!data && !error && <p className="muted small">Loading your record…</p>}
      {r && (
        <>
          <dl className="track__tiles">
            <div>
              <dt>Record</dt>
              <dd className="num">
                {r.w}-{r.l}
                {r.p ? `-${r.p}` : ''}
              </dd>
            </div>
            <div>
              <dt>Hit rate</dt>
              <dd className="num">{pct(r.hit)}</dd>
            </div>
            <div>
              <dt>
                Units <HelpTip id="unit" label="units" />
              </dt>
              <dd className={`num${r.units > 0 ? ' is-plus' : r.units < 0 ? ' is-minus' : ''}`}>{sign(r.units)}</dd>
            </div>
            <div>
              <dt>ROI</dt>
              <dd className="num">{r.roi == null ? '–' : `${sign(r.roi * 100, 0)}%`}</dd>
            </div>
            <div>
              <dt>Avg odds</dt>
              <dd className="num">{odds(r.avgOdds)}</dd>
            </div>
            <div>
              <dt>Streak</dt>
              <dd className="num">{data.streak ? `${data.streak.kind === 'win' ? 'W' : 'L'}${data.streak.n}` : '–'}</dd>
            </div>
          </dl>
          {r.picks === 0 && <p className="muted small">No graded picks in this range yet. Post picks from your slip and they grade themselves.</p>}
          {data.locked ? (
            <div className="track__locked">
              <div className="track__ghost" aria-hidden="true" />
              <div className="track__unlock">
                <p>
                  <b>Your P&amp;L line and trends</b> by leg count, league and market are part of Pro.
                </p>
                <Link to="/pricing" className="btn btn--lime btn--s">
                  See Pro
                </Link>
              </div>
            </div>
          ) : (
            r.picks > 0 && (
              <>
                <PnlChart series={data.series} />
                {data.last10?.length > 0 && (
                  <p className="track__last">
                    Last {data.last10.length}:{' '}
                    {data.last10.map((x, i) => (
                      <span key={i} className={`track__dot is-${x}`} aria-label={x === 'win' ? 'won' : 'lost'}>
                        {x === 'win' ? 'W' : 'L'}
                      </span>
                    ))}
                  </p>
                )}
                <div className="track__trends">
                  <Trend title="By leg count" rows={data.byLegs} />
                  <Trend title="By league" rows={data.bySport} />
                  <Trend title="Legs by market" rows={data.byMarket} legs />
                </div>
                <p className="muted small">Wins and losses alike. With fewer than {data.small} decided picks a pattern is mostly noise, so those rows are marked.</p>
                <details className="track__table">
                  <summary>The line as a table</summary>
                  <table className="trend__t">
                    <thead>
                      <tr>
                        <th scope="col">Day</th>
                        <th scope="col">W-L</th>
                        <th scope="col">Units</th>
                        <th scope="col">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.series.map((d) => (
                        <tr key={d.day}>
                          <th scope="row">{dayText(d.day)}</th>
                          <td className="num">
                            {d.w}-{d.l}
                          </td>
                          <td className="num">{sign(d.units)}</td>
                          <td className="num">{sign(d.cum)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </>
            )
          )}
        </>
      )}
    </section>
  )
}

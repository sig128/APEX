// The admin page's three charts, drawn by hand in SVG: the running total of units, columns
// for counts and money, and the board's calibration. One series each, in gold; won and lost
// show in turf and flag only with a signed number beside them. Every chart has a hover
// readout, and the same numbers sit in a table or list next to it.
import { useState } from 'react'
import { useWidth } from '../lib/hooks.js'
import { dayLabel, unitsTxt, pctTxt } from './numbers.js'

/** Round, readable ticks covering lo..hi (about `count` of them). */
export function ticks(lo, hi, count = 4) {
  if (!(hi > lo)) return [lo]
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

function Tip({ x, y, w, children }) {
  if (x == null) return null
  const left = Math.min(Math.max(8, x + 12), w - 168)
  return (
    <div className="adm-tip" style={{ left, top: Math.max(0, y - 8) }} role="status">
      {children}
    </div>
  )
}

/** Running units over the days, from 0. points: [{ day, units, n }] oldest first. */
export function UnitsLine({ points, height = 220, label = 'Running total' }) {
  const [ref, W] = useWidth(640)
  const [hover, setHover] = useState(null)
  const pad = { t: 16, r: 56, b: 28, l: 44 }
  let run = 0
  const series = points.map((p) => ({ ...p, cum: (run += p.units || 0) }))
  if (!series.length) return null
  const vals = [0, ...series.map((p) => p.cum)]
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const span = hi - lo || 1
  const ys = ticks(lo - span * 0.08, hi + span * 0.08, 4)
  const y0 = Math.min(ys[0], lo)
  const y1 = Math.max(ys[ys.length - 1], hi)
  const iw = Math.max(10, W - pad.l - pad.r)
  const ih = height - pad.t - pad.b
  const x = (i) => pad.l + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw)
  const y = (v) => pad.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.cum).toFixed(1)}`).join('')
  const area = `${line}L${x(series.length - 1).toFixed(1)} ${y(0).toFixed(1)}L${x(0).toFixed(1)} ${y(0).toFixed(1)}Z`
  const last = series[series.length - 1]
  const tickDays = series.length <= 2 ? series.map((_, i) => i) : [0, Math.round((series.length - 1) / 2), series.length - 1]
  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - box.left
    const i = series.length === 1 ? 0 : Math.round(((px - pad.l) / iw) * (series.length - 1))
    setHover(Math.max(0, Math.min(series.length - 1, i)))
  }
  const h = hover != null ? series[hover] : null
  return (
    <figure className="adm-chart" ref={ref}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`${label}: ${unitsTxt(last.cum)} over ${series.length} days`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ys.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className={v === 0 ? 'adm-axis' : 'adm-grid'} />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="adm-tick">
              {v > 0 ? '+' : ''}
              {v}
            </text>
          </g>
        ))}
        {tickDays.map((i) => (
          <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'} className="adm-tick">
            {dayLabel(series[i].day)}
          </text>
        ))}
        <path d={area} className="adm-area" />
        <path d={line} className="adm-line" />
        {h && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="adm-cross" />}
        {h && <circle cx={x(hover)} cy={y(h.cum)} r={4.5} className="adm-dot" />}
        <circle cx={x(series.length - 1)} cy={y(last.cum)} r={4.5} className="adm-dot" />
        <text x={x(series.length - 1) + 10} y={y(last.cum) + 5} className="adm-endlabel">
          {unitsTxt(last.cum)}
        </text>
      </svg>
      <Tip x={h ? x(hover) : null} y={h ? y(h.cum) : 0} w={W}>
        {h && (
          <>
            <b className="num">{unitsTxt(h.cum)}</b> after {dayLabel(h.day)}
            <span className="adm-tip__sub">
              That day {unitsTxt(h.units)}
              {h.n ? ` on ${h.n} bets` : ''}
            </span>
          </>
        )}
      </Tip>
    </figure>
  )
}

/** Columns from one baseline: [{ key, label, value, sub }]. */
export function Columns({ data, height = 160, format = (v) => String(v), label }) {
  const [ref, W] = useWidth(640)
  const [hover, setHover] = useState(null)
  const pad = { t: 18, r: 8, b: 24, l: 8 }
  if (!data.length) return null
  const max = Math.max(1, ...data.map((d) => d.value))
  const iw = W - pad.l - pad.r
  const ih = height - pad.t - pad.b
  const slot = iw / data.length
  // thin columns with air between them (never wider than 24px)
  const bw = Math.max(2, Math.min(24, slot * 0.62))
  const y = (v) => pad.t + ih - (v / max) * ih
  const peak = data.reduce((b, d, i) => (d.value > data[b].value ? i : b), 0)
  const every = Math.ceil(data.length / 6)
  return (
    <figure className="adm-chart" ref={ref}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
        <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} className="adm-axis" />
        {data.map((d, i) => {
          const cx = pad.l + slot * i + slot / 2
          const top = y(d.value)
          const hgt = pad.t + ih - top
          const r = Math.min(4, bw / 2, hgt)
          // a 4px rounded top, square at the baseline
          const path = d.value > 0 ? `M${cx - bw / 2} ${pad.t + ih}V${top + r}Q${cx - bw / 2} ${top} ${cx - bw / 2 + r} ${top}H${cx + bw / 2 - r}Q${cx + bw / 2} ${top} ${cx + bw / 2} ${top + r}V${pad.t + ih}Z` : null
          return (
            <g key={d.key} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${d.label}: ${format(d.value)}`}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              {path && <path d={path} className={`adm-col${hover === i ? ' is-hover' : ''}`} />}
              {i === peak && d.value > 0 && (
                <text x={cx} y={top - 6} textAnchor="middle" className="adm-tick adm-tick--strong">
                  {format(d.value)}
                </text>
              )}
              {(i % every === 0 || i === data.length - 1) && (
                <text x={cx} y={height - 7} textAnchor="middle" className="adm-tick">
                  {d.short || d.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <Tip x={hover != null ? pad.l + slot * hover + slot / 2 : null} y={hover != null ? y(data[hover].value) : 0} w={W}>
        {hover != null && (
          <>
            <b className="num">{format(data[hover].value)}</b> {data[hover].label}
            {data[hover].sub && <span className="adm-tip__sub">{data[hover].sub}</span>}
          </>
        )}
      </Tip>
    </figure>
  )
}

/**
 * Calibration: what the board said (across) against how often it hit (up). On the diagonal,
 * a 65% call hits 65% of the time. rows: [{ key, name, expected, hit, w, l }].
 */
export function Calibration({ rows, height = 260 }) {
  const [ref, W] = useWidth(420)
  const [hover, setHover] = useState(null)
  const pts = rows.filter((r) => Number.isFinite(r.expected) && Number.isFinite(r.hit) && r.w + r.l > 0)
  if (!pts.length) return null
  const pad = { t: 14, r: 14, b: 34, l: 42 }
  const lo = 0.4
  const hi = 1
  const size = Math.min(W - pad.l - pad.r, height - pad.t - pad.b)
  const x = (v) => pad.l + ((v - lo) / (hi - lo)) * size
  const y = (v) => pad.t + size - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * size
  const grid = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
  const h = hover != null ? pts[hover] : null
  return (
    <figure className="adm-chart adm-chart--square" ref={ref}>
      <svg width={W} height={size + pad.t + pad.b} viewBox={`0 0 ${W} ${size + pad.t + pad.b}`} role="img" aria-label="Calibration: the probability the board gave against how often it hit">
        {grid.map((v) => (
          <g key={v}>
            <line x1={x(lo)} x2={x(hi)} y1={y(v)} y2={y(v)} className="adm-grid" />
            <line x1={x(v)} x2={x(v)} y1={y(lo)} y2={y(hi)} className="adm-grid" />
            <text x={x(lo) - 8} y={y(v) + 4} textAnchor="end" className="adm-tick">
              {Math.round(v * 100)}
            </text>
            <text x={x(v)} y={y(lo) + 16} textAnchor="middle" className="adm-tick">
              {Math.round(v * 100)}
            </text>
          </g>
        ))}
        <line x1={x(lo)} y1={y(lo)} x2={x(hi)} y2={y(hi)} className="adm-ref" />
        <text x={x(hi) - 4} y={y(hi) + 14} textAnchor="end" className="adm-tick">
          right on
        </text>
        <text x={x(0.7)} y={y(lo) + 30} textAnchor="middle" className="adm-tick">
          what the board said (%)
        </text>
        {pts.map((p, i) => (
          <g key={p.key} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${p.name}: hit ${pctTxt(p.hit)} of ${p.w + p.l}`}>
            <circle cx={x(p.expected)} cy={y(p.hit)} r={14} fill="transparent" />
            <circle cx={x(p.expected)} cy={y(p.hit)} r={5} className={`adm-dot${hover === i ? ' is-hover' : ''}`} />
          </g>
        ))}
      </svg>
      <Tip x={h ? x(h.expected) : null} y={h ? y(h.hit) : 0} w={W}>
        {h && (
          <>
            <b className="num">{pctTxt(h.hit)}</b> hit, board said {pctTxt(h.expected)}
            <span className="adm-tip__sub">
              {h.name}: {h.w}-{h.l}
            </span>
          </>
        )}
      </Tip>
    </figure>
  )
}

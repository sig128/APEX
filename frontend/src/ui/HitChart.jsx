import { useMemo, useState } from 'react'
import { shortDate } from '../lib/format.js'
import { useWidth } from '../lib/hooks.js'

const COLOR = { hit: 'var(--turf)', miss: 'var(--flag)', push: 'var(--push)' }

/**
 * The last games against the line: one floodlit column per game, the line in chalk across it.
 * games: [{ v, o: 'hit' | 'miss' | 'push', opp, home, date }] oldest first.
 */
export function HitChart({ games, line, side = 'o', label, height = 210, oneSided = false }) {
  const [ref, W] = useWidth(640)
  const [hover, setHover] = useState(null)
  const list = games || []
  const n = list.length
  const geo = useMemo(() => {
    const vals = list.map((g) => (Number.isFinite(g.v) ? g.v : 0))
    const top = Math.max(oneSided ? 2.2 : line * 1.3, ...vals, line + 1) * 1.1
    const padT = 24
    const padB = 28
    const padR = 40 // room for the line's tag
    const plot = height - padT - padB
    const step = (W - padR) / Math.max(1, n)
    const bw = Math.max(6, Math.min(34, step * 0.62))
    const y = (v) => padT + plot - (Math.max(0, v) / top) * plot
    return { padT, padB, plot, step, bw, y }
  }, [list, line, height, n, oneSided, W])
  if (!n) return <p className="muted">No games to chart yet.</p>
  const hits = list.filter((g) => g.o === 'hit').length
  const decided = list.filter((g) => g.o === 'hit' || g.o === 'miss').length
  const ly = geo.y(line)
  const words = `${label || 'Recent games'}: ${hits} of ${decided} ${oneSided ? 'with a touchdown' : `${side === 'u' ? 'under' : 'over'} ${line}`}`
  const showX = geo.step >= 22
  // on a phone ten bars leave no room for "@UTA@BUF"; the tooltip still says home or away
  const showAt = geo.step >= 32
  return (
    <figure className="hit-chart" ref={ref}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={words} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="hc-flood" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
            <stop offset="0.22" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {list.map((g, i) => {
          const x = i * geo.step + (geo.step - geo.bw) / 2
          const v = Number.isFinite(g.v) ? g.v : 0
          const top = Math.min(geo.padT + geo.plot - 2, geo.y(v))
          const h = geo.padT + geo.plot - top
          const dim = hover != null && hover !== i
          return (
            <g key={`${g.date}-${i}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} style={{ opacity: dim ? 0.45 : 1 }}>
              <rect x={i * geo.step} y={0} width={geo.step} height={height} fill="transparent" />
              <rect x={x} y={top} width={geo.bw} height={h} rx={3} fill={COLOR[g.o] || 'var(--seat-2)'} />
              <rect x={x} y={top} width={geo.bw} height={Math.min(h, 26)} rx={3} fill="url(#hc-flood)" />
              {geo.bw >= 14 && (
                <text x={x + geo.bw / 2} y={top - 7} textAnchor="middle" className="hit-chart__v">
                  {v}
                </text>
              )}
              {showX && (
                <text x={x + geo.bw / 2} y={height - 9} textAnchor="middle" className="hit-chart__x">
                  {g.home || !showAt ? '' : '@'}
                  {g.opp}
                </text>
              )}
            </g>
          )
        })}
        <line x1={0} x2={W} y1={ly} y2={ly} className="hit-chart__line" />
      </svg>
      <span className="hit-chart__tag num" style={{ top: ly }}>
        {oneSided ? 'TD' : line}
      </span>
      {hover != null && list[hover] && (
        <figcaption className="hit-chart__tip" style={{ left: Math.min(W - 70, Math.max(70, (hover + 0.5) * geo.step)) }}>
          <b className="num">{list[hover].v}</b> {list[hover].home ? 'vs' : 'at'} {list[hover].opp}
          <span>{shortDate(list[hover].date)}</span>
        </figcaption>
      )}
    </figure>
  )
}

/** Ten tiny bars for list rows. spark: [[value, 1 hit | 2 push | 0 miss], ...] */
export function Spark({ spark, line, width = 92, height = 26 }) {
  if (!spark?.length) return <span className="spark spark--empty" style={{ width, height }} />
  const vals = spark.map(([v]) => (Number.isFinite(v) ? v : 0))
  const top = Math.max(line * 1.4, ...vals, line + 1)
  const step = width / spark.length
  const bw = Math.max(3, step * 0.62)
  const y = (v) => height - (Math.max(0, v) / top) * height
  const ly = y(line)
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {spark.map(([v, f], i) => {
        const yy = Math.min(height - 2, y(v))
        return <rect key={i} x={i * step + (step - bw) / 2} y={yy} width={bw} height={height - yy} rx={1.5} fill={f === 1 ? 'var(--turf)' : f === 2 ? 'var(--push)' : 'var(--flag)'} />
      })}
      <line x1={0} x2={width} y1={ly} y2={ly} stroke="var(--chalk)" strokeOpacity="0.75" strokeDasharray="2 2" strokeWidth="1" />
    </svg>
  )
}

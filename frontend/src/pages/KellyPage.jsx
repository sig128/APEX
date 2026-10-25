import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { simulate, kellyFraction } from '../lib/kelly.js'
import { decimalOf, parseOdds, pct, odds } from '../lib/format.js'
import { useTitle, useWidth } from '../lib/hooks.js'
import { useSlip } from '../lib/useSlip.js'
import { parlayMath } from '../lib/slip.js'
import { Locked } from '../ui/Locked.jsx'

const MULTS = [
  { k: 0.25, label: 'Quarter Kelly' },
  { k: 0.5, label: 'Half Kelly' },
  { k: 1, label: 'Full Kelly' },
]

/** How a bankroll grows (or doesn't) when you bet an edge again and again at a Kelly stake. */
export function KellyPage() {
  useTitle('Kelly calculator and simulator')
  const [q] = useSearchParams()
  const slip = useSlip()
  const fromSlip = slip.legs.length ? parlayMath(slip.legs, slip.parlayPrice) : null
  const [p, setP] = useState(() => String(Math.round((Number(q.get('p')) || 0.56) * 1000) / 10))
  const [price, setPrice] = useState(() => {
    const o = Number(q.get('odds'))
    return Number.isFinite(o) && Math.abs(o) >= 100 ? (o > 0 ? `+${o}` : String(o)) : '-110'
  })
  const [bank, setBank] = useState('1000')
  const [bets, setBets] = useState('250')
  const [mult, setMult] = useState(0.25)
  const [humble, setHumble] = useState(false)
  const pp = Math.min(0.99, Math.max(0.01, Number(p) / 100 || 0))
  const n = parseOdds(price)
  const d = n ? decimalOf(n) : null
  const B = Math.max(1, Number(bank) || 1000)
  const N = Math.max(10, Math.min(2000, Number(bets) || 250))
  const sim = useMemo(() => (d ? simulate({ bankroll: B, p: pp, d, bets: N, mult, paths: 3000, trueP: humble ? Math.max(0.01, pp - 0.03) : null }) : null), [B, pp, d, N, mult, humble])
  const full = d ? kellyFraction(pp, d) : 0

  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Kelly</h1>
        <p className="page-sub">Stake size from your edge, and three thousand simulated seasons of betting it.</p>
      </header>
      <Locked need="pro" title="Kelly sizing and the bankroll simulator">
        <div className="kelly">
          <form className="kelly__in" onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              <span>Win chance (%)</span>
              <input inputMode="decimal" value={p} onChange={(e) => setP(e.target.value)} />
            </label>
            <label className="field">
              <span>Odds</span>
              <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!n} />
            </label>
            <label className="field">
              <span>Bankroll ($)</span>
              <input inputMode="decimal" value={bank} onChange={(e) => setBank(e.target.value.replace(/[^0-9.]/g, ''))} />
            </label>
            <label className="field">
              <span>Bets</span>
              <input inputMode="numeric" value={bets} onChange={(e) => setBets(e.target.value.replace(/[^0-9]/g, ''))} />
            </label>
            <div className="seg" role="group" aria-label="Stake">
              {MULTS.map((m) => (
                <button key={m.k} type="button" className={mult === m.k ? 'is-on' : ''} aria-pressed={mult === m.k} onClick={() => setMult(m.k)}>
                  {m.label}
                </button>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={humble} onChange={(e) => setHumble(e.target.checked)} />
              Stress test: what if the real win chance is 3 points lower than I think?
            </label>
            {fromSlip && fromSlip.priced && (
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => {
                  setP(String(Math.round(fromSlip.prob * 1000) / 10))
                  setPrice(fromSlip.book > 0 ? `+${fromSlip.book}` : String(fromSlip.book))
                }}
              >
                Use my slip ({pct(fromSlip.prob)} at {odds(fromSlip.book)})
              </button>
            )}
          </form>
          {sim ? (
            <div className="kelly__out">
              <dl className="kelly__facts">
                <div>
                  <dt>Edge</dt>
                  <dd className={`num ${sim.edge > 0 ? 'is-plus' : 'is-minus'}`}>{pct(sim.edge, 1)}</dd>
                </div>
                <div>
                  <dt>Full Kelly</dt>
                  <dd className="num">{pct(full, 1)}</dd>
                </div>
                <div>
                  <dt>Your stake</dt>
                  <dd className="num">${(B * sim.stake).toFixed(2)}</dd>
                </div>
                <div>
                  <dt>Median after {sim.steps}</dt>
                  <dd className="num">${Math.round(sim.median).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Doubled</dt>
                  <dd className="num">{pct(sim.doubled)}</dd>
                </div>
                <div>
                  <dt>Down 90%</dt>
                  <dd className={`num ${sim.broke > 0.05 ? 'is-minus' : ''}`}>{pct(sim.broke, 1)}</dd>
                </div>
              </dl>
              {full === 0 ? <p className="kelly__warn">No edge at this price: Kelly says don't bet. The chart shows what betting anyway does.</p> : null}
              <FanChart sim={sim} bankroll={B} />
              <p className="muted small">
                The band holds the middle 90% of simulated bankrolls; the line is the median. Typical worst drop along the way: {pct(sim.avgDrawdown)}. Quarter Kelly keeps most of the growth with far smaller swings, and it forgives a win chance you've overestimated.
              </p>
            </div>
          ) : (
            <p className="form-err">Enter odds like -110 or +150.</p>
          )}
        </div>
      </Locked>
    </div>
  )
}

function FanChart({ sim, bankroll }) {
  const [ref, W] = useWidth(640)
  const H = 260
  const pad = { l: 56, r: 12, t: 12, b: 26 }
  const top = Math.max(bankroll * 1.5, ...sim.bands.map((b) => b.p95))
  const x = (s) => pad.l + (s / sim.steps) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - Math.min(top, Math.max(0, v)) / top) * (H - pad.t - pad.b)
  const area = (lo, hi) => `${sim.bands.map((b, i) => `${i ? 'L' : 'M'}${x(b.step)},${y(b[hi])}`).join('')}${[...sim.bands].reverse().map((b) => `L${x(b.step)},${y(b[lo])}`).join('')}Z`
  const line = sim.bands.map((b, i) => `${i ? 'L' : 'M'}${x(b.step)},${y(b.p50)}`).join('')
  const ticks = [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8].map((m) => m * bankroll).filter((v) => v <= top)
  return (
    <figure className="fan" ref={ref}>
      <svg width={W} height={H} role="img" aria-label={`Median bankroll after ${sim.steps} bets: $${Math.round(sim.median)}`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--seat)" strokeDasharray={v === bankroll ? '0' : '3 4'} />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="fan__t">
              ${v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : Math.round(v)}
            </text>
          </g>
        ))}
        <path d={area('p5', 'p95')} fill="var(--gold)" opacity="0.12" />
        <path d={area('p25', 'p75')} fill="var(--gold)" opacity="0.22" />
        <path d={line} fill="none" stroke="var(--gold)" strokeWidth="2.5" />
        <text x={W - pad.r} y={H - 6} textAnchor="end" className="fan__t">
          bet {sim.steps}
        </text>
        <text x={pad.l} y={H - 6} className="fan__t">
          start
        </text>
      </svg>
    </figure>
  )
}

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { simulate, kellyFraction } from '../lib/kelly.js'
import { decimalOf, parseOdds, pct, odds, parseAnyOdds, americanOf, impliedOf, noVigOf } from '../lib/format.js'
import { RULES } from '../lib/rules.js'
import { ImpliedHint } from '../ui/Odds.jsx'
import { useTitle, useWidth } from '../lib/hooks.js'
import { useSlip } from '../lib/useSlip.js'
import { parlayMath } from '../lib/slip.js'
import { Locked } from '../ui/Locked.jsx'


const PRESETS = [0.1, 0.25, 0.5, 1]

/**
 * The Kelly calculator (free): your sportsbook's odds and the fair win chance in, the stake out,
 * with any Kelly multiplier and the APEX caps. Below it, the bankroll simulator (Pro).
 */
export function KellyPage() {
  useTitle('Kelly calculator and simulator')
  const [q] = useSearchParams()
  const slip = useSlip()
  const fromSlip = slip.legs.length ? parlayMath(slip.legs, slip.parlayPrice) : null
  const [p, setP] = useState(() => String(Math.round((Number(q.get('p')) || 0.56) * 1000) / 10))
  const [fairMode, setFairMode] = useState('pct') // pct | fair | sharp
  const [fair, setFair] = useState('-127')
  const [sharp, setSharp] = useState({ a: '-104', b: '-104' })
  const [price, setPrice] = useState(() => {
    const o = Number(q.get('odds'))
    return Number.isFinite(o) && Math.abs(o) >= 100 ? (o > 0 ? `+${o}` : String(o)) : '-110'
  })
  const [bank, setBank] = useState(() => {
    try {
      return localStorage.getItem('apex_bankroll') || '1000'
    } catch {
      return '1000'
    }
  })
  const [bets, setBets] = useState('250')
  const [mult, setMult] = useState('0.25')
  const [kind, setKind] = useState('single') // single | parlay: which APEX cap applies
  const [capped, setCapped] = useState(true)
  const [humble, setHumble] = useState(false)

  // the fair win chance, from a percent, a fair price, or a sharp book's two-way market
  let pp = null
  if (fairMode === 'pct') pp = Number(String(p).replace('%', '')) / 100
  if (fairMode === 'fair') {
    const d = parseAnyOdds(fair)
    pp = d ? 1 / d : null
  }
  if (fairMode === 'sharp') pp = noVigOf(parseOdds(sharp.a), parseOdds(sharp.b))?.a ?? null
  if (!(pp > 0 && pp < 1)) pp = null
  const d = parseAnyOdds(price)
  const m = Math.min(1, Math.max(0.01, Number(mult) || 0.25))
  const B = Math.max(1, Number(bank) || 1000)
  const N = Math.max(10, Math.min(2000, Number(bets) || 250))
  const full = d && pp ? kellyFraction(pp, d) : 0
  const cap = kind === 'parlay' ? RULES.stake.lock : RULES.stake.single
  const frac = capped ? Math.min(cap, full * m) : full * m
  const ev = d && pp ? pp * d - 1 : null
  const implied = d ? 1 / d : null
  const sim = useMemo(() => (d && pp ? simulate({ bankroll: B, p: pp, d, bets: N, mult: m, maxStake: capped ? cap : 1, paths: 3000, trueP: humble ? Math.max(0.01, pp - 0.03) : null }) : null), [B, pp, d, N, m, humble, capped, cap])
  const saveBank = (v) => {
    setBank(v)
    try {
      localStorage.setItem('apex_bankroll', String(Number(v) || ''))
    } catch {
      /* private mode */
    }
  }

  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Kelly</h1>
        <p className="page-sub">How much to bet from your edge: the sportsbook’s odds against the fair chance it wins, sized by the Kelly criterion. Then three thousand simulated seasons of betting it.</p>
      </header>

      <section className="kcalc" aria-labelledby="kcalc-h">
        <h2 className="section-h" id="kcalc-h">
          Kelly calculator
        </h2>
        <div className="kcalc__grid">
          <form className="kcalc__in" onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              <span>Sportsbook odds</span>
              <span className="odds-field">
                <input inputMode="text" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!d} placeholder="-110, 1.91 or 10/11" />
                {d && <ImpliedHint a={americanOf(d)} />}
              </span>
            </label>
            <div className="field">
              <span>Fair win chance</span>
              <div className="seg seg--s" role="group" aria-label="How you know the fair chance">
                {[
                  ['pct', 'Percent'],
                  ['fair', 'Fair odds'],
                  ['sharp', 'Sharp market'],
                ].map(([k, l]) => (
                  <button key={k} type="button" className={fairMode === k ? 'is-on' : ''} aria-pressed={fairMode === k} onClick={() => setFairMode(k)}>
                    {l}
                  </button>
                ))}
              </div>
              {fairMode === 'pct' && <input inputMode="decimal" value={p} onChange={(e) => setP(e.target.value)} aria-label="Fair win chance in percent" placeholder="56" />}
              {fairMode === 'fair' && <input inputMode="text" value={fair} onChange={(e) => setFair(e.target.value)} aria-label="Fair odds" placeholder="-127" />}
              {fairMode === 'sharp' && (
                <span className="kcalc__sharp">
                  <input inputMode="text" value={sharp.a} onChange={(e) => setSharp({ ...sharp, a: e.target.value })} aria-label="Sharp book price on your side" placeholder="-104" />
                  <span className="muted">vs</span>
                  <input inputMode="text" value={sharp.b} onChange={(e) => setSharp({ ...sharp, b: e.target.value })} aria-label="Sharp book price on the other side" placeholder="-104" />
                </span>
              )}
              <span className="kcalc__hint">{pp ? `Fair chance ${pct(pp, 1)}${fairMode === 'sharp' ? ', the sharp book’s price with its cut taken out' : ''}` : 'Enter the fair chance'}</span>
            </div>
            <label className="field">
              <span>Bankroll ($)</span>
              <input inputMode="decimal" value={bank} onChange={(e) => saveBank(e.target.value.replace(/[^0-9.]/g, ''))} />
            </label>
            <div className="field">
              <span>Kelly multiplier</span>
              <span className="kcalc__mult">
                <span className="seg seg--s" role="group" aria-label="Kelly multiplier presets">
                  {PRESETS.map((k) => (
                    <button key={k} type="button" className={Number(mult) === k ? 'is-on' : ''} aria-pressed={Number(mult) === k} onClick={() => setMult(String(k))}>
                      {k === 1 ? 'Full' : k === 0.5 ? 'Half' : k === 0.25 ? 'Quarter' : '0.1x'}
                    </button>
                  ))}
                </span>
                <input inputMode="decimal" value={mult} onChange={(e) => setMult(e.target.value)} aria-label="Custom Kelly multiplier" />
              </span>
            </div>
            <div className="field">
              <span>Bet type</span>
              <div className="seg seg--s" role="group" aria-label="Bet type">
                {[
                  ['single', 'Single'],
                  ['parlay', 'Parlay'],
                ].map(([k, l]) => (
                  <button key={k} type="button" className={kind === k ? 'is-on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={capped} onChange={(e) => setCapped(e.target.checked)} />
              APEX caps: {RULES.stake.single * 100}% of bankroll on a single, {RULES.stake.lock * 100}% on a parlay ({RULES.stake.daily * 100}% a day in all)
            </label>
            {fromSlip && fromSlip.priced && (
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => {
                  setFairMode('pct')
                  setP(String(Math.round(fromSlip.prob * 1000) / 10))
                  setPrice(fromSlip.book > 0 ? `+${fromSlip.book}` : String(fromSlip.book))
                  setKind(slip.legs.length > 1 ? 'parlay' : 'single')
                }}
              >
                Use my slip ({pct(fromSlip.prob)} at {odds(fromSlip.book)})
              </button>
            )}
          </form>
          <div className="kcalc__out" aria-live="polite">
            {d && pp ? (
              <>
                <dl className="kcalc__facts">
                  <div className="kcalc__main">
                    <dt>Amount to wager</dt>
                    <dd className="num">{ev > 0 ? `$${(B * frac).toFixed(2)}` : '$0'}</dd>
                  </div>
                  <div>
                    <dt>Fraction of bankroll</dt>
                    <dd className="num">{ev > 0 ? pct(frac, 2) : '0%'}</dd>
                  </div>
                  <div>
                    <dt>Expected value</dt>
                    <dd className={`num ${ev > 0 ? 'is-plus' : 'is-minus'}`}>
                      {ev >= 0 ? '+' : '−'}
                      {Math.abs(ev * 100).toFixed(2)}%
                    </dd>
                  </div>
                  <div>
                    <dt>EV per $100</dt>
                    <dd className={`num ${ev > 0 ? 'is-plus' : 'is-minus'}`}>
                      {ev >= 0 ? '+' : '−'}${Math.abs(ev * 100).toFixed(2)}
                    </dd>
                  </div>
                  <div>
                    <dt>Edge</dt>
                    <dd className="num">{((pp - implied) * 100).toFixed(1)} pts</dd>
                  </div>
                  <div>
                    <dt>Full Kelly</dt>
                    <dd className="num">{pct(full, 2)}</dd>
                  </div>
                </dl>
                <p className="kcalc__say">
                  {ev > 0
                    ? `The odds say ${pct(implied, 1)}; you have it at ${pct(pp, 1)}. Full Kelly bets ${pct(full, 1)} of your bankroll; at ${m}x that's ${pct(full * m, 2)}${capped && full * m > cap ? `, capped at ${pct(cap, 0)} by the APEX rules` : ''}.`
                    : `No edge: the odds say ${pct(implied, 1)} and you have it at ${pct(pp, 1)}. Kelly says don't bet. Edge or Pass.`}
                </p>
              </>
            ) : (
              <p className="muted">Enter the sportsbook’s odds and the fair chance it wins.</p>
            )}
          </div>
        </div>
      </section>

      <Locked need="pro" title="The bankroll simulator">
        <section className="kelly" aria-labelledby="ksim-h">
          <div className="kelly__in">
            <h2 className="section-h" id="ksim-h">
              Simulate a season of it
            </h2>
            <label className="field">
              <span>Bets</span>
              <input inputMode="numeric" value={bets} onChange={(e) => setBets(e.target.value.replace(/[^0-9]/g, ''))} />
            </label>
            <label className="check">
              <input type="checkbox" checked={humble} onChange={(e) => setHumble(e.target.checked)} />
              Stress test: what if the real win chance is 3 points lower than I think?
            </label>
          </div>
          {sim ? (
            <div className="kelly__out">
              <dl className="kelly__facts">
                <div>
                  <dt>Stake each bet</dt>
                  <dd className="num">{pct(sim.stake, 2)}</dd>
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
              {full === 0 ? <p className="kelly__warn">No edge at this price: Kelly says don’t bet. The chart shows what betting anyway does.</p> : null}
              <FanChart sim={sim} bankroll={B} />
              <p className="muted small">
                The band holds the middle 90% of simulated bankrolls; the line is the median. Typical worst drop along the way: {pct(sim.avgDrawdown)}. Fractional Kelly keeps most of the growth with far smaller swings, and it forgives a win chance you’ve overestimated.
              </p>
            </div>
          ) : (
            <p className="form-err">Enter odds and a fair chance above.</p>
          )}
        </section>
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

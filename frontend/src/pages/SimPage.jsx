import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useTitle, useWidth } from '../lib/hooks.js'
import { useSlip } from '../lib/useSlip.js'
import { parlayMath } from '../lib/slip.js'
import { pct, odds, parseOdds, fairOf } from '../lib/format.js'
import { Locked } from '../ui/Locked.jsx'
import { ImpliedHint } from '../ui/Odds.jsx'
import { Headshot } from '../ui/Img.jsx'
import { ErrorBox } from '../ui/Bits.jsx'
import { useSport, apiOf, sp, legRef, legsSport } from '../lib/sport.js'

const RUNS = [10_000, 25_000, 50_000, 100_000]
const BETS = [50, 100, 250, 500]
const k = (n) => (n >= 1000 ? `${n / 1000}k` : String(n))

/** Play the slip out tens of thousands of times on the APEX distributions. */
export function SimPage() {
  const sport = useSport()
  useTitle('Parlay simulator')
  const slip = useSlip()
  const legs = slip.legs
  const math = legs.length ? parlayMath(legs, slip.parlayPrice) : null
  const [runs, setRuns] = useState(25_000)
  const [bets, setBets] = useState(100)
  const [priceText, setPriceText] = useState('')
  const [state, setState] = useState({ busy: false, err: null, out: null })
  const price = parseOdds(priceText) ?? (math?.priced ? math.book : null)
  useEffect(() => {
    if (!priceText && math?.priced) setPriceText(odds(math.book))
    // only when the slip's own price first shows up
  }, [math?.book])

  const run = async () => {
    setState({ busy: true, err: null, out: state.out })
    try {
      // a slip can mix leagues: any league's simulator takes the others' legs by ref
      const out = await api(`${apiOf(legsSport(legs, sport))}/sim`, { method: 'POST', body: { legs: legs.map(legRef), iterations: runs, price, bets } })
      setState({ busy: false, err: null, out })
    } catch (err) {
      setState({ busy: false, err, out: null })
    }
  }

  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Parlay simulator</h1>
        <p className="page-sub">Your slip, played out {k(runs)} times on the APEX numbers: how often each leg comes in, how often the whole thing cashes, and how much of a winning run is just luck.</p>
      </header>
      <Locked need="pro" title="The parlay simulator">
        {!legs.length ? (
          <div className="empty">
            <p className="empty__title">Your slip is empty</p>
            <p>Add two or more props from the board, then come back here to play them out.</p>
            <Link className="btn btn--gold" to={sp(sport, '/props')}>
              Find props
            </Link>
          </div>
        ) : (
          <div className="sim">
            <section className="sim__setup" aria-label="Simulation setup">
              <ul className="sim__legs">
                {legs.map((l) => (
                  <li key={legRef(l)}>
                    <Headshot src={l.headshot} name={l.name} size={28} />
                    <span>
                      <b>{l.short || l.name}</b> {l.shortLabel || l.label}
                    </span>
                    <span className="num muted">APEX {pct(l.prob)}</span>
                  </li>
                ))}
              </ul>
              <div className="sim__controls">
                <div className="field">
                  <span>Runs</span>
                  <div className="seg seg--s" role="group" aria-label="Runs">
                    {RUNS.map((n) => (
                      <button key={n} type="button" className={runs === n ? 'is-on' : ''} aria-pressed={runs === n} onClick={() => setRuns(n)}>
                        {k(n)}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="field">
                  <span>Your parlay odds</span>
                  <span className="odds-field">
                    <input inputMode="numeric" value={priceText} placeholder="+600" onChange={(e) => setPriceText(e.target.value)} aria-invalid={Boolean(priceText) && parseOdds(priceText) == null} />
                    <ImpliedHint a={parseOdds(priceText)} />
                  </span>
                </label>
                <div className="field">
                  <span>Bets in a row</span>
                  <div className="seg seg--s" role="group" aria-label="Bets in a row">
                    {BETS.map((n) => (
                      <button key={n} type="button" className={bets === n ? 'is-on' : ''} aria-pressed={bets === n} onClick={() => setBets(n)}>
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <button type="button" className="btn btn--gold sim__run" onClick={run} disabled={state.busy}>
                  {state.busy ? 'Simulating' : `Run ${runs.toLocaleString()} simulations`}
                </button>
              </div>
            </section>
            {state.err && <ErrorBox error={state.err} />}
            {state.out && <Results out={state.out} />}
          </div>
        )}
      </Locked>
    </div>
  )
}

function Results({ out }) {
  const p = out.parlay
  const n = out.legs.length
  const pr = out.price
  return (
    <div className="sim__out" key={out.at}>
      <section className="sim-head">
        <div>
          <p className="sim-head__k">Cashes in</p>
          <p className="sim-head__big num">{pct(p.hitRate, 1)}</p>
          <p className="sim-head__sub">
            of {out.iterations.toLocaleString()} runs (give or take {pct(out.margin, 1)}). Fair price <b className="num">{odds(fairOf(p.hitRate))}</b>.
          </p>
        </div>
        {pr && (
          <div className={`sim-head__price ${pr.ev > 0 ? 'is-plus' : 'is-minus'}`}>
            <p className="sim-head__k">At {odds(pr.price)}</p>
            <p className="num sim-head__mid">{pct(pr.implied, 1)}</p>
            <p className="sim-head__sub">
              is what the book thinks. {pr.ev > 0 ? `APEX has it ${((p.hitRate - pr.implied) * 100).toFixed(1)} points higher: about $${(pr.ev * 100).toFixed(2)} back per $100 over time.` : `APEX has it ${((pr.implied - p.hitRate) * 100).toFixed(1)} points lower: you'd lose about $${(-pr.ev * 100).toFixed(2)} per $100 over time.`}
            </p>
          </div>
        )}
        {n > 1 && Math.abs(p.hitRate - p.independent) > 0.003 && (
          <p className="sim-head__note">
            {p.hitRate > p.independent
              ? `Some legs win together (same game, same offense), so this cashes more often than the ${pct(p.independent, 1)} you'd get by multiplying the legs. Books know this and price same-game parlays down for it.`
              : `Some legs pull against each other, so this cashes less often than the ${pct(p.independent, 1)} you'd get by multiplying the legs.`}
          </p>
        )}
      </section>

      <section className="sim-legs" aria-label="Each leg">
        <h2 className="section__title">Each leg, {out.iterations.toLocaleString()} times</h2>
        {out.legs.map((l) => (
          <LegResult key={`${l.id}:${l.label}`} l={l} multi={n > 1} />
        ))}
      </section>

      {n > 1 && <LegsHit dist={p.legsHit} />}
      {out.luck && <Luck luck={out.luck} />}
    </div>
  )
}

function LegResult({ l, multi }) {
  const [ref, W] = useWidth(520)
  const H = 74
  const top = Math.max(...l.bins.map((b) => b.share), 1e-6)
  const bw = W / l.bins.length
  const hitBin = (b) => (l.side === 'u' ? b.x1 < l.line : b.x0 > l.line)
  const pushBin = (b) => b.x0 <= l.line && b.x1 >= l.line && Number.isInteger(l.line)
  const lineX = (() => {
    const i = l.bins.findIndex((b) => b.x1 >= l.line)
    if (i < 0) return W
    const b = l.bins[i]
    return i * bw + ((l.line - b.x0 + 0.5) / (b.x1 - b.x0 + 1)) * bw
  })()
  return (
    <article className="sim-leg">
      <div className="sim-leg__head">
        <p className="sim-leg__who">
          <b>{l.short || l.name}</b> {l.label}
        </p>
        <p className="sim-leg__rate num">{pct(l.hitRate, 1)}</p>
      </div>
      <div className="sim-leg__chart" ref={ref}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${l.label}: hits in ${pct(l.hitRate, 1)} of runs, usually between ${l.p10} and ${l.p90}`}>
          {l.bins.map((b, i) => {
            const h = Math.max(1, (b.share / top) * (H - 16))
            return <rect key={i} x={i * bw + 1} y={H - 14 - h} width={Math.max(1, bw - 2)} height={h} rx={2} fill={pushBin(b) ? 'var(--push)' : hitBin(b) ? 'var(--turf)' : 'var(--flag)'} opacity={0.9} />
          })}
          <line x1={lineX} x2={lineX} y1={0} y2={H - 14} stroke="var(--chalk)" strokeDasharray="4 3" />
          <text x={Math.min(W - 4, Math.max(4, lineX))} y={H - 2} textAnchor="middle" className="sim-leg__tick">
            {l.line}
          </text>
        </svg>
      </div>
      <p className="sim-leg__facts">
        Usually {l.p10}–{l.p90}, middle {l.median}. APEX says {pct(l.apex, 1)}
        {multi && l.onlyMiss > 0.005 ? `. The only leg that misses in ${pct(l.onlyMiss, 1)} of runs` : ''}
        {l.pushRate > 0.005 ? `. Lands exactly on ${l.line} in ${pct(l.pushRate, 1)}` : ''}.
      </p>
    </article>
  )
}

function LegsHit({ dist }) {
  const n = dist.length - 1
  const top = Math.max(...dist)
  return (
    <section className="sim-dist" aria-label="Legs that came in">
      <h2 className="section__title">How many legs came in</h2>
      <div className="sim-dist__bars">
        {dist.map((share, i) => (
          <div key={i} className={`sim-dist__bar${i === n ? ' is-all' : i === n - 1 ? ' is-near' : ''}`}>
            <span className="num sim-dist__v">{pct(share, 1)}</span>
            <span className="sim-dist__col" style={{ height: `${Math.max(2, (share / top) * 100)}%` }} />
            <span className="sim-dist__k">{i === n ? 'All' : i}</span>
          </div>
        ))}
      </div>
      <p className="muted small">Missed by one leg in {pct(dist[n - 1], 1)} of runs. That's the one that hurts.</p>
    </section>
  )
}

function Luck({ luck }) {
  const [ref, W] = useWidth(640)
  const H = 220
  const pad = { l: 44, r: 10, t: 10, b: 24 }
  const all = [...luck.skill.bands, ...luck.luck.bands]
  const hi = Math.max(1, ...all.map((b) => b.p90))
  const lo = Math.min(-1, ...all.map((b) => b.p10))
  const x = (s) => pad.l + (s / luck.bets) * (W - pad.l - pad.r)
  const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b)
  const band = (bs) => `${bs.map((b, i) => `${i ? 'L' : 'M'}${x(b.step)},${y(b.p90)}`).join('')}${[...bs].reverse().map((b) => `L${x(b.step)},${y(b.p10)}`).join('')}Z`
  const mid = (bs) => bs.map((b, i) => `${i ? 'L' : 'M'}${x(b.step)},${y(b.p50)}`).join('')
  return (
    <section className="sim-luck" aria-label="Luck versus skill">
      <h2 className="section__title">Luck vs skill over {luck.bets} bets</h2>
      <p className="muted">Two thousand bettors each place this bet {luck.bets} times at 1 unit. Gold bets with the APEX chance; grey wins exactly as often as the price says, so whatever it shows is pure luck.</p>
      <div ref={ref}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`After ${luck.bets} bets, ${pct(luck.skill.up)} are up with the APEX edge versus ${pct(luck.luck.up)} on luck alone`}>
          <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--seat-2)" />
          <text x={pad.l - 6} y={y(0) + 4} textAnchor="end" className="sim-luck__tick">0u</text>
          <text x={pad.l - 6} y={y(hi) + 10} textAnchor="end" className="sim-luck__tick">{Math.round(hi)}u</text>
          <text x={pad.l - 6} y={y(lo)} textAnchor="end" className="sim-luck__tick">{Math.round(lo)}u</text>
          <path d={band(luck.luck.bands)} fill="var(--chalk-3)" opacity={0.18} />
          <path d={mid(luck.luck.bands)} fill="none" stroke="var(--chalk-3)" strokeWidth={2} />
          <path d={band(luck.skill.bands)} fill="var(--gold)" opacity={0.16} />
          <path d={mid(luck.skill.bands)} fill="none" stroke="var(--gold)" strokeWidth={2.5} />
          <text x={W - pad.r} y={H - 6} textAnchor="end" className="sim-luck__tick">{luck.bets} bets</text>
        </svg>
      </div>
      <dl className="tool__facts">
        <div>
          <dt>Up after {luck.bets}, with the edge</dt>
          <dd className="num">{pct(luck.skill.up)}</dd>
        </div>
        <div>
          <dt>Up on luck alone</dt>
          <dd className="num">{pct(luck.luck.up)}</dd>
        </div>
        <div>
          <dt>Typical result, with the edge</dt>
          <dd className={`num ${luck.skill.median >= 0 ? 'is-plus' : 'is-minus'}`}>{luck.skill.median >= 0 ? '+' : ''}{luck.skill.median.toFixed(1)}u</dd>
        </div>
      </dl>
      <p className="muted small">The bands hold the middle 80% of bettors. When grey and gold overlap this much, a hot or cold streak says very little about whether the bet is any good.</p>
    </section>
  )
}

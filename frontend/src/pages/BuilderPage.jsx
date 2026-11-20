import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { useSlip } from '../lib/useSlip.js'
import { importLegs } from '../lib/slip.js'
import { pct, odds, parseOdds, fairOf, kickoff, decimalOf, plural } from '../lib/format.js'
import { Locked } from '../ui/Locked.jsx'
import { Headshot } from '../ui/Img.jsx'
import { ErrorBox } from '../ui/Bits.jsx'
import { SendToBook } from '../ui/Books.jsx'
import { HelpTip } from '../ui/HelpTip.jsx'
import { Helpful } from '../ui/Feedback.jsx'
import { useSport, apiOf, sp, sportInfo, legRef } from '../lib/sport.js'
import { useCredits, useCost, refreshCredits, CreditsLine } from '../ui/Credits.jsx'

// The parlay builder: a risk profile, a leg count and a target price in; parlays from the board
// that fit, each played out in the simulation. Swapping a leg re-runs the free quick simulation.

const newKey = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const isDaily = (sport) => sportInfo(sport).calendar === 'day'
const openGame = (g) => g?.status?.state === 'pre' && Date.parse(g.date) - Date.now() > 5 * 60_000

export function BuilderPage() {
  useTitle('Parlay builder')
  return (
    <div className="container page builder">
      <header className="page-head">
        <h1 className="page-title">Parlay builder</h1>
        <p className="page-sub">Pick how much risk you want, how many legs and roughly what it should pay. It looks across the board for legs that fit together, then plays each parlay out 20,000 times to see how often it cashes.</p>
      </header>
      <Locked need="pro" real title="The parlay builder">
        <Builder />
      </Locked>
    </div>
  )
}

function Builder() {
  const sport = useSport()
  const nav = useNavigate()
  const slip = useSlip()
  const prof = useApi(`${apiOf(sport)}/build/profiles`, { maxAgeMs: 10 * 60_000 })
  const week = useApi(`${apiOf(sport)}/week`, { maxAgeMs: 60_000 })
  const profiles = prof.data?.profiles || null
  const [risk, setRisk] = useState('balanced')
  const P = profiles?.find((p) => p.key === risk) || null
  const [legs, setLegs] = useState(3)
  const [target, setTarget] = useState(null)
  const [other, setOther] = useState('')
  const [gameId, setGameId] = useState('')
  const [keepSlip, setKeepSlip] = useState(false)
  const [state, setState] = useState({ busy: false, err: null, out: null })
  const outRef = useRef(null)
  const credits = useCredits()
  const cost = useCost('build')

  // a profile's leg range, and a target that profile can reach with that many legs
  const chips = P?.targets?.[legs] || []
  useEffect(() => {
    if (!P) return
    if (legs < P.legs.min || legs > P.legs.max) setLegs(Math.min(P.legs.max, Math.max(P.legs.min, legs)))
  }, [P, legs])
  useEffect(() => {
    if (chips.length && !other) setTarget(chips[Math.min(1, chips.length - 1)])
    // a new profile or leg count: back to that pair's default, unless a price was typed
  }, [risk, legs, chips.join(',')])
  const typed = parseOdds(other)
  const typedOk = typed != null && typed >= 100
  const goal = other ? (typedOk ? typed : null) : target

  const games = (week.data?.games || []).filter(openGame)
  const mine = slip.legs.filter((l) => (l.sport || 'nfl') === sport && (!gameId || String(l.gameId) === gameId))
  const canKeep = mine.length > 0 && mine.length < legs
  const keep = keepSlip && canKeep ? mine.map((l) => l.id) : []

  const run = async (avoid = []) => {
    setState({ busy: true, err: null, out: state.out })
    try {
      const out = await api(`${apiOf(sport)}/build`, { method: 'POST', body: { risk, legs, target: goal, gameId: gameId || null, keep, avoid, runKey: newKey() } })
      setState({ busy: false, err: null, out })
      // on a phone the results land under the controls: bring them up
      requestAnimationFrame(() => {
        const el = outRef.current
        if (el && el.getBoundingClientRect().top > window.innerHeight * 0.35) el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
      })
    } catch (err) {
      setState({ busy: false, err, out: null })
    }
    refreshCredits()
  }
  const broke = credits && !credits.unlimited && cost != null && credits.left < cost

  return (
    <div className="bld">
      <section className="bld__setup" aria-label="What to build">
        {prof.error && <ErrorBox error={prof.error} onRetry={prof.refresh} />}
        <fieldset className="bld__group">
          <legend>How much risk</legend>
          <div className="risk" role="radiogroup" aria-label="Risk">
            {(profiles || []).map((p) => (
              <button key={p.key} type="button" role="radio" aria-checked={risk === p.key} className={`risk__opt${risk === p.key ? ' is-on' : ''}`} onClick={() => setRisk(p.key)}>
                <span className="risk__name">{p.label}</span>
                <span className="risk__blurb">{p.blurb}</span>
                <span className="risk__rule">
                  Each leg <b className="num">{pct(p.minProb)}</b> or better, {p.legs.min} to {p.legs.max} legs
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="bld__row">
          <div className="bld__group">
            <span className="bld__k" id="legs-k">
              Legs <HelpTip id="leg-count" label="leg count" />
            </span>
            <div className="stepper" role="group" aria-labelledby="legs-k">
              <button type="button" className="stepper__b" onClick={() => setLegs((n) => n - 1)} disabled={!P || legs <= P.legs.min} aria-label="One leg fewer">
                −
              </button>
              <output className="stepper__n num" aria-live="polite">
                {legs}
              </output>
              <button type="button" className="stepper__b" onClick={() => setLegs((n) => n + 1)} disabled={!P || legs >= P.legs.max} aria-label="One leg more">
                +
              </button>
            </div>
          </div>
          <label className="bld__group bld__game">
            <span className="bld__k">Games</span>
            <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
              <option value="">All games</option>
              {games.map((g) => (
                <option key={g.id} value={String(g.id)}>
                  {g.away?.abbr} at {g.home?.abbr}, {kickoff(g.date)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="bld__group">
          <span className="bld__k" id="target-k">
            Target odds <HelpTip id="implied" label="implied probability" />
          </span>
          <div className="targets" role="radiogroup" aria-labelledby="target-k">
            {chips.map((a) => {
              const on = !other && target === a
              return (
                <button key={a} type="button" role="radio" aria-checked={on} className={`target${on ? ' is-on' : ''}`} onClick={() => {
                  setOther('')
                  setTarget(a)
                }}>
                  <span className="target__odds num">{odds(a)}</span>
                  <span className="target__p">{pct(1 / decimalOf(a))} chance</span>
                </button>
              )
            })}
            <label className={`target target--other${other ? ' is-on' : ''}`}>
              <span className="target__k">Other</span>
              <input inputMode="numeric" placeholder="+750" value={other} onChange={(e) => setOther(e.target.value)} aria-invalid={Boolean(other) && !typedOk} aria-label="Other target odds" />
            </label>
          </div>
          {other && !typedOk && <p className="form-err small">Type American odds of +100 or longer, like +750.</p>}
        </div>

        {mine.length > 0 && (
          <label className={`check bld__keep${canKeep ? '' : ' is-off'}`}>
            <input type="checkbox" checked={keepSlip && canKeep} disabled={!canKeep} onChange={(e) => setKeepSlip(e.target.checked)} />
            <span>
              Build around my slip ({plural(mine.length, 'leg')})
              {!canKeep && <small> Pick more legs than your slip has to build around it.</small>}
            </span>
          </label>
        )}

        <button type="button" className="btn btn--lime bld__go" onClick={() => run()} disabled={state.busy || !P || goal == null || broke}>
          {state.busy ? 'Building' : `Build my parlay${cost != null && credits && !credits.unlimited ? ` (${plural(cost, 'credit')})` : ''}`}
        </button>
        <CreditsLine c={credits} cost={cost} />
      </section>

      <section className="bld__out" ref={outRef} aria-live="polite" aria-busy={state.busy}>
        {state.err && <ErrorBox error={state.err} />}
        {!state.out && !state.err && <HowItWorks busy={state.busy} />}
        {state.out && (
          <Results
            key={state.out.at}
            out={state.out}
            sport={sport}
            onAgain={(avoid) => run(avoid)}
            busy={state.busy}
            onSim={(cards) => {
              importLegs(cards)
              nav('/tools/sim')
            }}
          />
        )}
      </section>
    </div>
  )
}

function HowItWorks({ busy }) {
  return (
    <div className={`bld__how${busy ? ' is-busy' : ''}`}>
      <p className="bld__how-h">{busy ? 'Looking across the board…' : 'What it does'}</p>
      <ul>
        <li>Screens every prop that hasn’t started for your risk level: the chance each leg needs, enough games behind it, a steady role, and nobody doubtful or out.</li>
        <li>Searches combinations of that size near your price, with one leg per player and no two legs that pull against each other. Legs with the most behind them win.</li>
        <li>Plays the best few out 20,000 times. The chance you see is the simulation’s, so legs that tend to win together count for it and legs from one game aren’t treated as unrelated.</li>
      </ul>
    </div>
  )
}

function Results({ out, sport, onAgain, onSim, busy }) {
  const [i, setI] = useState(0)
  // swapped legs per option, re-simulated with the free quick run
  const [edits, setEdits] = useState({})
  const builds = out.builds || []
  if (!builds.length) {
    return (
      <div className="bld__none">
        <p className="bld__none-h">Nothing fits that</p>
        <p>{out.reason}</p>
        {out.funnel && (
          <p className="muted small">
            {out.funnel.scanned.toLocaleString()} props looked at, {out.funnel.eligible.toLocaleString()} passed the screen. {out.credits?.refunded ? 'Your credit went back.' : ''}
          </p>
        )}
      </div>
    )
  }
  const b = builds[Math.min(i, builds.length - 1)]
  return (
    <div className="bld__results">
      {out.reason && <p className="bld__off">{out.reason}</p>}
      {builds.length > 1 && (
        <div className="opts" role="tablist" aria-label="Options">
          {builds.map((x, k) => {
            const e = edits[x.id]
            const chance = e?.chance ?? x.chance
            return (
              <button key={x.id} type="button" role="tab" aria-selected={k === i} className={`opt${k === i ? ' is-on' : ''}`} onClick={() => setI(k)}>
                <span className="opt__k">Option {k + 1}</span>
                <span className="opt__v num">{odds(fairOf(chance))}</span>
                <span className="opt__p">{pct(chance, 1)}</span>
              </button>
            )
          })}
        </div>
      )}
      <BuildTicket key={b.id} b={b} edit={edits[b.id]} setEdit={(e) => setEdits((m) => ({ ...m, [b.id]: typeof e === 'function' ? e(m[b.id]) : e }))} out={out} sport={sport} n={i} onAgain={onAgain} onSim={onSim} busy={busy} />
      <p className="muted small bld__fine">
        {out.funnel.scanned.toLocaleString()} props looked at, {out.funnel.eligible.toLocaleString()} passed the {out.request.risk} screen.
        {out.mode === 'fair' ? ' No sportsbook prices are posted for these, so the price shown is the fair one: the parlay is worth it at that price or longer.' : ' Prices are the best posted for each leg.'}
      </p>
      <Helpful about={`${sport}:build:${out.request.risk}/${b.legs.length}/${out.request.target}:${b.id}`} label="Was this parlay helpful?" />
    </div>
  )
}

function BuildTicket({ b, edit, setEdit, out, sport, n, onAgain, onSim, busy }) {
  const [open, setOpen] = useState(null)
  const [sending, setSending] = useState(false)
  const legs = edit?.legs || b.legs
  const chance = edit?.chance ?? b.chance
  const multiplied = legs.reduce((x, l) => x * l.prob, 1)
  const fair = fairOf(chance)
  const book = out.mode === 'book' && !edit && b.price
  const daily = isDaily(sport)
  const names = (id) => legs.find((l) => l.id === id)?.short || legs.find((l) => l.id === id)?.name
  const together = edit ? [] : b.together.filter((t) => names(t.a) && names(t.b))
  const games = new Set(legs.map((l) => l.gameId))
  const shared = games.size < legs.length
  const hurt = legs.filter((l) => l.injury)

  const swap = async (k, alt) => {
    const next = legs.map((l, x) => (x === k ? { ...alt, swapped: true, back: l } : l))
    setOpen(null)
    setEdit({ legs: next, chance: null, busy: true, err: null })
    try {
      const sim = await api(`${apiOf(sport)}/sim`, { method: 'POST', body: { legs: next.map(legRef), quick: true } })
      setEdit({ legs: next.map((l, x) => ({ ...l, simHit: sim.legs[x]?.hitRate ?? l.simHit })), chance: sim.parlay.hitRate, iterations: sim.iterations, busy: false, err: null })
    } catch (err) {
      setEdit({ legs: next, chance: null, busy: false, err })
    }
  }
  // the other legs that fit this slot: the build's own alternates, plus whatever was swapped out
  const altsFor = (k) => {
    const l = legs[k]
    const base = b.legs[k]
    const list = [...(l.swapped ? [base] : []), ...(base.swaps || [])].filter((x) => x.id !== l.id && !legs.some((y) => y.id === x.id))
    return list
  }

  return (
    <article className={`ticket bticket${b.onTarget ? ' is-on-target' : ''}`} aria-labelledby={`bt-${n}`}>
      <header className="ticket__head">
        <div>
          <p className="ticket__week">
            {plural(legs.length, 'leg')}, {out.request.risk}
            {out.request.gameId ? ', one game' : ''}
          </p>
          <h2 className="ticket__title" id={`bt-${n}`}>
            {legs.map((l) => l.short || l.name).join(' + ')}
          </h2>
        </div>
        <span className={`ticket__status ${b.onTarget && !edit ? 'ticket__status--price_needed' : 'ticket__status--pass'}`}>{edit ? 'Edited' : b.onTarget ? 'Near your target' : 'Closest found'}</span>
      </header>

      <div className="ticket__numbers">
        <div className="ticket__big">
          <span className="num">{edit?.busy ? '…' : chance == null ? '–' : pct(chance, 1)}</span>
          <span className="ticket__big-k">
            {edit?.busy ? 'playing it out again' : `cashes in ${(edit?.iterations || b.iterations).toLocaleString()} simulated ${daily ? 'nights' : 'weeks'}`}
          </span>
        </div>
        <dl className="ticket__facts">
          <div>
            <dt>Fair price</dt>
            <dd className="num">{chance == null ? '–' : odds(fair)}</dd>
          </div>
          <div>
            <dt>Your target</dt>
            <dd className="num">{odds(out.request.target)}</dd>
          </div>
          <div>
            <dt>
              Legs multiplied <HelpTip id="correlation" label="correlation" />
            </dt>
            <dd className="num">{pct(multiplied, 1)}</dd>
          </div>
          {book ? (
            <>
              <div>
                <dt>Posted price</dt>
                <dd className="num">{odds(b.price.american)}</dd>
              </div>
              <div>
                <dt>
                  Expected value <HelpTip id="ev" label="expected value" />
                </dt>
                <dd className={`num ${b.price.ev > 0 ? 'is-plus' : 'is-minus'}`}>
                  {b.price.ev >= 0 ? '+' : '−'}${Math.abs(b.price.ev * 100).toFixed(0)} per $100
                </dd>
              </div>
            </>
          ) : (
            <div>
              <dt>Games</dt>
              <dd className="num">{games.size}</dd>
            </div>
          )}
        </dl>
      </div>

      {edit?.err && <ErrorBox error={edit.err} />}
      <div className="bticket__notes">
        {!book && chance != null && <p className="ticket__note">Worth it at {odds(fair)} or longer. Check what your sportsbook pays for these legs together.</p>}
        {book && b.price.ev > 0 && (
          <p className="ticket__note">
            The best posted prices pay {odds(b.price.american)}, longer than the fair {odds(fair)}: about ${(b.price.ev * 100).toFixed(0)} back per $100 over time.
          </p>
        )}
        {book && b.price.ev <= 0 && (
          <p className="ticket__note">
            The best posted prices pay {odds(b.price.american)}, shorter than the fair {odds(fair)}, so this loses money over time.
          </p>
        )}
        {together.length > 0 && (
          <p className="ticket__corr">
            {together.map((t) => `${names(t.a)} and ${names(t.b)}`).join(', ')} tend to win together, so it cashes {chance > multiplied ? 'more often than the legs multiplied' : 'about as often as the legs multiplied'}.
          </p>
        )}
        {shared && (
          <p className="ticket__corr">
            Some legs share a game. <HelpTip id="sgp" label="same-game parlay" /> Sportsbooks price same-game parlays below the legs multiplied, so the payout can be shorter than you’d expect.
          </p>
        )}
        {hurt.map((l) => (
          <p key={l.id} className="ticket__corr bticket__hurt">
            {l.short || l.name} is listed {l.injury.severity}. If he doesn’t play, most books take the leg off and the parlay pays less.
          </p>
        ))}
      </div>

      <ol className="ticket__legs">
        {legs.map((l, k) => {
          const alts = l.kept ? [] : altsFor(k)
          return (
            <li key={`${k}:${l.id}`} className="tleg bleg">
              <div className="tleg__row">
                <span className="tleg__n num">{k + 1}</span>
                <Headshot src={l.headshot || l.logo} name={l.name} size={44} />
                <div className="tleg__who">
                  <p className="tleg__name">
                    {l.playerId ? <Link to={sp(sport, `/player/${l.playerId}`)}>{l.name}</Link> : l.name}
                    <span className="muted">
                      {' '}
                      {l.pos ? `${l.pos} ` : ''}
                      {l.teamAbbr} vs {l.oppAbbr}, {kickoff(l.kickoff)}
                    </span>
                  </p>
                  <p className="tleg__bet">
                    <Link to={sp(sport, `/prop/${encodeURIComponent(l.id)}`)}>{l.label}</Link>
                    {l.posted === 'alt' && <span className="tleg__alt">alt line</span>}
                    {l.kept && <span className="tleg__alt">from your slip</span>}
                    {l.swapped && <span className="tleg__alt">swapped in</span>}
                  </p>
                </div>
                <div className="tleg__prob">
                  <span className="num">{pct(l.prob)}</span>
                  <span className="tleg__fair">fair {odds(l.fair)}</span>
                </div>
              </div>
              {(l.pro || l.con) && (
                <ul className="pick-nudge__why bleg__why">
                  {l.pro && (
                    <li className="is-for">
                      <span className="pick-nudge__mark" aria-hidden="true">
                        +
                      </span>
                      <span>
                        <span className="sr-only">For it: </span>
                        {l.pro.text}
                      </span>
                    </li>
                  )}
                  {l.con && (
                    <li className="is-against">
                      <span className="pick-nudge__mark" aria-hidden="true">
                        −
                      </span>
                      <span>
                        <span className="sr-only">Against it: </span>
                        {l.con.text}
                      </span>
                    </li>
                  )}
                </ul>
              )}
              {alts.length > 0 && (
                <div className="bleg__swap">
                  <button type="button" className="btn btn--quiet btn--s" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)} disabled={edit?.busy}>
                    {open === k ? 'Keep this leg' : 'Swap this leg'}
                  </button>
                  {open === k && (
                    <ul className="swaps">
                      {alts.map((a) => (
                        <li key={a.id} className="swap">
                          <Headshot src={a.headshot || a.logo} name={a.name} size={32} />
                          <span className="swap__who">
                            <b>{a.short || a.name}</b> {a.shortLabel || a.label}
                            <span className="muted"> {a.teamAbbr} vs {a.oppAbbr}</span>
                          </span>
                          <span className="swap__p num">{pct(a.prob)}</span>
                          <button type="button" className="btn btn--quiet btn--s" onClick={() => swap(k, a)}>
                            Use
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>

      <div className="ticket__acts">
        <button type="button" className="btn btn--lime" onClick={() => importLegs(legs)}>
          Put it on my slip
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => setSending(true)}>
          Send to sportsbook
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => onSim(legs)}>
          Simulate it in detail
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => onAgain(legs.filter((l) => !l.kept).map((l) => l.id))} disabled={busy}>
          Build again without these
        </button>
      </div>
      <SendToBook open={sending} onClose={() => setSending(false)} legs={legs} p={chance} title="Send this parlay to a sportsbook" />
    </article>
  )
}

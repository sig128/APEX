import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { pct, odds, parseOdds, decimalOf, americanOf, kickoff, bookName } from '../lib/format.js'
import { importLegs } from '../lib/slip.js'
import { RULES, PRINCIPLES, edgeAt, kellyQuarter } from '../lib/rules.js'
import { useBilling } from '../context/BillingContext.jsx'
import { Locked } from '../ui/Locked.jsx'
import { Headshot } from '../ui/Img.jsx'
import { ErrorBox, Skeleton } from '../ui/Bits.jsx'
import { ImpliedHint } from '../ui/Odds.jsx'
import { SendToBook } from '../ui/Books.jsx'
import { useSport, apiOf, sp, sportInfo, slateLabel, seasonLabel } from '../lib/sport.js'

const CHECK_SHORT = { prob: '65%+', edge: 'Edge', sample: 'Sample', recency: '15 days', regression: 'Regression', role: 'Role', market: 'Market' }
const STATUS = {
  certified: { label: 'Certified', note: 'Every leg passed all seven checks at posted prices, and the parlay has positive expected value.' },
  price_needed: { label: 'Needs your price', note: 'Every leg passed the checks that don’t need a price. No sportsbook price is posted yet, so it’s only a bet at the break-even price or better.' },
  pass: { label: 'Pass', note: 'Nothing on the board meets the rules right now. Edge or Pass.' },
}
const isDaily = (sport) => sportInfo(sport).calendar === 'day'

/** The 3-Leg Lock: the board run through the APEX rules, the one parlay that survives, and its record. */
export function LockPage() {
  const sport = useSport()
  const daily = isDaily(sport)
  useTitle(`${sportInfo(sport).name} 3-Leg Lock`)
  const { paywall, has } = useBilling()
  const allowed = !paywall || has('pro')
  const lock = useApi(allowed ? `${apiOf(sport)}/lock` : null, { maxAgeMs: 60_000 })
  const ledger = useApi(`${apiOf(sport)}/lock/ledger`, { maxAgeMs: 60_000 })
  const d = lock.data

  return (
    <div className="container page lockpage">
      <header className="page-head">
        <h1 className="page-title">The {sportInfo(sport).name} 3-Leg Lock</h1>
        <p className="page-sub">Every prop on the board, run through the APEX rules. Three legs that each clear 65%, together over 45% before any correlation bonus, with an edge over the price. If nothing survives, it’s a pass.</p>
      </header>

      <Locked need="pro" title={daily ? 'Today’s 3-Leg Lock' : 'This week’s 3-Leg Lock'}>
        {lock.error && !d && <ErrorBox error={lock.error} onRetry={lock.refresh} />}
        {!d && !lock.error && <Skeleton kind="hero" rows={3} />}
        {d && (
          <>
            {d.status === 'pass' ? <PassCard d={d} /> : <Ticket d={d} />}
            <Funnel f={d.funnel} />
            {d.close?.length > 0 && <CloseCalls list={d.close} />}
          </>
        )}
      </Locked>

      <Ledger data={ledger.data} error={ledger.error} daily={daily} sport={sport} />
      <Principles />
    </div>
  )
}

function Ticket({ d }) {
  const sport = useSport()
  const L = d.lock
  const st = STATUS[d.status]
  const [prices, setPrices] = useState({})
  const [open, setOpen] = useState(null)
  const [sending, setSending] = useState(false)
  const typed = L.legs.map((l) => (l.price != null ? l.price : parseOdds(prices[l.id] || '')))
  const allPriced = typed.every((x) => x != null)
  const dec = allPriced ? typed.reduce((s, a) => s * decimalOf(a), 1) : null
  const ev = dec ? L.simulated * dec - 1 : null
  const legOk = L.legs.map((l, i) => (typed[i] == null ? null : edgeAt(l.prob, typed[i])))
  const kelly = dec ? kellyQuarter(L.simulated, dec) : null
  const stake = kelly == null ? RULES.stake.lock : Math.min(kelly, RULES.stake.lock)
  const verdict = !allPriced ? null : ev > 0 && legOk.every((x) => x?.ok) ? 'go' : 'pass'

  return (
    <article className={`ticket ticket--${d.status}`} aria-labelledby="ticket-title">
      <header className="ticket__head">
        <div>
          <p className="ticket__week">{slateLabel(d.week, 'long')}</p>
          <h2 className="ticket__title" id="ticket-title">
            {L.legs.map((l) => l.short || l.name).join(' + ')}
          </h2>
        </div>
        <span className={`ticket__status ticket__status--${d.status}`}>{st.label}</span>
      </header>

      <div className="ticket__numbers">
        <div className="ticket__big">
          <span className="num">{pct(L.simulated, 1)}</span>
          <span className="ticket__big-k">cashes in {L.iterations.toLocaleString()} simulated {isDaily(sport) ? 'nights' : 'weeks'}</span>
        </div>
        <Meter sim={L.simulated} indep={L.independent} />
        <dl className="ticket__facts">
          <div>
            <dt>Legs multiplied</dt>
            <dd className="num">{pct(L.independent, 1)}</dd>
          </div>
          <div>
            <dt>Correlation bonus</dt>
            <dd className="num">
              {L.bonus >= 0 ? '+' : '−'}
              {Math.abs(L.bonus * 100).toFixed(1)} pts
            </dd>
          </div>
          <div>
            <dt>{L.price ? 'Parlay price' : 'Break-even price'}</dt>
            <dd className="num">{odds(L.price ? L.price.american : L.breakEven)}</dd>
          </div>
          <div>
            <dt>Stake</dt>
            <dd className={verdict === 'pass' || kelly == null ? 'is-text' : 'num'}>{verdict === 'pass' ? 'No bet at these prices' : kelly == null ? `Up to ${RULES.stake.lock * 100}% of bankroll` : `${(stake * 100).toFixed(stake < 0.01 ? 2 : 1)}% of bankroll`}</dd>
          </div>
        </dl>
      </div>
      <p className="ticket__note">{st.note}</p>
      {L.pairs?.length > 0 && <p className="ticket__corr">{L.pairs.map((p) => p.text).join('. ')}. That’s the correlation bonus: they share a game script.</p>}

      <ol className="ticket__legs">
        {L.legs.map((l, i) => (
          <li key={l.id} className="tleg">
            <div className="tleg__row">
              <span className="tleg__n num">{i + 1}</span>
              <Headshot src={l.headshot} name={l.name} size={44} />
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
                </p>
              </div>
              <div className="tleg__prob">
                <span className="num">{pct(l.prob)}</span>
                <span className="tleg__fair">fair {odds(l.fair)}</span>
              </div>
            </div>
            <RuleStrip checks={l.checks} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
            {open === i && (
              <ul className="tleg__case">
                {l.checks.map((c) => (
                  <li key={c.key} className={`case case--${c.state}`}>
                    <span className="case__mark" aria-hidden="true" />
                    <span>
                      <b>{c.label}.</b> {c.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="tleg__price">
              {l.price != null ? (
                <span>
                  Best price <b className="num">{odds(l.price)}</b>
                  {l.book ? ` at ${bookName(l.book)}` : ''}: edge {(l.edge * 100).toFixed(1)} pts, EV {l.ev >= 0 ? '+' : ''}
                  {(l.ev * 100).toFixed(1)}%
                </span>
              ) : (
                <label className="tleg__input">
                  <span>
                    Your price <span className="muted">(playable at {odds(l.playable)} or better)</span>
                  </span>
                  <span className="tleg__input-row">
                    <input inputMode="text" placeholder={odds(l.playable)} value={prices[l.id] || ''} onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value }))} aria-label={`Your price for ${l.name} ${l.label}`} />
                    <ImpliedHint a={parseOdds(prices[l.id] || '')} />
                    {legOk[i] && <span className={`tleg__ok ${legOk[i].ok ? 'is-ok' : 'is-no'}`}>{legOk[i].ok ? `Edge ${(legOk[i].edge * 100).toFixed(1)} pts` : 'No edge at this price'}</span>}
                  </span>
                </label>
              )}
            </div>
          </li>
        ))}
      </ol>

      {d.status === 'price_needed' && (
        <div className={`ticket__verdict${verdict ? ` is-${verdict}` : ''}`} aria-live="polite">
          {!verdict && <p>Enter the three prices from your sportsbook to finish the edge check. The parlay has to pay {odds(L.breakEven)} or better.</p>}
          {verdict === 'go' && (
            <p>
              <b>Edge confirmed.</b> At {odds(americanOf(dec))} the lock returns {ev >= 0 ? '+' : ''}${(ev * 100).toFixed(0)} per $100 on average. Stake {(stake * 100).toFixed(1)}% of bankroll.
            </p>
          )}
          {verdict === 'pass' && (
            <p>
              <b>Pass at these prices.</b> {ev <= 0 ? `At ${odds(americanOf(dec))} the parlay loses money on average; it needs ${odds(L.breakEven)} or better.` : 'One of the legs has no edge at its price.'}
            </p>
          )}
        </div>
      )}

      <div className="ticket__acts">
        <button type="button" className="btn btn--gold" onClick={() => importLegs(L.legs, Object.fromEntries(L.legs.map((l, i) => [l.id, typed[i]]).filter(([, v]) => v != null)))}>
          Put the lock on my slip
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => setSending(true)}>
          Send to sportsbook
        </button>
        <Link className="btn btn--quiet" to="/tools/sim">
          Simulate it yourself
        </Link>
      </div>
      <SendToBook open={sending} onClose={() => setSending(false)} legs={L.legs} p={L.simulated} title="Send the lock to a sportsbook" />
    </article>
  )
}

function Meter({ sim, indep }) {
  const w = (p) => `${Math.max(0, Math.min(100, p * 100))}%`
  return (
    <div className="lockmeter" role="img" aria-label={`Simulated ${pct(sim, 1)}, legs multiplied ${pct(indep, 1)}, the rule is 45%`}>
      <div className="lockmeter__track">
        <div className="lockmeter__fill" style={{ width: w(sim) }} />
        <div className="lockmeter__indep" style={{ left: w(indep) }} />
        <div className="lockmeter__rule" style={{ left: w(RULES.comboMin) }}>
          <span>45% rule</span>
        </div>
      </div>
    </div>
  )
}

function RuleStrip({ checks, open, onToggle }) {
  const passed = checks.filter((c) => c.state === 'pass').length
  return (
    <button type="button" className="rules" onClick={onToggle} aria-expanded={open}>
      <span className="rules__dots">
        {checks.map((c) => (
          <span key={c.key} className={`rules__dot rules__dot--${c.state}`} title={`${c.label}: ${c.detail}`}>
            {CHECK_SHORT[c.key] || c.key}
          </span>
        ))}
      </span>
      <span className="rules__sum">
        {passed} of {checks.length} passed{checks.some((c) => c.state === 'pending') ? ', edge waits on a price' : ''}. {open ? 'Hide the case' : 'See the case'}
      </span>
    </button>
  )
}

function PassCard({ d }) {
  const sport = useSport()
  return (
    <article className="ticket ticket--pass">
      <header className="ticket__head">
        <div>
          <p className="ticket__week">{slateLabel(d.week, 'long')}</p>
          <h2 className="ticket__pass num">Pass</h2>
        </div>
        <span className="ticket__status ticket__status--pass">No lock</span>
      </header>
      <p className="ticket__reason">{d.reason}</p>
      <p className="ticket__note">{STATUS.pass.note} A lock that doesn’t meet the rules isn’t a lock, and a pass goes on the season ledger like a result.</p>
      {d.near && d.near.legs.length === 3 && (
        <div className="near">
          <p className="near__k">Closest three</p>
          <ul>
            {d.near.legs.map((l) => (
              <li key={l.id}>
                <Link to={sp(sport, `/prop/${encodeURIComponent(l.id)}`)}>
                  <b>{l.short || l.name}</b> {l.label}
                </Link>
                <span className="num">{pct(l.prob)}</span>
              </li>
            ))}
          </ul>
          <Meter sim={d.near.independent} indep={d.near.independent} />
          <p className="muted">Multiplied: {pct(d.near.independent, 1)}. The rule is 45%.</p>
        </div>
      )}
    </article>
  )
}

const STEPS = [
  ['scanned', 'Props scanned (every line, both teams, every game left)'],
  ['prob', '65% or better to win'],
  ['sample', 'Reliable sample, 8+ games'],
  ['recency', 'Recent form holds, last 15 days first'],
  ['regression', 'The projection backs it, not just a streak'],
  ['role', 'Steady role, not on the injury report'],
  ['market', 'The line hasn’t moved against it'],
  ['edge', 'An edge over the vig, or a price to beat'],
  ['combos', 'Three-leg combinations over 45%'],
  ['qualified', 'No leg pulling against another, positive EV'],
]

function Funnel({ f }) {
  if (!f) return null
  const max = Math.max(1, f.scanned)
  const width = (n) => (n ? `${Math.max(2, (Math.log10(n + 1) / Math.log10(max + 1)) * 100)}%` : '0%')
  return (
    <section className="funnel" aria-labelledby="funnel-h">
      <h2 className="section-h" id="funnel-h">
        How the board got to {f.qualified ? 'the lock' : 'a pass'}
      </h2>
      <ol>
        {STEPS.map(([k, label]) => (
          <li key={k}>
            <span className="funnel__label">{label}</span>
            <span className="funnel__bar">
              <span style={{ width: width(f[k] || 0) }} />
            </span>
            <span className="funnel__n num">{(f[k] || 0).toLocaleString()}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function CloseCalls({ list }) {
  const sport = useSport()
  return (
    <section className="close" aria-labelledby="close-h">
      <h2 className="section-h" id="close-h">
        Close calls
      </h2>
      <p className="muted">65%+ legs a rule kept out.</p>
      <ul>
        {list.map((c) => (
          <li key={c.id}>
            <div>
              <Link to={sp(sport, `/prop/${encodeURIComponent(c.id)}`)}>
                <b>{c.short || c.name}</b> {c.label}
              </Link>
              <span className="num close__p">{pct(c.prob)}</span>
            </div>
            <p className="close__why">
              {c.failed.map((x) => (
                <span key={x.key}>
                  <b>{x.label}:</b> {x.detail}
                </span>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

const RESULT = { win: 'Win', loss: 'Loss', push: 'Push' }

function Ledger({ data, error, daily = false, sport = 'nfl' }) {
  const weeks = data?.weeks || []
  const r = data?.record
  const line = useMemo(() => {
    if (!r) return ''
    const wl = `${r.wins}-${r.losses}${r.pushes ? `-${r.pushes}` : ''}`
    return `${wl}${r.passes ? `, ${r.passes} pass${r.passes === 1 ? '' : 'es'}` : ''}`
  }, [r])
  return (
    <section className="ledger" aria-labelledby="ledger-h">
      <div className="ledger__head">
        <h2 className="section-h" id="ledger-h">
          Season ledger {seasonLabel(sport, data?.season)}
        </h2>
        {r && (
          <p className="ledger__rec">
            <span className="num ledger__wl">{line || '0-0'}</span>
            {r.risked > 0 && (
              <span className={`num ${r.units >= 0 ? 'is-pos' : 'is-neg'}`}>
                {r.units >= 0 ? '+' : ''}
                {r.units.toFixed(1)} units
                {r.roi != null && `, ROI ${(r.roi * 100).toFixed(0)}%`}
              </span>
            )}
          </p>
        )}
      </div>
      <p className="muted">{daily ? 'Every day’s lock as it stood when its first game started' : 'Every week’s lock as it stood when its first leg kicked off'}, graded from the box scores. 1 unit = 1% of bankroll.</p>
      {error && !data && <p className="muted">The ledger isn’t available right now.</p>}
      {data && !weeks.length && <p className="muted">The first lock goes on the ledger {daily ? 'on the next slate' : 'this week'}.</p>}
      {weeks.length > 0 && (
        <ul className="ledger__list">
          {weeks.map((w) => {
            const tag = w.status === 'graded' ? RESULT[w.result] : w.status === 'pass' ? 'Pass' : w.status === 'live' ? 'Live' : 'Open'
            return (
              <li key={w.key} className={`lrow lrow--${(w.result || w.status).toLowerCase()}`}>
                <span className="lrow__wk num">{daily ? slateLabel(w.week, 'tiny') : `W${w.week}`}</span>
                <span className="lrow__legs">
                  {w.lock?.hidden
                    ? `${w.lock.legs} legs, shown to Pro until ${daily ? 'the first game starts' : 'kickoff'}`
                    : w.lock
                      ? w.lock.legs.map((l) => (
                          <span key={l.id} className={`lrow__leg${l.result ? ` is-${l.result}` : ''}`}>
                            {l.short || l.name} {l.label}
                          </span>
                        ))
                      : w.reason || 'No lock met the rules'}
                </span>
                <span className="lrow__tag">{tag}</span>
                <span className="lrow__u num">{w.profit != null ? `${w.profit >= 0 ? '+' : ''}${w.profit.toFixed(1)}u` : ''}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Principles() {
  return (
    <section className="principles" aria-labelledby="pr-h">
      <h2 className="section-h" id="pr-h">
        The rules every APEX answer follows
      </h2>
      <dl>
        {PRINCIPLES.map((p) => (
          <div key={p.k}>
            <dt>{p.k}</dt>
            <dd>{p.v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

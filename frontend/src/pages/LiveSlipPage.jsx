import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useTitle } from '../lib/hooks.js'
import { useAuth } from '../context/AuthContext.jsx'
import { pct, odds, parseOdds, decimalOf } from '../lib/format.js'
import { Skeleton, Empty } from '../ui/Bits.jsx'
import { Headshot } from '../ui/Img.jsx'
import { liveWord } from '../ui/PropRow.jsx'

// a price typed in is good for this long; after that the suggestion hides until it's updated
const FRESH_MS = 60_000

const u = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}u`

/**
 * Your picks in play: where each leg stands, the chance the slip still cashes, and its fair
 * value. Type the cash-out offer or a hedge price from your book to compare holding, cashing out
 * and hedging. No suggestion shows without a price typed in the last minute.
 */
export function LiveSlipPage() {
  const { user, loading: authLoading } = useAuth()
  const [state, setState] = useState({ data: null, err: null })
  const [tick, setTick] = useState(0)
  useTitle('Live slips')

  useEffect(() => {
    if (!user) return undefined
    let live = true
    const load = () =>
      api('/api/picks/me/live')
        .then((data) => live && setState({ data, err: null }))
        .catch((err) => live && setState((s) => ({ data: s.data, err })))
    load()
    const every = setInterval(load, 20_000)
    const clock = setInterval(() => setTick((t) => t + 1), 1000)
    return () => {
      live = false
      clearInterval(every)
      clearInterval(clock)
    }
  }, [user])

  if (authLoading) return <div className="container page"><Skeleton rows={4} /></div>
  if (!user) return <Navigate to="/login?next=/me/live" replace />
  const d = state.data
  const age = d?.at ? Math.max(0, Math.round((Date.now() - d.at) / 1000)) : null
  return (
    <div className="container page narrow">
      <header className="page-head">
        <h1 className="page-title">Live slips</h1>
        <p className="page-sub">
          Your picks in play. Stats update about every {Math.round((d?.refreshMs || 20_000) / 1000)} seconds{age != null ? `; last update ${age < 5 ? 'just now' : `${age}s ago`}` : ''}.
        </p>
      </header>
      {state.err && !d && <p className="form-err">{state.err.message}</p>}
      {!d ? (
        <Skeleton rows={5} />
      ) : !d.picks.length ? (
        <Empty title="Nothing in play right now" action={<Link to="/me" className="btn btn--quiet">Back to my page</Link>}>
          Picks show up here once their first game starts.
        </Empty>
      ) : (
        <div className="stack">
          {d.picks.map((p) => (
            <LiveSlip key={p.id} p={p} tick={tick} />
          ))}
        </div>
      )}
      <p className="muted small">The live chance assumes each player keeps producing at his projected rate for the time left, with the usual game-to-game swings. It doesn’t see foul trouble, injuries during the game or blowouts.</p>
    </div>
  )
}

export function LiveSlip({ p, tick }) {
  const [offer, setOffer] = useState({ v: '', at: 0 })
  const [hedge, setHedge] = useState({ v: '', at: 0 })
  void tick // re-rendered every second so stale prices drop out
  const now = Date.now()
  const offerUnits = Number(offer.v)
  const offerFresh = offer.v !== '' && Number.isFinite(offerUnits) && offerUnits >= 0 && now - offer.at < FRESH_MS
  const hedgeOdds = parseOdds(hedge.v)
  const hedgeFresh = Number.isFinite(hedgeOdds) && now - hedge.at < FRESH_MS
  const open = p.legs.filter((l) => !l.result && Number.isFinite(l.chance) && l.chance > 0 && l.chance < 1)
  const fair = p.fair
  // hedging the last open leg: the stake on the other side that pays the same either way.
  // Win: payout - units - stake. Lose: stake x (h - 1) - units. Equal when stake = payout / h.
  // Against holding it costs stake x (1 - (1 - q) x h) in expected value (negative = it gains).
  let hedgeMath = null
  if (hedgeFresh && open.length === 1 && Number.isFinite(p.chance)) {
    const h = decimalOf(hedgeOdds)
    if (h > 1) {
      const stake = p.payout / h
      hedgeMath = { stake, locked: p.payout - p.units - stake, cost: stake * (1 - (1 - p.chance) * h) }
    }
  }
  const suggestion = (() => {
    if (!Number.isFinite(fair)) return null
    if (offerFresh) {
      const gap = offerUnits - fair
      if (gap >= 0) return { kind: 'cash', text: `Cash out: the offer of ${offerUnits.toFixed(2)}u is at least the slip’s fair value of ${fair.toFixed(2)}u.` }
      return { kind: 'hold', text: `Hold: the offer is ${Math.abs(gap).toFixed(2)}u below the slip’s fair value (${fair.toFixed(2)}u), so cashing out gives that up on average.` }
    }
    if (hedgeMath) {
      const cost = hedgeMath.cost
      if (cost <= 0) return { kind: 'hedge', text: `Hedge: ${odds(hedgeOdds)} on the other side is better than its live chance. Betting ${hedgeMath.stake.toFixed(2)}u there locks in ${u(hedgeMath.locked)} either way.` }
      return { kind: 'hold', text: `Hold has the higher expected value. Hedging ${hedgeMath.stake.toFixed(2)}u at ${odds(hedgeOdds)} locks in ${u(hedgeMath.locked)} either way, at a cost of ${cost.toFixed(2)}u in expected value.` }
    }
    return null
  })()
  return (
    <article className="live-slip">
      <ul className="live-slip__legs">
        {p.legs.map((l) => (
          <li key={l.id} className={`live-leg is-${l.result || l.live?.status || 'wait'}`}>
            <Headshot src={l.headshot} name={l.name} size={30} />
            <span className="live-leg__what">
              <b>{l.short || l.name}</b> {l.label}
              <span className="muted small">
                {l.result
                  ? l.result === 'win'
                    ? 'Hit'
                    : l.result === 'loss'
                      ? 'Missed'
                      : l.result
                  : l.live
                    ? `${l.live.cur} so far, ${liveWord(l.live).toLowerCase()}${Number.isFinite(l.live.elapsed) ? `, ${Math.round(l.live.elapsed * 100)}% played` : ''}`
                    : 'Waiting for its game'}
              </span>
            </span>
            <span className="live-leg__chance num">{Number.isFinite(l.chance) ? pct(l.chance) : '–'}</span>
          </li>
        ))}
      </ul>
      <dl className="live-slip__sum">
        <div>
          <dt>Chance it cashes</dt>
          <dd className="num">{Number.isFinite(p.chance) ? pct(p.chance, 1) : '–'}</dd>
        </div>
        <div>
          <dt>Pays</dt>
          <dd className="num">
            {p.payout.toFixed(2)}u <span className="muted">({odds(p.price)}, {p.units}u)</span>
          </dd>
        </div>
        <div>
          <dt>Fair value now</dt>
          <dd className="num">{Number.isFinite(fair) ? `${fair.toFixed(2)}u` : '–'}</dd>
        </div>
      </dl>
      {Number.isFinite(p.chance) && p.chance > 0 && p.chance < 1 && (
        <div className="live-slip__tools">
          <label className="field">
            <span>Cash-out offer from your book (units back)</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={offer.v} onChange={(e) => setOffer({ v: e.target.value, at: Date.now() })} placeholder="e.g. 3.40" />
          </label>
          {open.length === 1 && (
            <label className="field">
              <span>Price on the other side of {open[0].short || open[0].name}’s leg</span>
              <input value={hedge.v} onChange={(e) => setHedge({ v: e.target.value, at: Date.now() })} placeholder="e.g. +150" inputMode="text" />
            </label>
          )}
          {suggestion ? (
            <p className={`live-slip__say is-${suggestion.kind}`} role="status">
              {suggestion.text}
            </p>
          ) : (
            <p className="muted small">Type the current cash-out offer{open.length === 1 ? ' or a hedge price' : ''} to compare. Prices older than a minute are ignored.</p>
          )}
        </div>
      )}
    </article>
  )
}

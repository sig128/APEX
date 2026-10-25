import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useSlip } from '../lib/useSlip.js'
import { removeLeg, setLegPrice, setParlayPrice, setMode, clearSlip, parlayMath, shareUrl, slipText } from '../lib/slip.js'
import { pct, odds, parseOdds, decimalOf } from '../lib/format.js'
import { kellyFraction } from '../lib/kelly.js'
import { useCopy } from '../lib/hooks.js'
import { api } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { Headshot } from './Img.jsx'
import { Dialog } from './Dialog.jsx'
import { ImpliedHint } from './Odds.jsx'

const BANKROLL_KEY = 'apex_bankroll'
const FRACTIONS = [
  { k: 0.25, label: 'Quarter' },
  { k: 0.5, label: 'Half' },
  { k: 1, label: 'Full' },
]

function readNum(key, fallback) {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

/** Odds box that accepts "-110", "+150" or "150" and keeps what you typed until it parses. */
function OddsInput({ value, onChange, label, placeholder = '-110' }) {
  const [text, setText] = useState(Number.isFinite(value) ? (value > 0 ? `+${value}` : String(value)) : '')
  useEffect(() => {
    setText(Number.isFinite(value) ? (value > 0 ? `+${value}` : String(value)) : '')
  }, [value])
  const bad = text.trim() !== '' && parseOdds(text) == null
  return (
    <input
      className={`odds-input${bad ? ' is-bad' : ''}`}
      inputMode="numeric"
      aria-label={label}
      aria-invalid={bad}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = parseOdds(e.target.value)
        if (n != null || e.target.value.trim() === '') onChange(n)
      }}
    />
  )
}

export function SlipPanel({ open, onClose }) {
  const slip = useSlip()
  const { legs, mode } = slip
  const { user } = useAuth()
  const { has, paywall } = useBilling()
  const nav = useNavigate()
  const [copy, copied] = useCopy()
  const [copyLink, linkCopied] = useCopy()
  const [bankroll, setBankroll] = useState(() => readNum(BANKROLL_KEY, 1000))
  const [frac, setFrac] = useState(0.25)
  const [posting, setPosting] = useState(false)
  const [live, setLive] = useState({})
  const math = useMemo(() => parlayMath(legs, slip.parlayPrice), [legs, slip.parlayPrice])
  const canKelly = !paywall || has('pro')

  useEffect(() => {
    try {
      localStorage.setItem(BANKROLL_KEY, String(bankroll))
    } catch {
      /* ignore */
    }
  }, [bankroll])

  // Started games: show where each leg stands right now.
  useEffect(() => {
    if (!open || !legs.length) return undefined
    const started = legs.some((l) => Date.parse(l.kickoff) < Date.now())
    if (!started) return undefined
    let stop = false
    const tick = () =>
      api(`/api/nfl/track?ids=${encodeURIComponent(legs.map((l) => l.id).join(','))}`, { auth: false })
        .then((r) => !stop && setLive(Object.fromEntries(r.legs.filter((x) => x.live).map((x) => [x.id, x.live]))))
        .catch(() => {})
    tick()
    const t = setInterval(tick, 15_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [open, legs])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const share = async () => {
    const url = shareUrl(legs)
    if (navigator.share) {
      try {
        await navigator.share({ title: 'APEX slip', text: slipText(legs, slip.parlayPrice), url })
        return
      } catch (e) {
        if (e?.name === 'AbortError') return
      }
    }
    copyLink(url)
  }

  return (
    <>
      <div className={`slip-scrim${open ? ' is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`slip${open ? ' is-open' : ''}`} aria-label="Bet slip" aria-hidden={!open} inert={!open}>
        <div className="slip__head">
          <h2 className="slip__title">
            Slip <span className="num">{legs.length}</span>
          </h2>
          {legs.length > 1 && (
            <div className="seg" role="group" aria-label="Slip type">
              <button type="button" className={mode === 'parlay' ? 'is-on' : ''} aria-pressed={mode === 'parlay'} onClick={() => setMode('parlay')}>
                Parlay
              </button>
              <button type="button" className={mode === 'singles' ? 'is-on' : ''} aria-pressed={mode === 'singles'} onClick={() => setMode('singles')}>
                Singles
              </button>
            </div>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close slip">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {!legs.length ? (
          <div className="slip__empty">
            <p>Your slip is empty.</p>
            <p className="muted">Tap + on any prop to add it. APEX multiplies the probabilities, prices the parlay fairly, and sizes your stake.</p>
            <Link to="/nfl/props" className="btn btn--quiet" onClick={onClose}>
              Find props
            </Link>
          </div>
        ) : (
          <>
            <ul className="slip__legs">
              {legs.map((l) => {
                const lv = live[l.id]
                const d = decimalOf(l.price)
                const k = d ? kellyFraction(l.prob, d) : null
                return (
                  <li key={l.id} className={`slip-leg${lv ? ` is-${lv.status}` : ''}`}>
                    <Headshot src={l.headshot} name={l.name} size={34} />
                    <div className="slip-leg__what">
                      <Link to={`/nfl/prop/${encodeURIComponent(l.id)}`} onClick={onClose} className="slip-leg__name">
                        {l.name}
                      </Link>
                      <span className="slip-leg__label">{l.label}</span>
                      <span className="slip-leg__read">
                        APEX <b className="num">{pct(l.prob)}</b> fair {odds(l.fair)}
                        {lv && (
                          <span className="slip-leg__live">
                            {lv.cur} now{lv.final ? `, ${lv.status === 'hit' ? 'hit' : lv.status === 'push' ? 'push' : 'missed'}` : ''}
                          </span>
                        )}
                        {mode === 'singles' && d && <span className={k > 0 ? 'is-plus' : 'is-minus'}> {k > 0 ? `edge ${pct(l.prob * d - 1, 1)}` : 'no edge at that price'}</span>}
                      </span>
                    </div>
                    <span className="odds-field">
                      <OddsInput value={l.price} onChange={(n) => setLegPrice(l.id, n)} label={`Your odds for ${l.name} ${l.shortLabel || l.label}`} />
                      <ImpliedHint a={l.price} />
                    </span>
                    <button type="button" className="icon-btn" onClick={() => removeLeg(l.id)} aria-label={`Remove ${l.name}`}>
                      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                        <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  </li>
                )
              })}
            </ul>

            {mode === 'parlay' && legs.length > 1 && math && (
              <div className="slip__math">
                <div className="slip__row">
                  <span>APEX chance all {legs.length} hit</span>
                  <b className="num">{pct(math.prob, 1)}</b>
                </div>
                <div className="slip__row">
                  <span>Fair parlay price</span>
                  <b className="num">{odds(math.fair)}</b>
                </div>
                <div className="slip__row">
                  <label htmlFor="parlay-odds">Your parlay odds</label>
                  <span className="odds-field">
                    <OddsInput value={slip.parlayPrice ?? (math.priced ? math.book : null)} onChange={(n) => setParlayPrice(n)} label="Your parlay odds" placeholder={math.priced ? odds(math.book) : '+600'} />
                    <ImpliedHint a={slip.parlayPrice ?? (math.priced ? math.book : null)} />
                  </span>
                </div>
                {math.sameGame && <p className="slip__warn">Legs from the same game tend to win or lose together, so the real chance is different from the multiplied one. Books price same-game parlays for that.</p>}
              </div>
            )}

            {(mode === 'parlay' ? math?.priced : legs.some((l) => Number.isFinite(l.price))) && (
              <div className="slip__kelly">
                <div className="slip__kelly-head">
                  <p className="slip__kelly-title">Stake</p>
                  {canKelly && (
                  <div className="seg seg--s" role="group" aria-label="Kelly fraction">
                    {FRACTIONS.map((f) => (
                      <button key={f.k} type="button" className={frac === f.k ? 'is-on' : ''} aria-pressed={frac === f.k} onClick={() => setFrac(f.k)}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                  )}
                </div>
                {canKelly ? (
                  <>
                    <label className="slip__bankroll">
                      Bankroll
                      <input inputMode="decimal" value={bankroll} onChange={(e) => setBankroll(Math.max(1, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0))} aria-label="Bankroll in dollars" />
                    </label>
                    {mode === 'parlay' && legs.length > 1 ? (
                      <StakeLine p={math.prob} d={math.bookDecimal} bankroll={bankroll} frac={frac} />
                    ) : (
                      legs.filter((l) => Number.isFinite(l.price)).map((l) => <StakeLine key={l.id} p={l.prob} d={decimalOf(l.price)} bankroll={bankroll} frac={frac} label={l.short || l.name} />)
                    )}
                    <p className="muted small">Kelly sizes each bet by your edge at your price. Quarter Kelly gives up a little growth for much smaller swings.</p>
                  </>
                ) : (
                  <p className="slip__locked">
                    Kelly stake sizing is part of Pro. <Link to="/pricing" onClick={onClose}>See plans</Link>
                  </p>
                )}
              </div>
            )}

            <div className="slip__actions">
              <button type="button" className="btn btn--quiet" onClick={() => copy(slipText(legs, slip.parlayPrice))}>
                {copied ? 'Copied' : 'Copy slip'}
              </button>
              <button type="button" className="btn btn--quiet" onClick={share}>
                {linkCopied ? 'Link copied' : 'Share link'}
              </button>
              <button
                type="button"
                className="btn btn--gold"
                onClick={() => {
                  if (!user) {
                    onClose()
                    nav('/login?next=/me')
                    return
                  }
                  setPosting(true)
                }}
              >
                Post as pick
              </button>
              <Link
                className="btn btn--quiet"
                to={`/nfl/slip?legs=${encodeURIComponent(legs.map((l) => l.id).join(','))}`}
                onClick={onClose}
              >
                Track
              </Link>
              <button type="button" className="linkish slip__clear" onClick={clearSlip}>
                Clear slip
              </button>
            </div>
          </>
        )}
      </aside>
      <PostPick open={posting} onClose={() => setPosting(false)} legs={legs} mode={mode} />
    </>
  )
}

function StakeLine({ p, d, bankroll, frac, label }) {
  if (!d) return null
  const f = kellyFraction(p, d) * frac
  const stake = bankroll * Math.min(0.25, f)
  const ev = p * d - 1
  return (
    <div className="slip__row slip__stake">
      <span>{label ? `${label}: ` : ''}{ev > 0 ? `edge ${pct(ev, 1)}` : 'no edge at this price'}</span>
      <b className="num">{ev > 0 ? `$${stake.toFixed(stake >= 100 ? 0 : 2)}` : '$0'}</b>
    </div>
  )
}

/** Post the slip to your picks page. Picks lock at kickoff and grade themselves. */
function PostPick({ open, onClose, legs, mode }) {
  const [units, setUnits] = useState(1)
  const [note, setNote] = useState('')
  const [separate, setSeparate] = useState(mode === 'singles')
  const [state, setState] = useState({ busy: false, err: null, done: null })
  const nav = useNavigate()
  const [checked, setChecked] = useState([])
  useEffect(() => {
    if (!open) return undefined
    setSeparate(mode === 'singles')
    setState({ busy: false, err: null, done: null })
    setChecked([])
    // ask up front which legs can go on a record, so nobody fills in the form for nothing
    const ac = new AbortController()
    api('/api/picks/check', { method: 'POST', body: { legs: legs.map((l) => l.id) }, signal: ac.signal })
      .then((r) => setChecked(r.legs || []))
      .catch(() => {})
    return () => ac.abort()
  }, [open, mode])
  // legs that can't go on a record and are still on the slip (from the check or from a post)
  const onSlip = (b) => legs.some((l) => l.id === b.id)
  const bad = [...new Map([...checked, ...(state.err?.body?.legs || [])].filter(onSlip).map((b) => [b.id, b])).values()]
  const blocked = bad.length > 0
  useEffect(() => {
    if (state.err?.body?.legs?.length && !bad.length) setState((x) => ({ ...x, err: null }))
  }, [state.err, bad.length])
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true, err: null, done: null })
    try {
      const out = await api('/api/picks', { method: 'POST', body: { legs: legs.map((l) => l.id), mode: separate ? 'separate' : 'parlay', units, note } })
      setState({ busy: false, err: null, done: out })
    } catch (err) {
      setState({ busy: false, err, done: null })
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Post to your picks page">
      {state.done ? (
        <div className="stack">
          <p>
            Posted {state.done.picks.length === 1 ? 'your pick' : `${state.done.picks.length} picks`}. {state.done.picks[0].legs.length > 1 ? 'The parlay' : 'It'} locks at kickoff and grades itself when the game ends.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn--gold"
              onClick={() => {
                onClose()
                nav('/me')
              }}
            >
              See my page
            </button>
            <button type="button" className="btn btn--quiet" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {legs.length > 1 && (
            <div className="seg" role="group" aria-label="Post as">
              <button type="button" className={!separate ? 'is-on' : ''} aria-pressed={!separate} onClick={() => setSeparate(false)}>
                One {legs.length}-leg parlay
              </button>
              <button type="button" className={separate ? 'is-on' : ''} aria-pressed={separate} onClick={() => setSeparate(true)}>
                {legs.length} single picks
              </button>
            </div>
          )}
          <label className="field">
            <span>Units{separate && legs.length > 1 ? ' on each' : ''}</span>
            <input type="number" min="0.1" max="10" step="0.1" value={units} onChange={(e) => setUnits(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Note (optional)</span>
            <textarea maxLength={280} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you like it" />
          </label>
          {state.err && !bad.length && (
            <p className="form-err" role="alert">
              {state.err.message}
              {state.err.code === 'no_profile' && (
                <>
                  {' '}
                  <Link to="/me" onClick={onClose}>
                    Make your page
                  </Link>
                </>
              )}
            </p>
          )}
          {bad.length > 0 && (
            <div className="form-err" role="alert">
              <p>{bad.length === 1 ? 'This leg can’t go on a record:' : `These ${bad.length} legs can’t go on a record:`}</p>
              <ul className="bad-legs">
                {bad.map((b) => (
                  <li key={b.id}>
                    <span>{b.error}</span>
                    <button type="button" className="btn btn--quiet btn--s" onClick={() => removeLeg(b.id)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="row">
            <button type="submit" className="btn btn--gold" disabled={state.busy || blocked || !legs.length}>
              {state.busy ? 'Posting' : 'Post pick'}
            </button>
            <button type="button" className="btn btn--quiet" onClick={onClose}>
              Cancel
            </button>
          </div>
          <p className="muted small">Only lines a sportsbook posted count, graded at the price it posted when you post (main lines with no listed price grade at -110), not the odds you typed, so every record is scored the same way. You can delete a pick until kickoff.</p>
        </form>
      )}
    </Dialog>
  )
}

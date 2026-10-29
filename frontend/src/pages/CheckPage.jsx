import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { streamNdjson } from '../lib/api.js'
import { streamUrl } from '../lib/config.js'
import { useTitle } from '../lib/hooks.js'
import { useSlip } from '../lib/useSlip.js'
import { importLegs } from '../lib/slip.js'
import { pct, odds, parseOdds } from '../lib/format.js'
import { useBilling } from '../context/BillingContext.jsx'
import { Locked } from '../ui/Locked.jsx'
import { ImpliedHint } from '../ui/Odds.jsx'
import { Headshot } from '../ui/Img.jsx'
import { useSport, apiOf, sp, sportInfo, SPORTS, setLeague, legRef, legsSport } from '../lib/sport.js'

const MODES = [
  { key: 'shot', label: 'Screenshot' },
  { key: 'text', label: 'Type it out' },
  { key: 'slip', label: 'My Propify slip' },
]
const VERDICT = { KEEP: 'Keep', CUT: 'Cut', SWAP: 'Swap', RISKY: 'Risky' }
// what a typed-out slip looks like in each league
const EXAMPLE = {
  nfl: 'Jared Goff over 245.5 passing yards -115\nAmon-Ra St. Brown 6+ receptions\nJahmyr Gibbs anytime TD +120',
  ncaaf: 'Quarterback over 245.5 passing yards -115\nReceiver 5+ receptions\nRunning back anytime TD +120',
  nba: 'Jalen Brunson over 26.5 points -115\nVictor Wembanyama 10+ rebounds\nTyrese Haliburton over 8.5 assists +105',
  ncaab: 'Guard over 18.5 points -115\nCenter 8+ rebounds\nForward over 1.5 threes +120',
  wnba: 'A’ja Wilson over 22.5 points -115\nCaitlin Clark 7+ assists\nNapheesa Collier over 8.5 rebounds +105',
  mlb: 'Aaron Judge over 1.5 total bases -120\nTarik Skubal 7+ strikeouts\nShohei Ohtani to hit a home run +250',
  nhl: 'Connor McDavid over 1.5 points +110\nAuston Matthews anytime goal +130\nIgor Shesterkin over 27.5 saves -115',
}

/** The AI's call, held to the rules: a leg that fails a Propify rule check can't be a Keep. */
const finalCall = (leg, call) => (call?.v === 'KEEP' && leg.lean !== 'keep' ? { ...call, v: 'RISKY', overridden: true } : call)
const LEAN = { keep: 'Looks solid', risky: 'Risky', cut: 'Weak link' }

/** "LEG 2: CUT | reason", "OVERALL: ...", "BEST: ..." -> { legs: {2: {v, why}}, overall, best } */
export function parseCheck(text) {
  const legs = {}
  let overall = ''
  let best = ''
  let cur = null
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\*\*/g, '').trim()
    if (!line) continue
    const m = /^LEG\s*(\d+)\s*[:.-]\s*(KEEP|CUT|SWAP)\b\s*[|:–-]?\s*(.*)$/i.exec(line)
    if (m) {
      legs[Number(m[1])] = { v: m[2].toUpperCase(), why: m[3] }
      cur = { kind: 'leg', n: Number(m[1]) }
      continue
    }
    const o = /^OVERALL\s*[:\-–]\s*(.*)$/i.exec(line)
    if (o) {
      overall = o[1]
      cur = { kind: 'overall' }
      continue
    }
    const b = /^BEST\s*[:\-–]\s*(.*)$/i.exec(line)
    if (b) {
      best = b[1]
      cur = { kind: 'best' }
      continue
    }
    if (cur?.kind === 'leg') legs[cur.n].why += ` ${line}`
    else if (cur?.kind === 'overall') overall += ` ${line}`
    else if (cur?.kind === 'best') best += ` ${line}`
  }
  return { legs, overall: overall.trim(), best: best.trim() }
}

/** Shrink a screenshot to at most 1600px on the long side as a JPEG, so it uploads quickly. */
async function shrink(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('That file is not an image we can read.'))
      i.src = url
    })
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * scale)
    c.height = Math.round(img.naturalHeight * scale)
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    let q = 0.85
    let data = c.toDataURL('image/jpeg', q)
    while (data.length > 1_500_000 && q > 0.4) {
      q -= 0.15
      data = c.toDataURL('image/jpeg', q)
    }
    return { preview: data, image: { type: 'image/jpeg', data: data.split(',')[1] } }
  } finally {
    URL.revokeObjectURL(url)
  }
}

const IDLE = { state: 'idle', legs: null, unmatched: [], notes: '', sim: null, text: '', err: null, usage: null }

/** Paste, upload or bring your slip; the AI keeps or cuts every leg, with the numbers behind it. */
export function CheckPage() {
  const sport = useSport()
  useTitle('Parlay check')
  const slip = useSlip()
  const { refresh } = useBilling()
  const [mode, setMode] = useState(slip.legs.length ? 'slip' : 'shot')
  const [text, setText] = useState('')
  const [shot, setShot] = useState(null)
  const [priceText, setPriceText] = useState('')
  const [run, setRun] = useState(IDLE)
  const [drag, setDrag] = useState(false)
  const ctrl = useRef(null)
  const fileRef = useRef(null)

  const pick = async (file) => {
    if (!file) return
    try {
      setShot({ busy: true })
      setShot(await shrink(file))
    } catch (e) {
      setShot(null)
      setRun({ ...IDLE, state: 'error', err: e })
    }
  }

  const ready = mode === 'shot' ? Boolean(shot?.image) : mode === 'text' ? text.trim().length > 6 : slip.legs.length > 0
  const busy = run.state === 'reading' || run.state === 'streaming'

  const go = async () => {
    ctrl.current?.abort()
    const ac = new AbortController()
    ctrl.current = ac
    const body = { price: parseOdds(priceText) ?? (mode === 'slip' ? slip.parlayPrice : null) }
    if (mode === 'shot') body.image = shot.image
    if (mode === 'text') body.text = text
    if (mode === 'slip') {
      body.legs = slip.legs.map(legRef)
      body.prices = Object.fromEntries(slip.legs.filter((l) => Number.isFinite(l.price)).map((l) => [legRef(l), l.price]))
    }
    // a screenshot or typed slip is read against the league picked here; the Propify slip's legs know theirs
    const league = mode === 'slip' ? legsSport(slip.legs, sport) : sport
    setRun({ ...IDLE, state: 'reading' })
    let acc = ''
    try {
      const { last, usage } = await streamNdjson(streamUrl(`${apiOf(league)}/check`), body, {
        signal: ac.signal,
        onEvent: (ev) => {
          if (ctrl.current !== ac) return
          if (ev.type === 'legs') setRun((r) => ({ ...r, state: 'streaming', legs: ev.legs, unmatched: ev.unmatched || [], notes: ev.notes || '' }))
          if (ev.type === 'sim') setRun((r) => ({ ...r, sim: ev }))
          if (ev.type === 'text_delta') {
            acc += ev.text
            setRun((r) => ({ ...r, text: acc }))
          }
          if (ev.type === 'complete') setRun((r) => ({ ...r, text: ev.text || acc }))
        },
      })
      if (last?.type === 'error') throw new Error(last.error)
      setRun((r) => ({ ...r, state: 'done', usage }))
      refresh?.()
    } catch (e) {
      if (e?.name === 'AbortError') return setRun((r) => ({ ...r, state: r.legs ? 'done' : 'idle' }))
      setRun((r) => ({ ...r, state: 'error', err: e }))
    }
  }

  const verdict = parseCheck(run.text)
  const keepers = (run.legs || []).filter((l) => finalCall(l, verdict.legs[l.n])?.v === 'KEEP')

  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Parlay check</h1>
        <p className="page-sub">Show Propify the parlay before you place it. Every leg gets a call, keep, cut or swap, with the numbers behind it, and the whole slip is played out 20,000 times.</p>
      </header>
      <Locked need="pro" ai title="The parlay check">
        <div className="pcheck">
          <section className="check__in" aria-label="Your parlay">
            <div className="seg" role="tablist" aria-label="How to add your parlay">
              {MODES.map((m) => (
                <button key={m.key} type="button" role="tab" aria-selected={mode === m.key} className={mode === m.key ? 'is-on' : ''} onClick={() => setMode(m.key)}>
                  {m.label}
                </button>
              ))}
            </div>

            {mode === 'shot' && (
              <div
                className={`drop${drag ? ' is-drag' : ''}${shot?.preview ? ' has-shot' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDrag(true)
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDrag(false)
                  pick(e.dataTransfer.files?.[0])
                }}
                onPaste={(e) => pick([...(e.clipboardData?.files || [])][0])}
              >
                {shot?.preview ? (
                  <>
                    <img className="drop__img" src={shot.preview} alt="Your betslip" />
                    <button type="button" className="btn btn--quiet drop__swap" onClick={() => fileRef.current?.click()}>
                      Use a different screenshot
                    </button>
                  </>
                ) : (
                  <button type="button" className="drop__pick" onClick={() => fileRef.current?.click()}>
                    <span className="drop__title">{shot?.busy ? 'Reading the image…' : 'Upload a screenshot of your betslip'}</span>
                    <span className="drop__sub">Drop it here, paste it, or tap to choose. Any sportsbook works.</span>
                  </button>
                )}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
              </div>
            )}

            {mode !== 'slip' && (
              <label className="field field--inline check__league">
                <span>League</span>
                <select value={sport} onChange={(e) => setLeague(e.target.value)}>
                  {SPORTS.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.title}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {mode === 'text' && (
              <label className="field">
                <span>Your legs, one per line</span>
                <textarea className="check__text" rows={6} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE[sport] || EXAMPLE.nfl} />
              </label>
            )}

            {mode === 'slip' &&
              (slip.legs.length ? (
                <ul className="sim__legs">
                  {slip.legs.map((l) => (
                    <li key={legRef(l)}>
                      <Headshot src={l.headshot} name={l.name} size={28} />
                      <span>
                        <b>{l.short || l.name}</b> {l.shortLabel || l.label}
                      </span>
                      <span className="num muted">{Number.isFinite(l.price) ? odds(l.price) : `Propify ${pct(l.prob)}`}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  Your slip is empty. <Link to={sp(sport, '/props')}>Add props from the board</Link>, or upload a screenshot instead.
                </p>
              ))}

            <div className="check__go">
              <label className="field check__price">
                <span>Parlay odds on your slip (optional)</span>
                <span className="check__price-row">
                  <input className="input" inputMode="text" placeholder="+600" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
                  <ImpliedHint a={parseOdds(priceText)} />
                </span>
              </label>
              {busy ? (
                <button type="button" className="btn btn--quiet" onClick={() => ctrl.current?.abort()}>
                  Stop
                </button>
              ) : (
                <button type="button" className="btn btn--gold" disabled={!ready} onClick={go}>
                  Check my parlay
                </button>
              )}
            </div>
            <p className="check__fine">Uses one AI read. {mode === 'slip' ? 'Player props' : `${sportInfo(sport).name} player props`}{['nfl', 'ncaaf'].includes(sport) || mode === 'slip' ? ' and team totals' : ''}; moneylines and spreads are skipped.</p>
          </section>

          <section className="check__out" aria-live="polite" aria-label="The verdict">
            {run.state === 'idle' && <CheckEmpty />}
            {run.state === 'reading' && <p className="check__wait">Reading your slip and finding each leg on the board…</p>}
            {run.err && (
              <p className="ask__err" role="alert">
                {run.err.message}
              </p>
            )}
            {run.err?.body?.unmatched?.length > 0 && <Unmatched list={run.err.body.unmatched} />}
            {run.legs && (
              <>
                {run.sim && <SimLine sim={run.sim} n={run.legs.length} />}
                <ol className="calls">
                  {run.legs.map((l) => (
                    <Call key={legRef(l)} leg={l} call={finalCall(l, verdict.legs[l.n])} sim={run.sim?.legs?.find((x) => x.id === l.id)} streaming={run.state === 'streaming'} />
                  ))}
                </ol>
                {(verdict.overall || verdict.best) && (
                  <div className="check__sum">
                    {verdict.overall && <p>{verdict.overall}</p>}
                    {verdict.best && (
                      <p className="check__best">
                        <b>Play instead:</b> {verdict.best}
                      </p>
                    )}
                  </div>
                )}
                {run.unmatched.length > 0 && <Unmatched list={run.unmatched} />}
                {run.notes && <p className="muted check__fine">From the slip: {run.notes}</p>}
                {run.state === 'done' && (
                  <div className="check__acts">
                    {keepers.length > 0 && keepers.length < run.legs.length && (
                      <button type="button" className="btn btn--gold" onClick={() => importLegs(keepers.map((k) => ({ ...k, kind: 'player' })), Object.fromEntries(keepers.filter((k) => Number.isFinite(k.odds)).map((k) => [legRef(k), k.odds])))}>
                        {keepers.length === 1 ? 'Put the keeper on my slip' : `Put the ${keepers.length} keepers on my slip`}
                      </button>
                    )}
                    <Link className="btn btn--quiet" to="/tools/sim">
                      Simulate it in depth
                    </Link>
                  </div>
                )}
                {run.usage && <p className="ask__usage">{run.usage.split('/')[0]} of {run.usage.split('/')[1]} AI reads used today</p>}
              </>
            )}
          </section>
        </div>
      </Locked>
    </div>
  )
}

function CheckEmpty() {
  return (
    <div className="check__empty">
      <p className="check__empty-title">What you get back</p>
      <ul>
        <li>
          <b className="call-tag call-tag--keep">Keep</b> the legs the numbers back.
        </li>
        <li>
          <b className="call-tag call-tag--cut">Cut</b> the ones dragging the parlay down, and why.
        </li>
        <li>
          <b className="call-tag call-tag--swap">Swap</b> a better bet on the same player when there is one.
        </li>
      </ul>
      <p className="muted">Plus how often the whole parlay cashes in 20,000 simulated games, and whether the price is worth it.</p>
    </div>
  )
}

function SimLine({ sim, n }) {
  const p = sim.parlay
  const pr = sim.price
  return (
    <div className="check__sim">
      <div>
        <p className="sim-head__k">Cashes in</p>
        <p className="check__big num">{pct(p.hitRate, 1)}</p>
        <p className="muted">of {sim.iterations.toLocaleString()} simulated games, {n} legs</p>
      </div>
      {pr?.price != null && (
        <div>
          <p className="sim-head__k">At {odds(pr.price)}</p>
          <p className={`check__ev num ${pr.ev >= 0 ? 'is-pos' : 'is-neg'}`}>
            {pr.ev >= 0 ? '+' : '−'}${Math.abs(pr.ev * 100).toFixed(0)}
          </p>
          <p className="muted">expected per $100 bet. The price needs {pct(pr.breakEven)} to break even.</p>
        </div>
      )}
    </div>
  )
}

function Call({ leg, call, sim, streaming }) {
  const sport = useSport()
  const v = call?.v || null
  const cls = v ? `call--${v.toLowerCase()}` : `call--wait call--lean-${leg.lean}`
  return (
    <li className={`call ${cls}`}>
      <div className="call__who">
        <Headshot src={leg.headshot} name={leg.name} size={40} />
        <div>
          <p className="call__name">
            <span className="call__n">{leg.n}</span> {leg.name}
          </p>
          <p className="call__bet">
            {leg.label}
            {Number.isFinite(leg.odds) && <span className="muted"> at {odds(leg.odds)}</span>}
          </p>
        </div>
        <span className="call__stamp">{v ? VERDICT[v] : streaming ? '…' : LEAN[leg.lean]}</span>
      </div>
      <p className="call__why">{call?.why || (streaming ? <span className="ask__cursor" aria-hidden="true" /> : null)}</p>
      {call?.overridden && <p className="call__override">The AI liked it, but it fails a Propify rule check below, so it isn’t a Keep.</p>}
      <dl className="call__facts">
        <div>
          <dt>Propify chance</dt>
          <dd className="num">{pct(leg.prob)}</dd>
        </div>
        {leg.implied != null && (
          <div>
            <dt>Price says</dt>
            <dd className="num">{pct(leg.implied)}</dd>
          </div>
        )}
        {leg.l10 && (
          <div>
            <dt>Last 10</dt>
            <dd className="num">
              {leg.l10.hits}/{leg.l10.n}
            </dd>
          </div>
        )}
        {sim && (
          <div>
            <dt>Sinks it alone</dt>
            <dd className="num">{pct(sim.onlyMiss)}</dd>
          </div>
        )}
      </dl>
      {leg.checks?.some((c) => c.state !== 'pass') && (
        <ul className="call__rules">
          {leg.checks
            .filter((c) => c.state !== 'pass')
            .map((c) => (
              <li key={c.key} className={`case case--${c.state}`}>
                <span className="case__mark" aria-hidden="true" />
                <span>
                  <b>{c.label}.</b> {c.detail}
                </span>
              </li>
            ))}
        </ul>
      )}
      {leg.checks && (
        <p className="call__passed">
          {leg.checks.filter((c) => c.state === 'pass').length} of {leg.checks.length} Propify rule checks passed
        </p>
      )}
      <Link className="call__link" to={sp(leg.sport || sport, `/prop/${encodeURIComponent(leg.id)}`)}>
        See the prop
      </Link>
    </li>
  )
}

function Unmatched({ list }) {
  return (
    <div className="check__miss">
      <p className="check__empty-title">Not checked</p>
      <ul>
        {list.map((u, i) => (
          <li key={i}>
            <b>{u.player}</b> {u.side === 'u' ? 'under' : 'over'} {u.line} {u.marketLabel || u.market}: <span className="muted">{u.why}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

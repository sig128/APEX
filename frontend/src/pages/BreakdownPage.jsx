import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useTitle } from '../lib/hooks.js'
import { useAuth } from '../context/AuthContext.jsx'
import { Headshot } from '../ui/Img.jsx'
import { ErrorBox, Skeleton } from '../ui/Bits.jsx'
import { refreshCredits } from '../ui/Credits.jsx'

// The Bet Breakdown: a settled pick explained from the evidence. Facts, estimates saved before the
// bet, and possible factors are kept apart; every claim links to where it came from.

const STATUS = {
  win: { word: 'Won', icon: '✓' },
  loss: { word: 'Missed', icon: '✕' },
  push: { word: 'Push', icon: '=' },
  void: { word: 'Void', icon: '∅' },
  pending: { word: 'Not graded', icon: '…' },
}
const EVIDENCE = {
  complete: { word: 'Evidence complete', note: 'The final number, the game, and what explains it are on record.' },
  partial: { word: 'Partial evidence', note: 'The final number is on record, but not enough to say why.' },
  unavailable: { word: 'Evidence unavailable', note: 'The game’s data isn’t available.' },
  awaiting: { word: 'Awaiting grading', note: 'Not graded yet, or a correction is pending.' },
}
const fmtOdds = (a) => (a == null ? null : a > 0 ? `+${a}` : `${a}`)
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null)
const units = (u) => (u == null ? '' : `${u > 0 ? '+' : ''}${Math.round(u * 100) / 100}u`)

function Leg({ l, evidence, open, onToggle }) {
  const st = STATUS[l.status] || STATUS.pending
  const ev = EVIDENCE[l.evidenceStatus] || EVIDENCE.awaiting
  const recs = (ids) => (ids || []).map((id) => evidence.find((r) => r.id === id)).filter(Boolean)
  const gap = l.distance == null ? null : l.distance < 0 ? `${Math.abs(l.distance)} short` : l.distance === 0 ? 'right on it' : `${l.distance} to spare`
  return (
    <li className={`bd-leg is-${l.status}`}>
      <div className="bd-leg__top">
        <span className="bd-leg__mark" aria-hidden="true">
          {st.icon}
        </span>
        <Headshot src={l.headshot} name={l.name} size={40} className="bd-leg__img" />
        <div className="bd-leg__who">
          <p className="bd-leg__name">
            {l.who} <span className="bd-leg__label">{l.label}</span>
          </p>
          <p className="bd-leg__meta">
            {l.price != null ? `${fmtOdds(l.price)}${l.book ? ` at ${l.book}` : ''}` : 'No accepted price on record'}
          </p>
        </div>
        <span className={`bd-pill is-${l.status}`}>{st.word}</span>
      </div>
      <div className="bd-leg__nums">
        <span>
          <small>Needed</small>
          <b>{l.needed}</b>
        </span>
        <span>
          <small>Final</small>
          <b className="num">{l.value ?? '–'}</b>
        </span>
        <span>
          <small>Distance</small>
          <b>{gap || '–'}</b>
        </span>
        <span className={`bd-ev is-${l.evidenceStatus}`} title={ev.note}>
          {ev.word}
        </span>
      </div>
      <p className="bd-leg__why">{l.finding || l.explanation}</p>
      <button type="button" className="linkish bd-leg__more" aria-expanded={open} onClick={onToggle}>
        {open ? 'Less' : 'The evidence'}
      </button>
      {open && (
        <div className="bd-leg__detail">
          {l.facts.length > 0 && (
            <div>
              <p className="bd-k">Observed in the game</p>
              <ul>
                {l.facts.map((f) => (
                  <li key={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</li>
                ))}
              </ul>
            </div>
          )}
          {l.factors.length > 0 && (
            <div>
              <p className="bd-k">Possible factors</p>
              <ul>
                {l.factors.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="bd-k">Saved when the pick was posted</p>
            {l.preBet.saved ? (
              <p>
                Estimated chance {Math.round(l.preBet.prob * 100)}%{l.preBet.fair != null ? `, fair price ${fmtOdds(l.preBet.fair)}` : ''}
                {l.preBet.proj != null ? `, projection ${l.preBet.proj}` : ''}
                {l.preBet.inj ? `, listed ${l.preBet.inj}` : ''}.
              </p>
            ) : (
              <p className="muted">No estimate was saved for this leg when it was posted, so there isn’t one to compare with.</p>
            )}
          </div>
          <div>
            <p className="bd-k">Sources</p>
            <ul className="bd-src">
              {recs(l.evidence).map((r) => (
                <li key={r.id}>
                  <span className="bd-src__id">{r.id}</span> {r.label}: {r.source}
                  {r.at ? `, ${when(r.at)}` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  )
}

function Timeline({ report }) {
  const items = []
  if (report.postedAt) items.push({ at: report.postedAt, text: 'Pick posted, with its estimates saved' })
  const ko = report.legs.map((l) => l.kickoff).filter(Boolean)
  if (ko.length) items.push({ at: Math.min(...ko), text: 'Kickoff' })
  for (const r of report.evidence.filter((e) => e.kind === 'event')) items.push({ at: r.at, text: `${report.legs[r.leg]?.who}: ${r.value.text}` })
  const g = report.evidence.find((e) => e.kind === 'game')
  if (g) items.push({ at: g.at, text: `Final: ${g.value.away} ${g.value.awayScore}, ${g.value.home} ${g.value.homeScore}${g.value.overtime ? ' (overtime)' : ''}` })
  if (report.gradedAt) items.push({ at: report.gradedAt, text: `Graded: ${report.parlay.result === 'win' ? 'won' : report.parlay.result === 'loss' ? 'lost' : report.parlay.result}` })
  items.sort((a, b) => (a.at || 0) - (b.at || 0))
  return (
    <ol className="bd-time">
      {items.map((it, i) => (
        <li key={i}>
          <time>{when(it.at) || ''}</time>
          <span>{it.text}</span>
        </li>
      ))}
    </ol>
  )
}

function Ask({ suggested, onAsk }) {
  const [q, setQ] = useState('')
  const [log, setLog] = useState([])
  const [busy, setBusy] = useState(false)
  const end = useRef(null)
  const send = async (text) => {
    const question = String(text || '').trim()
    if (!question || busy) return
    setBusy(true)
    setQ('')
    try {
      const a = await onAsk(question)
      setLog((cur) => [...cur, { q: question, a: a.text, mode: a.mode }])
    } catch (e) {
      setLog((cur) => [...cur, { q: question, a: e?.message || 'That didn’t work. Try again.', err: true }])
    }
    setBusy(false)
    setTimeout(() => end.current?.scrollIntoView({ block: 'nearest' }), 0)
  }
  return (
    <section className="bd-ask" aria-labelledby="bd-ask-h">
      <h2 id="bd-ask-h" className="bd-h">
        Ask about this bet
      </h2>
      <p className="muted small">Answers come from this bet’s record only.</p>
      <div className="bd-ask__chips">
        {suggested.map((s) => (
          <button key={s} type="button" className="pill" onClick={() => send(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      {log.length > 0 && (
        <ul className="bd-ask__log" aria-live="polite">
          {log.map((m, i) => (
            <li key={i}>
              <p className="bd-ask__q">{m.q}</p>
              <p className={`bd-ask__a${m.err ? ' is-err' : ''}`}>{m.a}</p>
            </li>
          ))}
          <li ref={end} aria-hidden="true" />
        </ul>
      )}
      <form
        className="bd-ask__form"
        onSubmit={(e) => {
          e.preventDefault()
          send(q)
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={400} placeholder="Ask anything about this bet" aria-label="Your question" />
        <button type="submit" className="btn btn--lime" disabled={busy || !q.trim()}>
          {busy ? 'One moment' : 'Ask'}
        </button>
      </form>
    </section>
  )
}

function Report({ data, onAsk, demo }) {
  const r = data.report
  const [open, setOpen] = useState(() => new Set(r.legs.filter((l) => l.status === 'loss').map((l) => l.index)))
  const toggle = (i) => setOpen((cur) => {
    const next = new Set(cur)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    return next
  })
  const p = r.parlay
  return (
    <>
      <section className={`bd-outcome is-${p.result}`} aria-label="Outcome">
        <div className="bd-outcome__res">
          <span className="bd-outcome__word">{p.awaiting ? 'Awaiting' : p.result === 'win' ? 'Won' : p.result === 'loss' ? 'Lost' : p.result === 'push' ? 'Push' : p.result === 'void' ? 'Void' : 'Pending'}</span>
          {p.profit != null && !p.awaiting && <span className="bd-outcome__u num">{units(p.profit)}</span>}
        </div>
        <p className="bd-outcome__sum">{r.summaryText || r.summary}</p>
        <p className="bd-outcome__counts">
          {p.counts.win} won, {p.counts.loss} missed{p.counts.push ? `, ${p.counts.push} pushed` : ''}
          {p.counts.void ? `, ${p.counts.void} void` : ''}
          {p.counts.pending ? `, ${p.counts.pending} not graded` : ''}
        </p>
      </section>
      <section aria-labelledby="bd-legs-h">
        <h2 id="bd-legs-h" className="bd-h">
          Leg by leg
        </h2>
        <ul className="bd-legs">
          {r.legs.map((l) => (
            <Leg key={l.index} l={l} evidence={r.evidence} open={open.has(l.index)} onToggle={() => toggle(l.index)} />
          ))}
        </ul>
      </section>
      <section className="bd-why" aria-labelledby="bd-why-h">
        <h2 id="bd-why-h" className="bd-h">
          {p.type === 'parlay' ? 'Why the parlay settled this way' : 'How it settled'}
        </h2>
        <p>{r.summary}</p>
        <p className="muted small">
          {r.rules.name}: {p.rule}
        </p>
      </section>
      <section aria-labelledby="bd-time-h">
        <h2 id="bd-time-h" className="bd-h">
          Timeline
        </h2>
        <Timeline report={r} />
      </section>
      <section className="bd-limits" aria-labelledby="bd-lim-h">
        <h2 id="bd-lim-h" className="bd-h">
          What this can and can’t tell you
        </h2>
        <ul>
          {r.limitations.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <p className="bd-k">Looking back (for learning, not advice)</p>
        <ul>
          {r.takeaways.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>
      <Ask suggested={data.suggested || []} onAsk={onAsk} />
      {!demo && data.narration === 'model' && <p className="muted small">The summary and findings were written from this bet’s evidence and checked against it.</p>}
    </>
  )
}

/** Your settled pick, explained (members). */
export function BreakdownPage() {
  const { id } = useParams()
  const { user, loading: authLoading } = useAuth()
  useTitle('Bet breakdown')
  const [state, setState] = useState({ loading: true, data: null, err: null, building: false })
  const load = () =>
    api(`/api/breakdown/${encodeURIComponent(id)}`).then(
      (data) => setState({ loading: false, data, err: null, building: false }),
      (err) => setState({ loading: false, data: null, err, building: false }),
    )
  useEffect(() => {
    if (!authLoading && user) load()
    if (!authLoading && !user) setState({ loading: false, data: null, err: null, building: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, authLoading, user?.uid])
  const build = async () => {
    setState((s) => ({ ...s, building: true, err: null }))
    try {
      const data = await api(`/api/breakdown/${encodeURIComponent(id)}`, { method: 'POST' })
      setState({ loading: false, data, err: null, building: false })
    } catch (err) {
      setState((s) => ({ ...s, building: false, err }))
    }
    refreshCredits()
  }
  const ask = (q) => api(`/api/breakdown/${encodeURIComponent(id)}/ask`, { method: 'POST', body: { q } })
  const d = state.data
  return (
    <div className="container page narrow bd">
      <header className="page-head">
        <h1 className="page-title">Bet breakdown</h1>
        <p className="page-sub">What you picked, what happened, and what the record can and can’t explain.</p>
      </header>
      {!authLoading && !user && (
        <div className="empty">
          <p className="empty__title">Sign in to see your breakdowns</p>
          <Link className="btn btn--lime" to={`/login?next=${encodeURIComponent(`/me/breakdown/${id}`)}`}>
            Sign in
          </Link>
        </div>
      )}
      {state.loading && user && <Skeleton rows={4} />}
      <ErrorBox error={state.err} onRetry={load} />
      {d?.status === 'locked' && (
        <>
          <Preview preview={d.preview} />
          <div className="locked">
            <p className="locked__title">The full breakdown is for members</p>
            <p className="locked__body">Leg-by-leg evidence, why the parlay settled the way it did, what was knowable before the game, and questions answered from the record. Part of Pro and Elite{d.cost ? `, ${d.cost} credits a bet` : ''}.</p>
            <div className="locked__actions">
              <Link className="btn btn--lime" to="/pricing">
                See plans
              </Link>
              <Link className="btn btn--quiet" to="/tools/breakdown">
                See an example
              </Link>
            </div>
          </div>
        </>
      )}
      {d?.status === 'pending' && (
        <>
          <Preview preview={d.preview} />
          <p className="bd-note">This pick isn’t settled yet. Its breakdown is ready once every leg is graded.</p>
        </>
      )}
      {d?.status === 'none' && (
        <>
          <Preview preview={d.preview} />
          <div className="bd-build">
            <p>Build a breakdown of this bet from its record: the final numbers, the game, what was saved when you posted it, and what the data can’t say.</p>
            <button type="button" className="btn btn--lime" onClick={build} disabled={state.building}>
              {state.building ? 'Building, about 10 seconds' : d.cost ? `Build the breakdown (${d.cost} credits)` : 'Build the breakdown'}
            </button>
            <p className="muted small">Looking at it again later is free. If it fails, no credits are used.</p>
          </div>
        </>
      )}
      {d?.status === 'outdated' && (
        <div className="bd-note is-warn">
          This bet’s grade was corrected after this breakdown was made.{' '}
          <button type="button" className="linkish" onClick={build} disabled={state.building}>
            {state.building ? 'Rebuilding' : 'Rebuild it (free)'}
          </button>
        </div>
      )}
      {(d?.status === 'ready' || d?.status === 'outdated') && <Report data={d} onAsk={ask} />}
    </div>
  )
}

function Preview({ preview }) {
  if (!preview) return null
  return (
    <section className="bd-preview" aria-label="Settlement">
      <p className="bd-k">Settlement</p>
      <ul>
        {preview.legs.map((l, i) => (
          <li key={i} className={`is-${l.status}`}>
            <span className={`bd-pill is-${l.status}`}>{(STATUS[l.status] || STATUS.pending).word}</span> {l.who} {l.label}
            {l.value != null ? `: ${l.value}` : ''}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The demo: made-up data, the same breakdown. */
export function BreakdownDemoPage() {
  useTitle('Bet breakdown example')
  const [mode, setMode] = useState('events')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    setData(null)
    api(`/api/breakdown/demo?mode=${mode}`, { auth: false }).then(setData, setErr)
  }, [mode])
  const ask = (q) => api('/api/breakdown/demo/ask', { method: 'POST', body: { mode, q }, auth: false })
  return (
    <div className="container page narrow bd">
      <p className="bd-demo" role="note">
        Example with made-up data: Player A, B and C, the game and every number are invented to show how a breakdown works.
      </p>
      <header className="page-head">
        <h1 className="page-title">Bet breakdown</h1>
        <p className="page-sub">A three-leg parlay where two legs won and one missed.</p>
      </header>
      <div className="seg seg--s bd-mode" role="group" aria-label="How much evidence">
        <button type="button" className={mode === 'events' ? 'is-on' : ''} aria-pressed={mode === 'events'} onClick={() => setMode('events')}>
          With the game’s event log
        </button>
        <button type="button" className={mode === 'boxscore' ? 'is-on' : ''} aria-pressed={mode === 'boxscore'} onClick={() => setMode('boxscore')}>
          Box score only
        </button>
      </div>
      <ErrorBox error={err} />
      {!data && !err && <Skeleton rows={4} />}
      {data && <Report key={mode} data={data} onAsk={ask} demo />}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from '../admin/adminApi.js'
import { useTitle } from '../lib/hooks.js'
import { Skeleton } from '../ui/Bits.jsx'
import '../admin/modelTest.css'

// Our formulas against the language model on props already graded (backend/src/modeltest).
// The page drives the run: each step asks about a few batches, and the loop repeats it while the
// page is open. Close it and the run pauses; open it again and it carries on.
const SIZES = [300, 600, 1000]
const n0 = (n) => Number(n || 0).toLocaleString('en-US')
const pct = (x, d = 0) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`)
const b3 = (x) => (x == null ? '–' : x.toFixed(3))
const units = (u) => (u == null ? '–' : `${u > 0 ? '+' : ''}${u.toFixed(2)}`)
const ret = (r) => (r == null ? '–' : `${r > 0 ? '+' : ''}${(r * 100).toFixed(1)}%`)
const tone = (x) => (x > 0 ? 'mt-plus' : x < 0 ? 'mt-minus' : '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function AdminModelTestPage() {
  // checking | locked | unset | open: the admin password opens this page too
  const [gate, setGate] = useState('checking')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [size, setSize] = useState(600)
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  useTitle('Model test')

  const locked = useCallback((e) => {
    if (e?.code !== 'admin_password') return false
    setGate('locked')
    return true
  }, [])
  useEffect(() => {
    adminApi('/api/admin/session')
      .then((s) => setGate(!s?.configured ? 'unset' : s.open ? 'open' : 'locked'))
      .catch(() => setGate('locked'))
  }, [])
  useEffect(() => {
    if (gate !== 'open') return
    adminApi('/api/admin/model-test')
      .then(setData)
      .catch((e) => locked(e) || setErr(e.message))
  }, [gate, locked])

  const run = data?.run
  const running = run?.status === 'running'
  // the loop: one step after another while the run is going and this page is open
  useEffect(() => {
    if (gate !== 'open' || paused || !running) return
    let stop = false
    ;(async () => {
      let fails = 0
      let last = -1
      while (!stop) {
        try {
          const v = await adminApi('/api/admin/model-test/step', { method: 'POST', body: {} })
          if (stop) return
          fails = 0
          setErr(null)
          setData(v)
          if (v.run?.status !== 'running') return
          const progress = (v.run.batchesDone || 0) * 100_000 + (v.run.answered || 0)
          // nothing new: another tab holds the next batches, so give it a moment
          if (progress === last) await sleep(4000)
          last = progress
        } catch (e) {
          if (stop || locked(e)) return
          fails++
          setErr(e.message)
          if (fails >= 3) return setPaused(true)
          await sleep(5000)
        }
      }
    })()
    return () => {
      stop = true
    }
  }, [gate, paused, running, run?.id, locked])

  const start = async () => {
    setBusy(true)
    setErr(null)
    setPaused(false)
    try {
      setData(await adminApi('/api/admin/model-test/start', { method: 'POST', body: { size } }))
    } catch (e) {
      if (!locked(e)) setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  const stopNow = async () => {
    setBusy(true)
    try {
      setData(await adminApi('/api/admin/model-test/stop', { method: 'POST', body: {} }))
    } catch (e) {
      if (!locked(e)) setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (gate === 'checking') return <div className="container page"><Skeleton rows={6} /></div>
  if (gate !== 'open') {
    return (
      <div className="container page">
        <div className="adm-panel adm-gate">
          <h1 className="page-title">Model test</h1>
          <p>{gate === 'unset' ? 'The admin password isn’t set up on this server yet.' : 'Unlock the admin page with the admin password, then come back to this page.'}</p>
          <Link to="/admin" className="btn btn--lime btn--block">
            Go to Admin
          </Link>
        </div>
      </div>
    )
  }

  const who = run?.who || data?.who || 'OpenAI'
  const res = run?.results
  return (
    <div className="container page adm mt">
      <header className="adm-head">
        <div>
          <h1 className="page-title">Our formulas vs {who}</h1>
          <p className="page-sub">
            {who} gets props we’ve already graded, with only what was known before each game, and gives its own chance. Both are scored on the same props.
          </p>
          {run && (
            <p className="mt-meta">
              {running ? 'Started' : run.status === 'stopped' ? 'Stopped' : 'Finished'} {new Date(run.finishedAt || run.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, {run.model || who}, {n0(run.calls)} calls, {n0((run.tokens?.in || 0) + (run.tokens?.out || 0))} tokens
            </p>
          )}
        </div>
        <div className="adm-head__actions">
          <Link to="/admin" className="btn btn--quiet adm-run">
            Admin
          </Link>
        </div>
      </header>

      {err && (
        <p className="notice mt-err" role="alert">
          {err}
        </p>
      )}
      {data && !data.ready && <p className="notice">There’s no {who} key on this server, so the test can’t run here.</p>}

      {running && (
        <section className="adm-section adm-panel mt-progress" aria-live="polite">
          <div className="mt-progress__head">
            <h2 className="adm-h3">Asking {who}</h2>
            <button type="button" className="btn btn--quiet btn--s" onClick={stopNow} disabled={busy}>
              Stop
            </button>
          </div>
          <p className="mt-progress__count">
            <b className="num">{n0(run.answered)}</b> of {n0(run.size)} props answered
          </p>
          <div className="mt-bar" role="progressbar" aria-label="Batches answered" aria-valuemin={0} aria-valuemax={run.batches} aria-valuenow={run.batchesDone}>
            <span style={{ width: `${run.batches ? Math.round((run.batchesDone / run.batches) * 100) : 0}%` }} />
          </div>
          <p className="adm-note">
            {run.batchesDone} of {run.batches} batches, {n0(run.calls)} calls so far. {paused ? 'Paused after three errors in a row.' : 'Keep this page open while it runs.'}
          </p>
          {paused && (
            <button type="button" className="btn btn--lime" onClick={() => setPaused(false)}>
              Continue
            </button>
          )}
        </section>
      )}
      {res && <Results res={res} who={who} partial={running} />}
      {!running && (
        <section className="adm-section adm-panel mt-start">
          <h2 className="adm-h3">{run ? 'Run a new test' : 'Run the test'}</h2>
          <div className="pills" role="group" aria-label="Props to test">
            {SIZES.map((s) => (
              <button key={s} type="button" className={`pill${size === s ? ' is-on' : ''}`} aria-pressed={size === s} onClick={() => setSize(s)}>
                {n0(s)} props
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--lime" onClick={start} disabled={busy || !data?.ready}>
            {busy ? 'Picking props…' : 'Start the test'}
          </button>
          <p className="adm-note">
            {n0(size)} props is about {Math.ceil(size / 20)} calls to {who}, billed to the key on this server. Keep this page open while it runs. If you close it, the test pauses and picks up where it left off when you come back.
          </p>
        </section>
      )}
      {run && !res && !running && <p className="adm-note">No props were answered in this run.</p>}
      {run?.errors?.length > 0 && (
        <p className="adm-note">
          Last error from {who}: {run.errors[0].text}
        </p>
      )}

      <section className="adm-section">
        <p className="adm-note">
          How it works: each prop is rebuilt from what was on file before its game. That means the player’s earlier games for that stat, how often this side had hit, home or away, the opponent, our matchup note and the sportsbook price. {who} never sees our chance, the result or the web. On game day our formulas also had injury news, which this test can’t give {who}, so it starts a little behind.
        </p>
      </section>
    </div>
  )
}

function Results({ res, who, partial }) {
  const v = res.verdict
  const head = v.winner === 'model' ? who : v.winner === 'formula' ? 'Our formulas' : v.winner === 'tie' ? 'Too close to call' : 'Too few yet'
  const f = res.formula
  const m = res.model
  const bands = res.bands.formula.map((b, i) => ({ ...b, mine: res.bands.model[i] })).filter((b) => b.n || b.mine.n)
  const money = [
    ['Every prop the board backed', res.money.all],
    ['Where our formulas saw value', res.money.formula],
    [`Where ${who} saw value`, res.money.model],
    ['Where both did', res.money.both],
  ]
  return (
    <>
      <section className="adm-section">
        <h2 className="adm-h2">{partial ? 'So far' : 'Result'}</h2>
        <div className="adm-strip">
          <div className="adm-cell is-big">
            <span className="adm-cell__label">{v.winner === 'model' || v.winner === 'formula' ? 'Closer to the results' : 'Verdict'}</span>
            <span className="adm-cell__value">{head}</span>
            <span className="adm-cell__sub">{v.text}</span>
          </div>
          <div className="adm-cell">
            <span className="adm-cell__label">Our formulas</span>
            <span className="adm-cell__value">{b3(f.brier)}</span>
            <span className="adm-cell__sub">Brier score, lower is better</span>
          </div>
          <div className="adm-cell">
            <span className="adm-cell__label">{who}</span>
            <span className="adm-cell__value">{b3(m.brier)}</span>
            <span className="adm-cell__sub">Brier score, lower is better</span>
          </div>
        </div>
      </section>

      <section className="adm-section adm-panel">
        <h2 className="adm-h3">How close each one came</h2>
        <div className="mt-scroll">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">On {n0(res.n)} graded props</th>
                <th scope="col" className="num">
                  Our formulas
                </th>
                <th scope="col" className="num">
                  {who}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Brier score (lower is better)</th>
                <td className="num">{b3(f.brier)}</td>
                <td className="num">{b3(m.brier)}</td>
              </tr>
              <tr>
                <th scope="row">Log loss (lower is better)</th>
                <td className="num">{b3(f.logloss)}</td>
                <td className="num">{b3(m.logloss)}</td>
              </tr>
              <tr>
                <th scope="row">Right when 60% or more sure</th>
                <td className="num">
                  {pct(f.sure.rate, 1)} <span className="muted">of {n0(f.sure.n)}</span>
                </td>
                <td className="num">
                  {pct(m.sure.rate, 1)} <span className="muted">of {n0(m.sure.n)}</span>
                </td>
              </tr>
              <tr>
                <th scope="row">Closer to the result on</th>
                <td className="num">{n0(res.closer.formula)} props</td>
                <td className="num">{n0(res.closer.model)} props</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="adm-note">
          They backed the same side on {pct(res.agree)} of the props{res.closer.same ? `, and came equally close on ${n0(res.closer.same)}` : ''}.
          {res.priced ? ` On the ${n0(res.priced.n)} props with a sportsbook price, the market’s own chance scored ${b3(res.priced.market)}, against ${b3(res.priced.formula)} for our formulas and ${b3(res.priced.model)} for ${who}.` : ''}
        </p>
      </section>

      <section className="adm-section adm-panel">
        <h2 className="adm-h3">Money at the price before the game</h2>
        <div className="mt-scroll">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">One unit on</th>
                <th scope="col" className="num">
                  Bets
                </th>
                <th scope="col" className="num">
                  Won
                </th>
                <th scope="col" className="num">
                  Units
                </th>
                <th scope="col" className="num">
                  Return
                </th>
              </tr>
            </thead>
            <tbody>
              {money.map(([label, x]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td className="num">{n0(x.bets)}</td>
                  <td className="num">{x.bets ? pct(x.hit, 1) : '–'}</td>
                  <td className={`num ${tone(x.units)}`}>{x.bets ? units(x.units) : '–'}</td>
                  <td className={`num ${tone(x.roi)}`}>{ret(x.roi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="adm-note">Value means a chance above the market’s, at the sportsbook price logged before the game. Only props with a price count here.</p>
      </section>

      {res.leagues.length > 0 && (
        <section className="adm-section adm-panel">
          <h2 className="adm-h3">By league</h2>
          <div className="mt-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">League</th>
                  <th scope="col" className="num">
                    Props
                  </th>
                  <th scope="col" className="num">
                    Ours
                  </th>
                  <th scope="col" className="num">
                    {who}
                  </th>
                  <th scope="col">Closer</th>
                </tr>
              </thead>
              <tbody>
                {res.leagues.map((l) => (
                  <tr key={l.key}>
                    <th scope="row">{l.name}</th>
                    <td className="num">{n0(l.n)}</td>
                    <td className="num">{b3(l.formula)}</td>
                    <td className="num">{b3(l.model)}</td>
                    <td>{l.winner === 'model' ? who : l.winner === 'formula' ? 'Ours' : l.winner === 'tie' ? 'Too close' : 'Too few props'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="adm-note">Brier scores, lower is better.</p>
        </section>
      )}

      <section className="adm-section adm-panel">
        <h2 className="adm-h3">When it said this, it hit</h2>
        <div className="mt-scroll">
          <table className="adm-table adm-table--tight">
            <thead>
              <tr>
                <th scope="col">Chance given</th>
                <th scope="col" className="num">
                  Ours: props
                </th>
                <th scope="col" className="num">
                  Hit
                </th>
                <th scope="col" className="num">
                  {who}: props
                </th>
                <th scope="col" className="num">
                  Hit
                </th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={b.from}>
                  <th scope="row">
                    {Math.round(b.from * 100)} to {Math.round(b.to * 100)}%
                  </th>
                  <td className="num">{n0(b.n)}</td>
                  <td className="num">{b.n ? pct(b.hit) : '–'}</td>
                  <td className="num">{n0(b.mine.n)}</td>
                  <td className="num">{b.mine.n ? pct(b.mine.hit) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="adm-note">A well-calibrated forecaster’s props hit about as often as the chance it gave.</p>
      </section>
    </>
  )
}

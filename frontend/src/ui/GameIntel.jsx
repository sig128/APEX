import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { pct, ago } from '../lib/format.js'
import { useBilling } from '../context/BillingContext.jsx'
import { Locked } from './Locked.jsx'
import { useSport, apiOf, sp } from '../lib/sport.js'

const STEPS = ['Reading the official injury report', 'Checking practice reports and depth charts', 'Reading press conferences and beat coverage', 'Matching it to this week’s props']
const STATUS_TONE = (s) => (/out|ir|doubt/i.test(s) ? 'is-out' : /quest|limit/i.test(s) ? 'is-q' : 'is-ok')
const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Injuries and this week's reputable reporting for one game, tied to the props it moves. AI, so members with a pass. */
export function GameIntel({ gameId, official }) {
  const sport = useSport()
  const { refresh } = useBilling()
  const [st, setSt] = useState({ busy: false, data: null, err: null })
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!st.busy) return undefined
    setStep(0)
    const t = setInterval(() => setStep((s) => Math.min(STEPS.length - 1, s + 1)), 6000)
    return () => clearInterval(t)
  }, [st.busy])

  const scan = async (fresh = false) => {
    setSt((s) => ({ ...s, busy: true, err: null }))
    try {
      const data = await api(`${apiOf(sport)}/intel`, { method: 'POST', body: { gameId, fresh } })
      setSt({ busy: false, data, err: null })
      if (!data.cached) refresh?.()
    } catch (err) {
      setSt((s) => ({ ...s, busy: false, err }))
    }
  }

  const d = st.data
  return (
    <Locked need="pro" ai title="Game intel">
      <div className="intel">
        {!d && !st.busy && (
          <div className="intel__start">
            <div>
              <p className="intel__title">What changed this week</p>
              <p className="muted">
                Propify reads the official injury report, practice participation, depth charts and what coaches said on the record, from ESPN, NFL.com, AP and each team’s beat writers, then tells you which props it moves. Public reporting only, every item linked.
              </p>
            </div>
            <button type="button" className="btn btn--gold" onClick={() => scan(false)}>
              Scan this game
            </button>
          </div>
        )}
        {st.busy && (
          <ol className="intel__steps" aria-live="polite">
            {STEPS.map((s, i) => (
              <li key={s} className={i < step ? 'is-done' : i === step ? 'is-on' : ''}>
                {s}
              </li>
            ))}
          </ol>
        )}
        {st.err && (
          <p className="ask__err" role="alert">
            {st.err.message}
          </p>
        )}
        {d && !st.busy && (
          <>
            <div className="intel__head">
              <p className="intel__summary">{d.summary || 'No major news for this game this week.'}</p>
              <p className="intel__meta">
                Scanned {ago(d.at)}
                {Date.now() - d.at > 15 * 60e3 && (
                  <button type="button" className="linkish" onClick={() => scan(true)}>
                    Scan again
                  </button>
                )}
              </p>
            </div>

            {d.angles?.length > 0 && (
              <section aria-label="Props it moves">
                <h3 className="intel__h">Props it moves</h3>
                <ul className="intel__angles">
                  {d.angles.map((a, i) => (
                    <li key={i} className={`angle angle--${a.lean}`}>
                      <span className="angle__lean">{a.lean === 'hurt' ? 'Hurts' : 'Helps'}</span>
                      <div>
                        <p className="angle__who">{a.playerId ? <Link to={sp(sport, `/player/${a.playerId}`)}>{a.player}</Link> : a.player}</p>
                        <p className="angle__why">{a.why}</p>
                        {a.props?.length > 0 && (
                          <p className="angle__props">
                            {a.props.map((p) => (
                              <Link key={p.id} to={sp(sport, `/prop/${encodeURIComponent(p.id)}`)}>
                                {p.label} <span className="num">{pct(p.prob)}</span>
                              </Link>
                            ))}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {d.injuries?.length > 0 && (
              <section aria-label="Injury report">
                <h3 className="intel__h">Injury report</h3>
                <ul className="intel__inj">
                  {d.injuries.map((i, k) => (
                    <li key={k}>
                      <span className={`inj-status ${STATUS_TONE(i.status)}`}>{i.status}</span>
                      <span className="intel__inj-who">
                        <b>{i.playerId ? <Link to={sp(sport, `/player/${i.playerId}`)}>{i.player}</Link> : i.player}</b> <span className="muted">{i.team}</span>
                      </span>
                      <span className="intel__inj-note">
                        {i.note}
                        {i.url && (
                          <a href={i.url} target="_blank" rel="noopener noreferrer nofollow" className="intel__src">
                            {host(i.url)}
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {d.news?.length > 0 && (
              <section aria-label="Reporting">
                <h3 className="intel__h">This week’s reporting</h3>
                <ul className="intel__news">
                  {d.news.map((n, k) => (
                    <li key={k} className={`news news--${n.impact}`}>
                      <a href={n.url} target="_blank" rel="noopener noreferrer nofollow" className="news__head">
                        {n.headline}
                      </a>
                      <p className="news__detail">{n.detail}</p>
                      <p className="news__meta">
                        {host(n.url)}
                        {n.date ? `, ${n.date}` : ''}
                        {n.team ? `, ${n.team}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {official > 0 && <p className="muted intel__fine">The full official list for both teams is on the Injuries tab.</p>}
            <p className="muted intel__fine">From public reporting by established outlets, read by AI; check the link before you rely on it. Propify never uses leaked or insider information.</p>
          </>
        )}
      </div>
    </Locked>
  )
}

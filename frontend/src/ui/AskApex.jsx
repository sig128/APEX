import { useEffect, useRef, useState } from 'react'
import { streamNdjson } from '../lib/api.js'
import { streamUrl } from '../lib/config.js'
import { Locked } from './Locked.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { Link } from 'react-router-dom'

/** Turn the read's "VERDICT: ...", "WHY: ..." lines into labeled blocks. */
function sections(text) {
  const out = []
  let cur = null
  for (const raw of text.split('\n')) {
    const m = /^\s*(VERDICT|WHY|RISKS?|SIZING|EDGE|NOTE)\s*[:\-–]\s*(.*)$/i.exec(raw)
    if (m) {
      cur = { k: m[1].toUpperCase().replace(/^RISK$/, 'RISKS'), lines: m[2] ? [m[2]] : [] }
      out.push(cur)
    } else if (raw.trim()) {
      if (!cur) {
        cur = { k: '', lines: [] }
        out.push(cur)
      }
      cur.lines.push(raw.replace(/^\s*[-*•]\s*/, ''))
    }
  }
  return out
}

const TITLES = { VERDICT: 'Verdict', WHY: 'Why', RISKS: 'Risks', SIZING: 'Sizing', EDGE: 'Edge', NOTE: 'Note' }

/** The AI read of one prop, written with the APEX ruleset. Pro and Elite. */
export function AskApex({ propId }) {
  const { user, firebaseConfigured } = useAuth()
  const { paywall, refresh } = useBilling()
  const [text, setText] = useState('')
  const [state, setState] = useState('idle') // idle | streaming | done | error
  const [err, setErr] = useState(null)
  const [usage, setUsage] = useState(null)
  const ctrl = useRef(null)

  useEffect(() => {
    setText('')
    setState('idle')
    setErr(null)
    return () => ctrl.current?.abort()
  }, [propId])

  async function run() {
    ctrl.current?.abort()
    const ac = new AbortController()
    ctrl.current = ac
    setText('')
    setErr(null)
    setState('streaming')
    try {
      const { last, usage: u } = await streamNdjson(
        streamUrl('/api/nfl/insight'),
        { propId },
        {
          signal: ac.signal,
          onEvent: (ev) => {
            if (ev.type === 'text_delta') setText((t) => t + ev.text)
            if (ev.type === 'complete') setText(ev.text)
          },
        },
      )
      if (last?.type === 'error') throw new Error(last.error)
      setUsage(u)
      setState('done')
      refresh()
    } catch (e) {
      if (e?.name === 'AbortError') return
      setErr(e)
      setState('error')
    }
  }

  const blocks = sections(text)
  const verdict = blocks.find((b) => b.k === 'VERDICT')?.lines.join(' ') || ''
  const tone = /prime/i.test(verdict) ? 'is-prime' : /no play/i.test(verdict) ? 'is-pass' : /monitor/i.test(verdict) ? 'is-watch' : ''
  // with the paywall off the server still wants a signed-in, invited user (except in local dev
  // without Firebase, where it's open)
  const needsSignIn = !paywall && !user && firebaseConfigured

  return (
    <Locked need="pro" title="AI read of this prop">
      <div className={`ask ${tone}`}>
        <div className="ask__head">
          <p className="ask__title">APEX AI read</p>
          {state !== 'streaming' &&
            (needsSignIn ? (
              <Link className="btn btn--quiet" to="/login">
                Sign in for AI reads
              </Link>
            ) : (
              <button type="button" className="btn btn--gold" onClick={run}>
                {state === 'idle' ? 'Read this prop' : 'Read again'}
              </button>
            ))}
          {state === 'streaming' && (
            <button type="button" className="btn btn--quiet" onClick={() => ctrl.current?.abort() || setState('idle')}>
              Stop
            </button>
          )}
        </div>
        {state === 'idle' && <p className="muted">Runs this prop through the APEX ruleset: verdict, the reasons, the risks, and how much to stake.</p>}
        {err && (
          <p className="ask__err" role="alert">
            {err.code === 'quota' ? `${err.message}` : err.code === 'invite' ? 'Redeem an invite code on your account page to use AI reads.' : err.message}
          </p>
        )}
        {blocks.length > 0 && (
          <div className="ask__body" aria-live="polite">
            {blocks.map((b, i) => (
              <div key={i} className={`ask__block${b.k === 'VERDICT' ? ' ask__block--verdict' : ''}`}>
                {b.k && <span className="ask__k">{TITLES[b.k] || b.k}</span>}
                {b.lines.map((l, j) => (
                  <p key={j}>{l}</p>
                ))}
              </div>
            ))}
            {state === 'streaming' && <span className="ask__cursor" aria-hidden="true" />}
          </div>
        )}
        {usage && <p className="ask__usage">{usage.split('/')[0]} of {usage.split('/')[1]} AI reads used today</p>}
      </div>
    </Locked>
  )
}

import { useCallback, useSyncExternalStore } from 'react'
import { streamNdjson } from '../lib/api.js'
import { streamUrl } from '../lib/config.js'
import { Locked } from './Locked.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { Link } from 'react-router-dom'
import { useSport, apiOf } from '../lib/sport.js'

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

// Reads live outside the component: leaving the page mid-stream doesn't throw away a read the
// user paid for, and coming back shows it again. Keyed by user and prop; a small LRU.
const IDLE = { text: '', state: 'idle', err: null, usage: null } // state: idle | streaming | done | error
const MAX_READS = 40
const reads = new Map() // key -> { snap, ctrl }
const subs = new Map() // key -> Set<fn>

function put(key, patch) {
  const cur = reads.get(key) || { snap: IDLE, ctrl: null }
  reads.delete(key)
  reads.set(key, { ...cur, snap: { ...cur.snap, ...patch } })
  for (const [k, v] of reads) {
    if (reads.size <= MAX_READS) break
    if (v.snap.state !== 'streaming' && k !== key) reads.delete(k)
  }
  for (const fn of subs.get(key) || []) fn()
}

async function startRead(key, propId, onDone, sport = 'nfl') {
  reads.get(key)?.ctrl?.abort()
  const ac = new AbortController()
  put(key, { text: '', state: 'streaming', err: null })
  reads.get(key).ctrl = ac
  const mine = () => reads.get(key)?.ctrl === ac
  try {
    const { last, usage } = await streamNdjson(
      streamUrl(`${apiOf(sport)}/insight`),
      { propId },
      {
        signal: ac.signal,
        onEvent: (ev) => {
          if (!mine()) return
          if (ev.type === 'text_delta') put(key, { text: reads.get(key).snap.text + ev.text })
          if (ev.type === 'complete') put(key, { text: ev.text })
        },
      },
    )
    if (last?.type === 'error') throw new Error(last.error)
    if (mine()) put(key, { usage, state: 'done' })
    onDone?.()
  } catch (e) {
    if (!mine()) return
    put(key, e?.name === 'AbortError' ? { state: 'idle' } : { err: e, state: 'error' })
  } finally {
    if (mine()) reads.get(key).ctrl = null
  }
}

function stopRead(key) {
  reads.get(key)?.ctrl?.abort()
}

function useRead(key) {
  const subscribe = useCallback(
    (fn) => {
      if (!subs.has(key)) subs.set(key, new Set())
      subs.get(key).add(fn)
      return () => {
        subs.get(key)?.delete(fn)
        if (!subs.get(key)?.size) subs.delete(key)
      }
    },
    [key],
  )
  const get = useCallback(() => reads.get(key)?.snap || IDLE, [key])
  return useSyncExternalStore(subscribe, get, get)
}

/** The AI read of one prop, written with the Propify ruleset. Pro and Elite. */
export function AskApex({ propId }) {
  const sport = useSport()
  const { user, firebaseConfigured } = useAuth()
  const { paywall, refresh } = useBilling()
  const key = `${user?.uid || ''}|${sport}|${propId}`
  const { text, state, err, usage } = useRead(key)
  const run = () => startRead(key, propId, refresh, sport)

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
          <p className="ask__title">Propify AI read</p>
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
            <button type="button" className="btn btn--quiet" onClick={() => stopRead(key)}>
              Stop
            </button>
          )}
        </div>
        {state === 'idle' && <p className="muted">Runs this prop through the Propify ruleset: verdict, the reasons, the risks, and how much to stake.</p>}
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

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { api } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { removeLeg } from '../lib/slip.js'
import { smartCheck, offTypes, turnOff, turnAllOn, TYPE_NAME } from '../lib/smartcheck.js'

// Smart Check on screen: the slip's notes in the pick card (a few) and in the slip (all of
// them). Each can be dismissed or turned off by type. For members; everyone else sees how many
// notes there are.

const ICON = { strong: '!', caution: '▲', info: 'i' }
const WORD = { strong: 'Strong warning', caution: 'Caution', info: 'Note' }

/** Log what was shown and what happened next (counts only, no slip contents). */
export function logNudges(types, action) {
  if (!types.length) return
  api('/api/members/nudges', { method: 'POST', body: { types: [...new Set(types)].slice(0, 12), action } }).catch(() => {})
}

/** The notes for these legs, with your record at this leg count when you have one. */
export function useSmartCheck(legs) {
  const { user } = useAuth()
  const { member } = useBilling()
  const record = useApi(user && member ? '/api/picks/me/tracking?range=90d' : null, { maxAgeMs: 10 * 60_000 }).data
  const [off, setOff] = useState(offTypes)
  const notes = useMemo(() => smartCheck(legs, { record: record?.locked ? null : record, off }), [legs, record, off])
  return {
    notes,
    member,
    mute: (type) => setOff(turnOff(type)),
    unmuteAll: () => {
      turnAllOn()
      setOff([])
    },
    off,
  }
}

function Note({ n, onDismiss, onMute, onAct }) {
  return (
    <li className={`sc-note is-${n.level}`}>
      <span className="sc-note__icon" aria-hidden="true">
        {ICON[n.level]}
      </span>
      <div className="sc-note__body">
        <p className="sc-note__k">
          <span className="sr-only">{WORD[n.level]}: </span>
          {TYPE_NAME[n.type]}
        </p>
        <p className="sc-note__text">{n.text}</p>
        <div className="sc-note__acts">
          {n.action?.kind === 'remove' && (
            <button type="button" className="linkish" onClick={() => onAct(n)}>
              {n.action.label}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="linkish" onClick={() => onDismiss(n)}>
              Dismiss
            </button>
          )}
          <button type="button" className="linkish sc-note__mute" onClick={() => onMute(n)}>
            Don’t show this type again
          </button>
        </div>
      </div>
    </li>
  )
}

/** In the slip: every note for the slip as it stands. */
export function SmartCheckPanel({ legs }) {
  const sc = useSmartCheck(legs)
  const [gone, setGone] = useState(() => new Set())
  const key = (n) => `${n.type}:${n.legs.join(',')}`
  const shown = sc.notes.filter((n) => !gone.has(key(n)))
  const logged = useRef('')
  useEffect(() => {
    const sig = shown.map(key).join('|')
    if (sc.member && sig && sig !== logged.current) {
      logged.current = sig
      logNudges(shown.map((n) => n.type), 'shown')
    }
  }, [shown, sc.member])
  if (!legs.length) return null
  if (!sc.member) {
    if (!sc.notes.length) return null
    return (
      <div className="sc sc--locked">
        <p>
          <b>Smart Check</b> has {sc.notes.length} {sc.notes.length === 1 ? 'note' : 'notes'} on this slip. <Link to="/pricing">Part of Pro</Link>
        </p>
      </div>
    )
  }
  return (
    <section className="sc" aria-labelledby="sc-h">
      <p className="sc__h" id="sc-h">
        Smart Check
        {sc.off.length > 0 && (
          <button type="button" className="linkish sc__on" onClick={sc.unmuteAll}>
            Show all types again
          </button>
        )}
      </p>
      {shown.length ? (
        <ul className="sc__list">
          {shown.map((n) => (
            <Note
              key={key(n)}
              n={n}
              onDismiss={(x) => {
                setGone((cur) => new Set([...cur, key(x)]))
                logNudges([x.type], 'dismissed')
              }}
              onMute={(x) => {
                sc.mute(x.type)
                logNudges([x.type], 'muted')
              }}
              onAct={(x) => {
                removeLeg(x.action.id)
                logNudges([x.type], 'removed')
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="sc__ok">Nothing to flag on this slip.</p>
      )}
    </section>
  )
}

/** In the pick card: the strongest few notes, a moment after the last tap. */
export function SmartCheckBrief({ legs, onAct }) {
  const [ready, setReady] = useState(false)
  // rapid taps: wait for the slip to settle before saying anything
  useEffect(() => {
    setReady(false)
    const t = setTimeout(() => setReady(true), 350)
    return () => clearTimeout(t)
  }, [legs])
  const sc = useSmartCheck(legs)
  const top = sc.notes.slice(0, 3)
  useEffect(() => {
    if (ready && sc.member && top.length) logNudges(top.map((n) => n.type), 'shown')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  if (!ready || !top.length) return null
  if (!sc.member) {
    return (
      <p className="sc-brief sc-brief--locked">
        <b>Smart Check</b>: {sc.notes.length} {sc.notes.length === 1 ? 'note' : 'notes'} on your slip. <Link to="/pricing">Pro</Link>
      </p>
    )
  }
  return (
    <ul className="sc__list sc-brief">
      {top.map((n) => (
        <Note
          key={`${n.type}:${n.legs.join(',')}`}
          n={n}
          onMute={(x) => {
            sc.mute(x.type)
            logNudges([x.type], 'muted')
          }}
          onAct={(x) => {
            removeLeg(x.action.id)
            logNudges([x.type], 'removed')
            onAct?.()
          }}
        />
      ))}
    </ul>
  )
}

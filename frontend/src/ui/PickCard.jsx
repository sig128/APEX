import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { onPick, removeLeg } from '../lib/slip.js'
import { sp } from '../lib/sport.js'

const SHOW_MS = 9000

/**
 * The moment a prop goes on the slip: its bottom line, the strongest stat behind it and the
 * biggest one against it, so the pick is made knowing both. A pick the read warns about points
 * to the other side. One card at a time; it steps aside on its own, or stays while you read it.
 */
export function PickCard() {
  const [pick, setPick] = useState(null)
  const [held, setHeld] = useState(false)
  const timer = useRef(null)

  useEffect(
    () =>
      onPick(({ leg, replaced }) => {
        // nothing to say about it (a team total, say): no card
        if (!leg.read && !leg.pro && !leg.con) return setPick(null)
        setPick({ leg, replaced, at: Date.now() })
      }),
    [],
  )
  useEffect(() => {
    clearTimeout(timer.current)
    if (!pick || held) return undefined
    timer.current = setTimeout(() => setPick(null), SHOW_MS)
    return () => clearTimeout(timer.current)
  }, [pick, held])
  useEffect(() => {
    if (!pick) return undefined
    const onKey = (e) => e.key === 'Escape' && setPick(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pick])

  if (!pick) return null
  const { leg, replaced } = pick
  const lean = leg.read?.lean
  const flip = lean === 'against' && !leg.oneSided && leg.playerId ? `${leg.playerId}.${leg.market}.${leg.side === 'o' ? 'u' : 'o'}.${leg.line}` : null
  return (
    <aside
      key={pick.at}
      className={`pick-card${lean ? ` is-${lean}` : ''}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="pick-card__head">
        <p className="pick-card__what">
          {replaced ? 'Swapped in' : 'On your slip'}: <b>{leg.name}</b> {leg.shortLabel || leg.label}
        </p>
        <button type="button" className="pick-card__close" onClick={() => setPick(null)} aria-label="Close">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {leg.read && (
        <p className="pick-card__lean">
          <b>{leg.read.label}:</b> {leg.read.text}
        </p>
      )}
      <ul className="pick-card__why">
        {leg.pro && (
          <li className="is-for">
            <span className="pick-card__mark" aria-hidden="true">
              +
            </span>
            <span>
              <span className="sr-only">For it: </span>
              {leg.pro.text}
            </span>
          </li>
        )}
        {leg.con && (
          <li className="is-against">
            <span className="pick-card__mark" aria-hidden="true">
              −
            </span>
            <span>
              <span className="sr-only">Against it: </span>
              {leg.con.text}
            </span>
          </li>
        )}
      </ul>
      <div className="pick-card__actions">
        <Link to={sp(leg.sport, `/prop/${encodeURIComponent(leg.id)}`)} className="link" onClick={() => setPick(null)}>
          See every reason
        </Link>
        {flip && (
          <Link to={sp(leg.sport, `/prop/${encodeURIComponent(flip)}`)} className="link" onClick={() => setPick(null)}>
            Look at the {leg.side === 'o' ? 'under' : 'over'}
          </Link>
        )}
        <button
          type="button"
          className="link pick-card__undo"
          onClick={() => {
            removeLeg(leg.id)
            setPick(null)
          }}
        >
          Take it off
        </button>
      </div>
    </aside>
  )
}

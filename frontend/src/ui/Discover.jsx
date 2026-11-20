import { useState } from 'react'

// "Discover later": the first time someone reaches a part of the app the tour only mentions
// (the leaderboard, sending legs to a sportsbook, line moves), a short note on what it is and how
// to read it. Once per browser; replaying the tour brings them back.

const KEY = 'apex_discover'
function seenMap() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {}
  } catch {
    return {}
  }
}
export const seenDiscover = (id) => Boolean(seenMap()[id])
export function markDiscover(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...seenMap(), [id]: Date.now() }))
  } catch {
    /* storage off: it shows again next visit, which is fine */
  }
}
/** Bring every note back (with "Replay the tour"). */
export function resetDiscover() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

export function Discover({ id, title, children, className = '' }) {
  const [seen, setSeen] = useState(() => seenDiscover(id))
  if (seen) return null
  const done = () => {
    markDiscover(id)
    setSeen(true)
  }
  return (
    <aside className={`discover ${className}`} aria-label={title}>
      <div className="discover__text">
        <p className="discover__title">{title}</p>
        <div className="discover__body">{children}</div>
      </div>
      <button type="button" className="btn btn--quiet btn--s discover__ok" onClick={done}>
        Got it
      </button>
    </aside>
  )
}

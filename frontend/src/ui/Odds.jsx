import { odds, impliedOf, oddsMeaning } from '../lib/format.js'

/**
 * A price with what it means as a chance: "-110 52.4%". Most people can't read -110; everyone
 * can read 52.4%. Hover or long-press for the sentence version.
 */
export function Odds({ a, className = '', pctOnly = false }) {
  const p = impliedOf(a)
  if (p == null) return <span className={`odds ${className}`}>–</span>
  return (
    <span className={`odds ${className}`} title={oddsMeaning(a)}>
      {!pctOnly && <b className="num odds__price">{odds(a)}</b>}
      <span className="num odds__pct">{(p * 100).toFixed(1)}%</span>
    </span>
  )
}

/** The chance a price implies, for next to an input. */
export function ImpliedHint({ a }) {
  const p = impliedOf(a)
  if (p == null) return null
  return (
    <span className="odds-hint num" title={oddsMeaning(a)} aria-live="polite">
      = {(p * 100).toFixed(1)}%
    </span>
  )
}

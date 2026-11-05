// Closing line value: what a pick's price was worth against the last price before its game.
//
// Before each game the legs of open picks get a snapshot of the board's price on both sides
// and the line, with the time the board last refreshed them. The last snapshot before kickoff is
// the close. CLV is the expected return of the price taken at the closing (no-vig) chance:
// +0.05 means the price beat the close by 5%. It's only measured at the same line, with a
// real sportsbook price, and a close seen in the 90 minutes before the game.
import { americanToDecimal, americanToProb, noVig } from '../lib/odds.js'
import { round } from '../lib/util.js'

export const FRESH_MS = 90 * 60_000
const num = (x) => (Number.isFinite(x) ? x : null)

/** This side's price and the other side's on a board row as it is now. */
export function sidePrices(row, side) {
  const p = row?.price || {}
  if (row?.oneSided) return { price: num(p.yes), other: null }
  return side === 'u' ? { price: num(p.under), other: num(p.over) } : { price: num(p.over), other: num(p.under) }
}

/** A snapshot of a row for one leg, or null when the board has no price for it. */
export function closeSnap(row, side, at) {
  if (!row || !Number.isFinite(row.line)) return null
  const { price, other } = sidePrices(row, side)
  if (!Number.isFinite(price)) return null
  return { price, other, line: row.line, main: Number.isFinite(row.main) ? row.main : null, at }
}

export const sameClose = (a, b) => Boolean(a && b) && a.price === b.price && a.other === b.other && a.line === b.line && a.main === b.main

/** The fair chance of the leg's side at the close: no-vig when both sides were priced. */
export function closeProb(close) {
  if (!close || !Number.isFinite(close.price)) return null
  if (Number.isFinite(close.other)) {
    const nv = noVig(close.price, close.other)
    if (nv) return nv[0]
  }
  return americanToProb(close.price)
}

/** Whether a leg's close can be compared with its price. */
export function measurable(leg) {
  const c = leg?.close
  return Boolean(c) && c.line === leg.line && Number.isFinite(leg.price) && Number.isFinite(c.at) && Number.isFinite(leg.kickoff) && leg.kickoff - c.at <= FRESH_MS && c.at <= leg.kickoff + 15 * 60_000
}

export function legClv(leg) {
  if (!measurable(leg)) return null
  const p = closeProb(leg.close)
  const d = americanToDecimal(leg.price)
  return p && d ? round(p * d - 1, 4) : null
}

/** A pick's CLV: every leg still in play needs a measurable close; parlay legs multiply. */
export function pickClv(legs) {
  const live = (legs || []).filter((l) => l.result !== 'void' && l.result !== 'push')
  if (!live.length) return null
  let p = 1
  let d = 1
  for (const l of live) {
    if (!measurable(l)) return null
    const q = closeProb(l.close)
    const x = americanToDecimal(l.price)
    if (!q || !x) return null
    p *= q
    d *= x
  }
  return round(p * d - 1, 4)
}

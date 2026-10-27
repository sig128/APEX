// The bet slip: props you've collected, your sportsbook odds for them, and the math for the
// parlay. Kept in this browser (localStorage) and shareable as a link anyone can open.
import { decimalOf, americanOf, fairOf, odds as fmtOdds, pct } from './format.js'
import { SITE_URL } from './config.js'
import { legRef, shareRef, splitRef } from './leagues.js'

const KEY = 'apex_slip_v1'
export const MAX_LEGS = 12

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && Array.isArray(v.legs)) return { legs: v.legs.slice(0, MAX_LEGS), parlayPrice: v.parlayPrice ?? null, mode: v.mode === 'singles' ? 'singles' : 'parlay' }
  } catch {
    /* private mode or junk */
  }
  return { legs: [], parlayPrice: null, mode: 'parlay' }
}

let state = read()
const subs = new Set()
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage full or blocked: the slip still works for this visit */
  }
  for (const fn of subs) fn(state)
}

export const getSlip = () => state
export function onSlip(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** The parts of a prop card the slip needs to draw itself without a request. */
export function snapshot(c) {
  const kickoff = typeof c.kickoff === 'number' ? new Date(c.kickoff).toISOString() : c.kickoff
  const oneSided = c.oneSided ?? (c.market === 'anyTd' || c.market === 'td2')
  // the read travels with the leg: its bottom line, and the best reason for it and against it
  const pro = c.pro ?? c.notes?.find((n) => n.tone === 'for') ?? null
  const con = c.con ?? c.notes?.find((n) => n.tone === 'against') ?? null
  return { id: c.id, sport: c.sport || 'nfl', name: c.name, short: c.short, label: c.label, shortLabel: c.shortLabel || c.label, prob: c.prob, fair: c.fair, headshot: c.headshot || null, logo: c.logo || null, teamAbbr: c.teamAbbr, oppAbbr: c.oppAbbr, gameId: c.gameId, kickoff, market: c.market, side: c.side, line: c.line, oneSided: Boolean(oneSided), playerId: c.playerId || null, teamId: c.teamId || null, kind: c.kind || (c.teamId && !c.playerId ? 'team' : 'player'), read: c.read || null, pro, con }
}

// Someone just picked a prop (one tap, not a bulk add): the pick card says why it's good or not.
const pickSubs = new Set()
export function onPick(fn) {
  pickSubs.add(fn)
  return () => pickSubs.delete(fn)
}

export const inSlip = (id) => state.legs.some((l) => l.id === id)

/** Same player and stat on both sides cancel out; replace instead of stacking. */
export function addLeg(card) {
  if (inSlip(card.id)) return { ok: true }
  if (state.legs.length >= MAX_LEGS) return { ok: false, reason: `A slip holds ${MAX_LEGS} legs.` }
  const key = (l) => `${l.sport || 'nfl'}:${l.playerId || l.teamId}:${l.market}`
  const legs = state.legs.filter((l) => key(l) !== key(card))
  const replaced = legs.length < state.legs.length
  // line shopping: the best price across books, else the headline book's
  const price = card.shop?.price ?? card.price?.best?.[card.side === 'u' ? 'under' : card.oneSided ? 'yes' : 'over']?.price ?? card.price?.[card.side === 'u' ? 'under' : card.oneSided ? 'yes' : 'over'] ?? null
  state = { ...state, legs: [...legs, { ...snapshot(card), price, book: card.shop?.book || null }] }
  save()
  return { ok: true, replaced }
}

export function toggleLeg(card, { quiet = false } = {}) {
  if (inSlip(card.id)) return removeLeg(card.id)
  const out = addLeg(card)
  if (out.ok && !quiet) {
    const leg = state.legs.find((l) => l.id === card.id)
    if (leg) for (const fn of pickSubs) fn({ leg, replaced: Boolean(out.replaced) })
  }
  return out
}

/** Remove by prop id or by ref ("nba:<id>", as the API names legs). */
export function removeLeg(id) {
  state = { ...state, legs: state.legs.filter((l) => l.id !== id && legRef(l) !== id) }
  save()
  return { ok: true }
}

/** Your price for one leg, by ref ("nba:<id>") or prop id. */
export function setLegPrice(id, price) {
  state = { ...state, legs: state.legs.map((l) => (legRef(l) === id || l.id === id ? { ...l, price } : l)) }
  save()
}

export function setParlayPrice(price) {
  state = { ...state, parlayPrice: price }
  save()
}

export function setMode(mode) {
  state = { ...state, mode: mode === 'singles' ? 'singles' : 'parlay' }
  save()
}

export function clearSlip() {
  state = { legs: [], parlayPrice: null, mode: state.mode }
  save()
}

/** Replace the slip with legs from a shared link, a pick or the lock (cards from /api/<league>/track). */
export function importLegs(cards, prices = {}) {
  state = { ...state, legs: cards.slice(0, MAX_LEGS).map((c) => ({ ...snapshot(c), price: prices[legRef(c)] ?? prices[c.id] ?? null, book: c.book || null })) }
  save()
}

/**
 * Parlay math. APEX probabilities multiply (legs treated as independent; legs from the same
 * game are flagged because they usually move together). With your book's price: expected
 * value and the Kelly stake.
 */
export function parlayMath(legs, parlayPrice) {
  if (!legs.length) return null
  const prob = legs.reduce((p, l) => p * (l.prob || 0), 1)
  const fair = fairOf(prob)
  const priced = legs.every((l) => Number.isFinite(l.price))
  const bookDecimal = Number.isFinite(parlayPrice) ? decimalOf(parlayPrice) : priced ? legs.reduce((d, l) => d * decimalOf(l.price), 1) : null
  const book = bookDecimal ? americanOf(bookDecimal) : null
  const ev = bookDecimal ? prob * bookDecimal - 1 : null
  const kelly = bookDecimal ? Math.max(0, (prob * bookDecimal - 1) / (bookDecimal - 1)) : null
  const games = new Map()
  for (const l of legs) games.set(l.gameId, (games.get(l.gameId) || 0) + 1)
  const sameGame = [...games.values()].some((n) => n > 1)
  return { prob, fair, book, bookDecimal, ev, kelly, sameGame, priced: Boolean(bookDecimal) }
}

/** The slip page path for these legs ("nba:<id>" for legs outside the NFL). */
export function sharePath(legs) {
  const refs = legs.map(shareRef).join(',')
  const prices = legs.map((l) => (Number.isFinite(l.price) ? l.price : '')).join(',')
  const q = new URLSearchParams({ legs: refs })
  if (prices.replace(/,/g, '')) q.set('odds', prices)
  return `/slip?${q.toString()}`
}
export const shareUrl = (legs) => `${SITE_URL}${sharePath(legs)}`

/** A shared link: the legs as refs (with their league) and any prices, keyed by ref. */
export function parseShare(search) {
  const q = new URLSearchParams(search)
  const refs = String(q.get('legs') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_LEGS)
  const prices = String(q.get('odds') || '').split(',')
  const out = {}
  refs.forEach((ref, i) => {
    const n = Number(prices[i])
    if (Number.isFinite(n) && Math.abs(n) >= 100) out[ref] = n
  })
  return { ids: refs, refs: refs.map(splitRef), prices: out }
}

/** Plain text for a group chat, a note, or to type into a sportsbook. */
export function slipText(legs, parlayPrice) {
  const m = parlayMath(legs, parlayPrice)
  const head = legs.length > 1 ? `APEX ${legs.length}-leg parlay: ${pct(m.prob)} to hit, fair ${fmtOdds(m.fair)}${m.book ? `, book ${fmtOdds(m.book)}` : ''}` : 'APEX pick'
  const rows = legs.map((l) => `- ${l.name}: ${l.label}${Number.isFinite(l.price) ? ` (${fmtOdds(l.price)})` : ''}, APEX ${pct(l.prob)}`)
  return [head, ...rows, shareUrl(legs)].join('\n')
}

// The APEX rules, as the pages show them. The server (backend/src/nfl/rules.js) is the source
// of truth for the lock; these mirror its numbers for the price checks done in the browser.
import { decimalOf, impliedOf } from './format.js'

export const RULES = {
  legMin: 0.65,
  comboMin: 0.45,
  edgeMin: 0.02,
  maxFavorite: -500,
  stake: { lock: 0.02, single: 0.03, daily: 0.05 },
  kelly: 0.25,
}

export const PRINCIPLES = [
  { k: 'Edge or Pass', v: 'No bet without a calculable edge over the vig, and nothing priced shorter than -500, where the juice eats any edge.' },
  { k: 'Sample size integrity', v: 'Every number rests on at least 8 games.' },
  { k: 'Sharp money over public', v: 'A line moving against a side since it opened rules it out.' },
  { k: 'Correlation intelligence', v: 'Legs that win together are kept; legs that pull against each other are cut.' },
  { k: 'Bankroll preservation', v: 'Lock 2% of bankroll at most, a single 3%, a whole day 5%.' },
  { k: 'Regression awareness', v: 'A hot streak the projection doesn’t back doesn’t count.' },
  { k: 'Recency supremacy', v: 'The last 15 days carry the most weight.' },
  { k: 'Season ledger discipline', v: 'Every lock is recorded and graded, wins, losses and passes.' },
  { k: 'Positive expected value only', v: 'At the price you can get, or it’s a pass.' },
]

/** Edge of probability p at an American price: points over the implied chance, and EV per $1. */
export function edgeAt(p, american) {
  const imp = impliedOf(american)
  const d = decimalOf(american)
  if (imp == null || !d) return null
  return { implied: imp, edge: p - imp, ev: p * d - 1, ok: p - imp >= RULES.edgeMin && p * d - 1 > 0 && american > RULES.maxFavorite }
}

/** Quarter Kelly at decimal odds d, before the caps. */
export function kellyQuarter(p, d) {
  if (!(d > 1)) return 0
  return Math.max(0, ((p * d - 1) / (d - 1)) * RULES.kelly)
}

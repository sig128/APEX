// The APEX ruleset. One place for the numbers (the lock engine, the stake caps and the parlay
// check all read them) and one block of prompt text every AI answer is held to.

export const RULES = {
  /** every leg of a 3-Leg Lock */
  legMin: 0.65,
  /** the three legs multiplied, before any correlation bonus */
  comboMin: 0.45,
  /** APEX probability over the price's implied probability (vig included), in points */
  edgeMin: 0.02,
  /** legs priced shorter than this carry too much juice to beat reliably */
  maxFavorite: -500,
  /** games behind a number before it counts */
  sampleMin: 8,
  /** "recency supremacy": the window that carries the most weight */
  recentDays: 15,
  /** recency-weighted hit rate a leg has to hold */
  recentMin: 0.6,
  /** the projection on its own has to back the side (regression awareness) */
  modelMin: 0.58,
  /** snaps/targets role */
  roleMin: 0.7,
  /** pairs of legs that pull against each other this hard are eliminated */
  corrFloor: -0.05,
  /** bankroll preservation, as a share of bankroll */
  stake: { lock: 0.02, single: 0.03, daily: 0.05 },
  /** Kelly fraction before the caps */
  kelly: 0.25,
}

/** Weights for the recency-weighted hit rate: the last 15 days count most. */
export const RECENCY_WEIGHTS = { d15: 0.5, l5: 0.3, season: 0.2 }

export const RULES_PROMPT = `APEX RULES (every answer follows them):
- Run the numbers on every edge you are given before giving an opinion. Every leg you back must be defensible on its own with statistics you can point to (hit rates with their sample sizes, projection vs the line, matchup rank, line movement).
- The 3-Leg Lock comes first: three legs, each at least ${RULES.legMin * 100}% to win, combined over ${RULES.comboMin * 100}% before any correlation bonus. If nothing meets that, say there is no lock.
- Edge or Pass: no bet without a calculable edge over the vig (APEX probability above the probability the price implies). No edge, or no price to measure it against, means Pass or "only at <price> or better". Nothing priced shorter than ${RULES.maxFavorite}: at that juice a small miss in the estimate wipes out the edge.
- Sample size integrity: say how many games a number rests on. Under ${RULES.sampleMin} games is thin; say so.
- Sharp money over public money: a line that moved toward a side since it opened is where the respected money went. Don't fight it without a reason.
- Correlation intelligence: legs that win together are a plus; legs that pull against each other get cut.
- Bankroll preservation: a 3-Leg Lock at most ${RULES.stake.lock * 100}% of bankroll, a single bet at most ${RULES.stake.single * 100}%, a whole day at most ${RULES.stake.daily * 100}%.
- Regression awareness: a hot streak the projection doesn't back is luck; expect it to cool.
- Recency supremacy: the last ${RULES.recentDays} days carry the most weight.
- Season ledger discipline: every lock is recorded and graded, wins and losses alike.
- Positive expected value only.`

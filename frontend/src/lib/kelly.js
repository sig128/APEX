// Kelly stake sizing and a bankroll simulator. Pure functions so pages and tests share them.

/** Full Kelly fraction of bankroll for win probability p at decimal odds d (0 when there's no edge). */
export function kellyFraction(p, d) {
  if (!(p > 0 && p < 1) || !(d > 1)) return 0
  return Math.max(0, (p * d - 1) / (d - 1))
}

export const edgeOf = (p, d) => (d > 1 ? p * d - 1 : null)

/** Seeded random numbers so a simulation can be re-run exactly. */
export function rng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Simulate `bets` wagers in a row, each with win probability p at decimal odds d, staking
 * `mult` x Kelly of the current bankroll (capped at maxStake of bankroll), over `paths`
 * futures. Returns percentile bands per step and the odds of doubling or going broke.
 * Optionally the true win rate differs from the one you size with (overconfidence test).
 */
export function simulate({ bankroll = 1000, p = 0.55, d = 1.91, bets = 200, mult = 0.25, paths = 2000, maxStake = 0.25, trueP = null, seed = 7 } = {}) {
  const f = Math.min(maxStake, kellyFraction(p, d) * mult)
  const real = trueP ?? p
  const rand = rng(seed)
  const steps = Math.max(1, Math.min(2000, Math.round(bets)))
  const n = Math.max(100, Math.min(20_000, Math.round(paths)))
  const every = Math.max(1, Math.round(steps / 120))
  const marks = []
  for (let s = 0; s <= steps; s += every) marks.push(s)
  if (marks[marks.length - 1] !== steps) marks.push(steps)
  const at = marks.map(() => new Float64Array(n))
  const ends = new Float64Array(n)
  let doubled = 0
  let broke = 0
  let maxDrawdowns = 0
  for (let i = 0; i < n; i++) {
    let b = bankroll
    let peak = b
    let worst = 0
    let m = 0
    if (marks[0] === 0) at[m++][i] = b
    for (let s = 1; s <= steps; s++) {
      const stake = b * f
      b += rand() < real ? stake * (d - 1) : -stake
      if (b > peak) peak = b
      const dd = 1 - b / peak
      if (dd > worst) worst = dd
      if (m < marks.length && marks[m] === s) at[m++][i] = b
    }
    ends[i] = b
    if (b >= bankroll * 2) doubled++
    if (b <= bankroll * 0.1) broke++
    maxDrawdowns += worst
  }
  const q = (arr, x) => {
    const s = Float64Array.from(arr).sort()
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(x * (s.length - 1))))]
  }
  const bands = marks.map((s, k) => ({ step: s, p5: q(at[k], 0.05), p25: q(at[k], 0.25), p50: q(at[k], 0.5), p75: q(at[k], 0.75), p95: q(at[k], 0.95) }))
  return {
    stake: f,
    full: kellyFraction(p, d),
    edge: edgeOf(p, d),
    bands,
    median: q(ends, 0.5),
    p5: q(ends, 0.05),
    p95: q(ends, 0.95),
    doubled: doubled / n,
    broke: broke / n,
    avgDrawdown: maxDrawdowns / n,
    paths: n,
    steps,
  }
}

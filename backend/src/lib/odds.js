// American odds <-> probabilities.

export function americanToProb(a) {
  const n = Number(a)
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) < 100) return null
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100)
}

/** Fair American price for a probability. 50% is +100 (even money). */
export function probToAmerican(p) {
  if (!(p > 0 && p < 1)) return null
  if (p > 0.5) return -Math.round((p / (1 - p)) * 100)
  return Math.round(((1 - p) / p) * 100)
}

export function americanToDecimal(a) {
  const n = Number(a)
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null
  return n > 0 ? 1 + n / 100 : 1 + 100 / -n
}

export function decimalToAmerican(d) {
  if (!(d > 1)) return null
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1))
}

/** Remove the vig from a two-way market. Returns [pA, pB] summing to 1. */
export function noVig(aOdds, bOdds) {
  const pa = americanToProb(aOdds)
  const pb = americanToProb(bOdds)
  if (pa == null || pb == null) return null
  const t = pa + pb
  return [pa / t, pb / t]
}

export function formatAmerican(a) {
  if (a == null || !Number.isFinite(a)) return null
  return a > 0 ? `+${a}` : String(a)
}

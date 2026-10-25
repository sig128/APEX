// Probability helpers for hit rates and projections.

/** Lower bound of the Wilson score interval: a hit rate you can trust given the sample size. */
export function wilsonLower(hits, n, z = 1.2816) {
  if (!n) return 0
  const p = hits / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return Math.max(0, (centre - margin) / denom)
}

/** Exponentially weighted mean, newest value LAST. alpha in (0,1]: higher = more weight on recent games. */
export function ewma(values, alpha = 0.3) {
  if (!values.length) return null
  let m = values[0]
  for (let i = 1; i < values.length; i++) m = alpha * values[i] + (1 - alpha) * m
  return m
}

export function ewmsd(values, alpha = 0.3) {
  if (values.length < 2) return null
  let m = values[0]
  let v = 0
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - m
    m += alpha * d
    v = (1 - alpha) * (v + alpha * d * d)
  }
  return Math.sqrt(v)
}

// Abramowitz-Stegun erf approximation (max error ~1.5e-7).
function erf(x) {
  const s = Math.sign(x)
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
  return s * y
}

export const normalCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2))

/** P(X > line) for X ~ Normal(mean, sd). */
export function normalOver(mean, sd, line) {
  if (!(sd > 0)) return mean > line ? 1 : 0
  return 1 - normalCdf((line - mean) / sd)
}

export function poissonPmf(lambda, k) {
  if (k < 0) return 0
  let p = Math.exp(-lambda)
  for (let i = 1; i <= k; i++) p *= lambda / i
  return p
}

/** P(X >= k) for X ~ Poisson(lambda). k is capped so silly lines can't stall the loop. */
export function poissonAtLeast(lambda, k) {
  const kk = Math.max(0, Math.min(60, Math.ceil(k)))
  if (kk === 0) return 1
  if (!(lambda > 0)) return 0
  let cdf = 0
  for (let i = 0; i < kk; i++) cdf += poissonPmf(lambda, i)
  return Math.max(0, Math.min(1, 1 - cdf))
}

export function quantile(sorted, q) {
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Shrink an observed rate toward a prior: (hits + prior*w) / (n + w). */
export function shrink(hits, n, prior, weight) {
  return (hits + prior * weight) / (n + weight)
}

/**
 * Implied probability from American odds (same formula as backend oddsEvents).
 * @param {number} price
 * @returns {number | null}
 */
export function impliedPercentFromAmerican(price) {
  const n = Number(price)
  if (!Number.isFinite(n) || n === 0) return null
  if (n > 0) return (100 / (n + 100)) * 100
  const a = Math.abs(n)
  return (a / (a + 100)) * 100
}

/**
 * @param {number} price
 * @returns {string} e.g. "+500 (16.67%)" or "-110 (52.38%)"
 */
export function formatAmericanOddsPlain(price) {
  const n = Number(price)
  if (!Number.isFinite(n)) return '—'
  const r = Math.round(n)
  return r > 0 ? `+${r}` : `${r}`
}

/**
 * @param {number} price
 * @returns {string}
 */
export function formatAmericanOddsWithImpliedPercent(price) {
  const label = formatAmericanOddsPlain(price)
  const pct = impliedPercentFromAmerican(price)
  if (pct == null) return label
  const s = pct >= 99.95 ? pct.toFixed(0) : pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)
  return `${label} (${s}%)`
}

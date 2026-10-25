// Token buckets, keyed by caller. Memory only: each instance limits on its own, which is
// enough to blunt abuse; spend limits that must hold across instances live in the store.
export function createLimiter({ burst = 10, perSec = 1, max = 20_000 } = {}) {
  const buckets = new Map()
  function take(key, cost = 1) {
    const now = Date.now()
    let b = buckets.get(key)
    if (!b) {
      b = { tokens: burst, at: now }
      buckets.set(key, b)
      if (buckets.size > max) buckets.delete(buckets.keys().next().value)
    }
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec)
    b.at = now
    if (b.tokens < cost) return { ok: false, retryAfter: Math.max(1, Math.ceil((cost - b.tokens) / perSec)) }
    b.tokens -= cost
    return { ok: true, left: Math.floor(b.tokens) }
  }
  return { take, reset: (key) => buckets.delete(key), size: () => buckets.size }
}

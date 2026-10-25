// Daily budgets of The Odds API credits, kept in the shared store so every instance draws from
// the same pool. Each event-odds call costs [markets returned] x [regions] credits; listing
// events is free. Two pools: 'nfl' (sportsbook prices on the NFL board) and 'analyzer' (the
// multi-sport analyzer pages), so browsing one can't starve the other.
const local = new Map() // fallback when there is no store (tests, a single local process)

export const dayOf = (t) => new Date(t).toISOString().slice(0, 10)

function keyFor(pool, day) {
  return pool === 'nfl' ? `spend:${day}` : `spend:${pool}:${day}`
}

/** Reserve `cost` credits from today's pool. { ok, used } — ok is false once the pool is spent. */
export async function takeOddsCredits(store, cost, { pool = 'nfl', daily = 400, now = () => Date.now() } = {}) {
  const day = dayOf(now())
  const key = keyFor(pool, day)
  if (!(cost > 0)) return { ok: true, used: 0 }
  let ok = false
  let used = 0
  if (!store) {
    used = local.get(key) || 0
    if (used + cost > daily) return { ok: false, used }
    local.set(key, used + cost)
    if (local.size > 50) local.delete(local.keys().next().value)
    return { ok: true, used: used + cost }
  }
  await store.update('oddsprops', key, (cur) => {
    used = cur?.used || 0
    if (used + cost > daily) {
      ok = false
      return undefined
    }
    ok = true
    used += cost
    return { used, day }
  })
  return { ok, used }
}

export async function oddsCreditsUsed(store, { pool = 'nfl', now = () => Date.now() } = {}) {
  const key = keyFor(pool, dayOf(now()))
  if (!store) return local.get(key) || 0
  return (await store.get('oddsprops', key))?.used || 0
}

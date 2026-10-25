// Where slip legs stand: each league's legs come from its own /track, back in slip order.
import { api } from './api.js'
import { apiOf } from './leagues.js'

/** legs: [{ id, sport }] -> the tracked cards, same order; a leg off the board comes back { id, missing: true }. */
export async function trackLegs(legs) {
  const groups = new Map()
  legs.forEach((l, i) => {
    const k = l.sport || 'nfl'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push({ id: l.id, i })
  })
  const out = new Array(legs.length)
  await Promise.all(
    [...groups].map(async ([sport, list]) => {
      const r = await api(`${apiOf(sport)}/track?ids=${encodeURIComponent(list.map((x) => x.id).join(','))}`, { auth: false })
      list.forEach((x, k) => {
        const leg = r.legs?.[k] || { id: x.id, missing: true }
        out[x.i] = { ...leg, sport: leg.sport || sport }
      })
    }),
  )
  return out
}

// Live slips: where each leg of an open pick stands during its game, and the chance it still
// hits. The remaining production is the projection scaled to the share of the game left, with
// the projection's spread shrunk the same way (Poisson markets keep their own shape).
import { MARKETS } from '../nfl/markets.js'
import { normalOver, poissonAtLeast } from '../lib/stats.js'
import { round } from '../lib/util.js'

/** Chance the leg's side still hits, from the board row and its live progress. */
export function liveChance(row, prog) {
  if (!row || !prog || prog.untracked) return null
  const line = prog.line ?? row.line
  const cur = Number(prog.cur) || 0
  const over = (prog.side || row.side) !== 'u'
  if (prog.final) return prog.status === 'hit' ? 1 : prog.status === 'push' ? null : 0
  if (cur > line) return over ? 1 : 0
  const rem = Math.max(0, 1 - (Number(prog.elapsed) || 0))
  const proj = Number.isFinite(row.proj) ? row.proj : line
  const mk = MARKETS[row.market]
  let pOver
  if (rem <= 0) pOver = 0
  else if (mk?.dist === 'poisson') pOver = poissonAtLeast(Math.max(0.01, proj * rem), Math.floor(line - cur) + 1)
  else {
    const sd = Number.isFinite(row.sd) && row.sd > 0 ? row.sd : Math.max(1, proj * (mk?.cv || 0.4))
    pOver = normalOver(proj * rem, sd * Math.sqrt(rem), line - cur)
  }
  return round(over ? pOver : 1 - pOver, 3)
}

/** The whole slip: legs already decided count as 1 (hit) or end it (miss); open ones multiply. */
export function slipChance(legs) {
  let p = 1
  for (const l of legs) {
    if (l.result === 'loss') return 0
    if (l.result === 'win' || l.result === 'push' || l.result === 'void') continue
    if (!Number.isFinite(l.chance)) return null
    p *= l.chance
  }
  return round(p, 3)
}

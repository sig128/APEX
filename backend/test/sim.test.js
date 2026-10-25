// The parlay Monte Carlo: legs hit as often as APEX says, stacked legs move together, and the
// price math is right.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulateSlip, statCorrelation, phi, phiInv, luckVsSkill } from '../src/nfl/analytics/sim.js'

const qb = { id: 'qb', playerId: '1', teamId: 't1', gameId: 'g1', market: 'passYds', side: 'o', line: 245.5, prob: 0.6, sd: 55 }
const wr = { id: 'wr', playerId: '2', teamId: 't1', gameId: 'g1', market: 'recYds', side: 'o', line: 64.5, prob: 0.58, sd: 28 }
const rb = { id: 'rb', playerId: '3', teamId: 't1', gameId: 'g1', market: 'rushAtt', side: 'o', line: 15.5, prob: 0.55, sd: 4 }
const td = { id: 'td', playerId: '4', teamId: 't9', gameId: 'g2', market: 'anyTd', side: 'o', line: 0.5, prob: 0.42, oneSided: true }

test('normal helpers', () => {
  assert.ok(Math.abs(phi(1.96) - 0.975) < 1e-4)
  assert.ok(Math.abs(phiInv(0.975) - 1.96) < 1e-3)
  assert.ok(Math.abs(phiInv(phi(-0.7)) + 0.7) < 1e-4)
})

test('every leg hits as often as APEX says', () => {
  const r = simulateSlip([qb, wr, rb, td], { iterations: 100_000, seed: 3 })
  for (const l of r.legs) assert.ok(Math.abs(l.hitRate - l.apex) < 0.01, `${l.id} ${l.hitRate}`)
  assert.equal(r.iterations, 100_000)
})

test('a QB and his receiver go up together; a pass-heavy script starves the run game', () => {
  assert.ok(statCorrelation(qb, wr) > 0.3)
  assert.ok(statCorrelation(qb, { ...rb, market: 'rushYds' }) < 0.05)
  assert.equal(statCorrelation(qb, td), 0, 'different games are independent')
  const stack = simulateSlip([qb, wr], { iterations: 100_000, seed: 5 })
  assert.ok(stack.parlay.hitRate > stack.parlay.independent + 0.02, `stacked ${stack.parlay.hitRate} vs independent ${stack.parlay.independent}`)
  const against = simulateSlip([qb, { ...wr, side: 'u', prob: 0.42 }], { iterations: 100_000, seed: 5 })
  assert.ok(against.parlay.hitRate < against.parlay.independent - 0.02, 'betting against your own stack hits less often')
})

test('price, break-even and luck vs skill', () => {
  const r = simulateSlip([qb, td], { iterations: 50_000, seed: 9, price: 300, bets: 200 })
  assert.equal(r.price.implied, 0.25)
  const want = r.parlay.hitRate * 3 - (1 - r.parlay.hitRate - r.parlay.pushRate)
  assert.ok(Math.abs(r.price.ev - want) < 1e-12)
  assert.equal(r.luck.bets, 200)
  assert.equal(r.luck.skill.bands.length, 21)
  const fair = luckVsSkill({ p: 0.25, dec: 4, bets: 500, bettors: 3000 })
  assert.ok(Math.abs(fair.skill.median) < 40, 'no edge: the median bettor ends near even')
  const edge = luckVsSkill({ p: 0.3, dec: 4, bets: 500, bettors: 3000 })
  assert.ok(edge.skill.up > fair.skill.up, 'an edge shows up over enough bets')
})

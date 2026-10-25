import test from 'node:test'
import assert from 'node:assert/strict'
import { certifyLeg, findLock, legCorrelation, playableAt, recencyOf, kellyStake } from '../src/nfl/analytics/lock.js'
import { RULES } from '../src/nfl/rules.js'

const NOW = Date.parse('2026-10-25T12:00:00Z')
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString()

let seq = 0
/** A prop row that passes every check unless overridden. */
function row(over = {}) {
  seq++
  const id = over.id || `${1000 + seq}.recYds.o.40.5`
  return {
    id,
    kind: 'player',
    playerId: String(1000 + seq),
    teamId: `T${seq}`,
    gameId: `G${seq}`,
    name: `Player ${seq}`,
    short: `P. ${seq}`,
    teamAbbr: 'AAA',
    oppAbbr: 'BBB',
    market: 'recYds',
    label: 'Over 40.5 Receiving Yards',
    shortLabel: 'O 40.5 Rec Yds',
    line: 40.5,
    side: 'o',
    prob: 0.8,
    probModel: 0.72,
    proj: 58,
    sd: 18,
    sample: 14,
    role: 0.9,
    posted: 'main',
    windows: [
      { key: 'L5', hits: 4, n: 5 },
      { key: 'L10', hits: 8, n: 10 },
      { key: 'L20', hits: 15, n: 20 },
      { key: 'season', hits: 6, n: 7 },
    ],
    recent: [
      { date: daysAgo(40), o: 'hit' },
      { date: daysAgo(33), o: 'miss' },
      { date: daysAgo(26), o: 'hit' },
      { date: daysAgo(12), o: 'hit' },
      { date: daysAgo(5), o: 'hit' },
    ],
    price: null,
    move: null,
    ...over,
  }
}
const state = (c, key) => c.checks.find((x) => x.key === key).state

test('a leg is certified on seven traceable checks', () => {
  const c = certifyLeg(row(), { now: NOW })
  assert.equal(c.ok, true)
  assert.deepEqual(c.checks.map((x) => x.key), ['prob', 'edge', 'sample', 'recency', 'regression', 'role', 'market'])
  assert.equal(state(c, 'edge'), 'pending', 'no price: the edge waits on one')
  assert.match(c.checks.find((x) => x.key === 'edge').detail, /Playable at -/)
  assert.equal(c.playable, playableAt(0.8))
  assert.equal(playableAt(0.78), -317, 'implied 76% (2 points under APEX)')
  for (const x of c.checks) assert.ok(x.detail.length > 8, `${x.key} explains itself`)
})

test('each rule can fail a leg on its own', () => {
  assert.equal(state(certifyLeg(row({ prob: 0.64 }), { now: NOW }), 'prob'), 'fail')
  // -400 implies 80%: no edge over the vig at APEX 80%
  assert.equal(state(certifyLeg(row({ price: { over: -400, under: 300 } }), { now: NOW }), 'edge'), 'fail')
  const priced = certifyLeg(row({ price: { over: -250, under: 200 } }), { now: NOW })
  assert.equal(state(priced, 'edge'), 'pass')
  assert.ok(priced.ev > 0)
  assert.equal(state(certifyLeg(row({ sample: 6 }), { now: NOW }), 'sample'), 'fail')
  const cold = row({ recent: [{ date: daysAgo(30), o: 'hit' }, { date: daysAgo(12), o: 'miss' }, { date: daysAgo(5), o: 'miss' }] })
  assert.equal(state(certifyLeg(cold, { now: NOW }), 'recency'), 'fail', 'missed every game of the last 15 days')
  assert.equal(state(certifyLeg(row({ probModel: 0.5 }), { now: NOW }), 'regression'), 'fail', 'the projection alone has to back it')
  const streak = row({ windows: [{ key: 'L5', hits: 5, n: 5 }, { key: 'L20', hits: 9, n: 20 }], recent: Array.from({ length: 5 }, (_, i) => ({ date: daysAgo(35 - i * 7), o: 'hit' })) })
  assert.equal(state(certifyLeg(streak, { now: NOW }), 'regression'), 'fail', 'a perfect five against 9 of 20 is a streak')
  assert.equal(state(certifyLeg(row({ role: 0.5 }), { now: NOW }), 'role'), 'fail')
  assert.equal(state(certifyLeg(row(), { now: NOW, injury: { status: 'Questionable', severity: 'questionable' } }), 'role'), 'fail')
  assert.equal(state(certifyLeg(row({ move: { open: 44.5, delta: -4 } }), { now: NOW }), 'market'), 'fail', 'the over got cheaper: money went to the under')
  assert.equal(state(certifyLeg(row({ move: { open: 37.5, delta: 3 } }), { now: NOW }), 'market'), 'pass')
})

test('recency weighs the last 15 days most', () => {
  const r = recencyOf(row(), NOW)
  assert.deepEqual(r.d15, { hits: 2, n: 2 })
  const w = RULES
  assert.ok(r.weighted > 0.8 && w.recentDays === 15)
})

test('the lock: three legs over 45% multiplied, the likeliest combination wins', () => {
  const rows = [row({ prob: 0.82 }), row({ prob: 0.8 }), row({ prob: 0.78 }), row({ prob: 0.7 }), row({ prob: 0.66 }), row({ prob: 0.6 })]
  const out = findLock(rows, { now: NOW, iterations: 20_000 })
  assert.equal(out.status, 'price_needed', 'no prices: a lock, playable at the break-even price or better')
  assert.equal(out.lock.legs.length, 3)
  assert.deepEqual(out.lock.legs.map((l) => l.prob), [0.82, 0.8, 0.78])
  assert.ok(out.lock.independent > 0.45)
  assert.ok(Math.abs(out.lock.simulated - out.lock.independent) < 0.02, 'independent legs: the simulation agrees with multiplying')
  assert.ok(out.lock.breakEven < 0 || out.lock.breakEven > 0)
  assert.equal(out.lock.stake.pct, RULES.stake.lock, 'never more than 2% of bankroll')
  assert.equal(out.funnel.scanned, 6)
  assert.equal(out.funnel.prob, 5)
})

test('priced locks need positive expected value, and they win over unpriced ones', () => {
  const rows = [
    row({ prob: 0.84 }),
    row({ prob: 0.83 }),
    row({ prob: 0.82 }),
    // slightly less likely but priced with an edge
    row({ prob: 0.79, price: { over: -260, under: 210 } }),
    row({ prob: 0.79, price: { over: -250, under: 200 } }),
    row({ prob: 0.78, price: { over: -240, under: 190 } }),
  ]
  const out = findLock(rows, { now: NOW })
  assert.equal(out.status, 'certified')
  assert.ok(out.lock.legs.every((l) => l.price != null))
  assert.ok(out.lock.price.ev > 0)
  assert.ok(out.lock.stake.pct <= RULES.stake.lock)
  assert.ok(kellyStake(0.5, 3) > 0 && kellyStake(0.3, 3) === 0)
})

test('legs that pull against each other are eliminated; same-script legs get the bonus', () => {
  const qb = row({ prob: 0.82, market: 'passYds', gameId: 'GX', teamId: 'TX', playerId: 'qb1', id: 'qb1.passYds.o.220.5' })
  const wrUnder = row({ prob: 0.8, market: 'recYds', side: 'u', gameId: 'GX', teamId: 'TX', playerId: 'wr1', id: 'wr1.recYds.u.60.5' })
  assert.ok(legCorrelation(qb, wrUnder) < RULES.corrFloor)
  const third = row({ prob: 0.8 })
  const out = findLock([qb, wrUnder, third], { now: NOW })
  assert.equal(out.status, 'pass')
  assert.match(out.reason, /pull against/)

  const wrOver = row({ prob: 0.79, market: 'recYds', gameId: 'GX', teamId: 'TX', playerId: 'wr2', id: 'wr2.recYds.o.40.5' })
  const stack = findLock([qb, wrOver, row({ prob: 0.78 })], { now: NOW, iterations: 40_000 })
  assert.equal(stack.status, 'price_needed')
  assert.ok(stack.lock.bonus > 0.01, `QB and his receiver win together (+${stack.lock.bonus})`)
  assert.ok(stack.lock.pairs.length >= 1)
})

test('Pass when the rules leave nothing, with the reason', () => {
  const two = findLock([row({ prob: 0.8 }), row({ prob: 0.8 }), row({ prob: 0.6 })], { now: NOW })
  assert.equal(two.status, 'pass')
  assert.match(two.reason, /Only 2 legs/)
  const low = findLock([row({ prob: 0.7 }), row({ prob: 0.7 }), row({ prob: 0.7 })], { now: NOW })
  assert.equal(low.status, 'pass')
  assert.match(low.reason, /45%/)
  assert.equal(low.near.legs.length, 3)
  assert.ok(Math.abs(low.near.independent - 0.343) < 0.001)
})

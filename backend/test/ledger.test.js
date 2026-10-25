import test from 'node:test'
import assert from 'node:assert/strict'
import { createLedger, settleLock } from '../src/nfl/ledger.js'
import { createStore } from '../src/lib/store.js'

const KICK = Date.parse('2026-10-25T17:00:00Z')

function fakeEngine() {
  return {
    wh: {
      season: 2026,
      week: 8,
      games: new Map([['G1', { id: 'G1', status: { state: 'pre' } }]]),
      summaries: new Map(),
      logs: new Map(),
    },
  }
}

const leg = (n, over = {}) => ({ id: `p${n}.recYds.o.40.5`, kind: 'player', playerId: `p${n}`, gameId: 'G1', kickoff: new Date(KICK).toISOString(), name: `Player ${n}`, short: `P${n}`, market: 'recYds', label: 'Over 40.5 Receiving Yards', line: 40.5, side: 'o', prob: 0.8, price: -250, ...over })
const lockOut = (legs) => ({
  status: 'certified',
  season: 2026,
  week: 8,
  funnel: { scanned: 100 },
  lock: { id: legs.map((l) => l.id).join('~'), legs, independent: 0.51, simulated: 0.52, price: { decimal: 2.744, american: 174, ev: 0.42 }, breakEven: -108, stake: { pct: 0.02, cap: 0.02, kelly: 0.05 } },
})

test('the ledger keeps the lock as it stood at kickoff, then grades it from the box score', async () => {
  let t = KICK - 3 * 3600_000
  const engine = fakeEngine()
  const store = createStore({ driver: 'memory' })
  const ledger = createLedger({ engine, store, now: () => t })

  await ledger.record(lockOut([leg(1), leg(2), leg(3)]))
  // the board moves before kickoff: the newer lock replaces it
  await ledger.record(lockOut([leg(1), leg(2), leg(4)]))
  let s = await ledger.season()
  assert.equal(s.weeks.length, 1)
  assert.equal(s.weeks[0].status, 'open')
  assert.deepEqual(s.weeks[0].lock.legs.map((l) => l.playerId), ['p1', 'p2', 'p4'])

  t = KICK + 60_000
  await ledger.tick()
  // a later board can't rewrite a lock that has started
  await ledger.record(lockOut([leg(5), leg(6), leg(7)]))
  s = await ledger.season()
  assert.equal(s.weeks[0].status, 'live')
  assert.equal(s.weeks[0].frozen, true)
  assert.deepEqual(s.weeks[0].lock.legs.map((l) => l.playerId), ['p1', 'p2', 'p4'])

  t = KICK + 4 * 3600_000
  engine.wh.summaries.set('G1', { data: { status: { state: 'post' }, players: { p1: { stats: { recYds: 55, rec: 4 } }, p2: { stats: { recYds: 41, rec: 3 } }, p4: { stats: { recYds: 70, rec: 6 } } } } })
  await ledger.tick()
  s = await ledger.season()
  assert.equal(s.weeks[0].status, 'graded')
  assert.equal(s.weeks[0].result, 'win')
  assert.equal(s.record.wins, 1)
  // 2 units at three -250 legs: 2 x (1.4^3 - 1)
  assert.ok(Math.abs(s.weeks[0].profit - 2 * (1.4 ** 3 - 1)) < 0.02)
  assert.ok(s.record.roi > 0)
})

test('a Pass week stays on the record', async () => {
  const engine = fakeEngine()
  const store = createStore({ driver: 'memory' })
  let t = KICK - 3600_000
  const ledger = createLedger({ engine, store, now: () => t })
  await ledger.record({ status: 'pass', season: 2026, week: 8, funnel: { scanned: 80 }, reason: 'Only 2 legs passed every check.', lock: null })
  engine.wh.games.get('G1').status.state = 'post'
  t += 5 * 3600_000
  await ledger.tick()
  const s = await ledger.season()
  assert.equal(s.weeks[0].status, 'pass')
  assert.equal(s.record.passes, 1)
})

test('settling: any loss loses, pushes drop out, unpriced locks keep W/L without units', () => {
  const e = { lock: { legs: [leg(1), leg(2), leg(3, { price: null })], stake: { pct: 0.02 } } }
  assert.equal(settleLock(e, [{ result: 'win' }, { result: 'loss' }, { result: 'win' }]).result, 'loss')
  const unpriced = settleLock(e, [{ result: 'win' }, { result: 'win' }, { result: 'win' }])
  assert.equal(unpriced.result, 'win')
  assert.equal(unpriced.profit, null)
  const pushed = settleLock(e, [{ result: 'win' }, { result: 'win' }, { result: 'push' }])
  assert.equal(pushed.result, 'win')
  assert.ok(pushed.profit > 0, 'the push leg drops out and the two priced legs pay')
  assert.equal(settleLock(e, [{ result: 'win' }, null, { result: 'win' }]), null)
})

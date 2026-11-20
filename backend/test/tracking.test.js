// Tracking: the P&L line, the record and the trends, wins and losses alike, with small samples flagged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracking, SMALL } from '../src/picks/tracking.js'

const DAY = 86_400_000
const T = Date.parse('2026-11-20T12:00:00Z')
const pick = (i, result, { legs = 1, price = -110, units = 1, sport = 'nfl', market = 'rushYds', ago = i, legResults } = {}) => ({
  id: `p${i}`,
  status: 'graded',
  result,
  units,
  price,
  profit: result === 'win' ? units * (price > 0 ? price / 100 : 100 / -price) : result === 'loss' ? -units : 0,
  clv: 0.01,
  gradedAt: T - ago * DAY,
  legs: Array.from({ length: legs }, (_, k) => ({ sport, market, label: 'Over 59.5 Rushing Yards', price, result: legResults ? legResults[k] : result === 'loss' && k > 0 ? 'win' : result })),
})

test('a record, a daily line, trends by legs, league and market, and the streak', () => {
  const picks = [
    pick(1, 'win'),
    pick(2, 'loss'),
    pick(3, 'win', { legs: 3, price: 600, sport: 'nba', market: 'ast', legResults: ['win', 'win', 'win'] }),
    pick(4, 'loss', { legs: 3, price: 600, sport: 'nba', market: 'ast', legResults: ['win', 'win', 'loss'] }),
    pick(5, 'push'),
    pick(45, 'win', { ago: 45 }),
    { id: 'open', status: 'open', legs: [{}] },
  ]
  const t = tracking(picks, { now: T, range: '30d' })
  assert.deepEqual([t.record.picks, t.record.w, t.record.l, t.record.p], [5, 2, 2, 1], 'the open pick and the 45-day-old one are out')
  assert.equal(t.record.hit, 0.5)
  assert.equal(t.record.units, 4.91, '+0.91 −1 +6 −1')
  assert.equal(t.record.roi, 1.227, 'units over what was risked on decided picks')
  assert.equal(t.series.length, 5)
  assert.equal(t.series[t.series.length - 1].cum, t.record.units, 'the line ends at the record')
  assert.deepEqual(t.series.map((d) => d.day), [...t.series.map((d) => d.day)].sort(), 'oldest first')
  assert.deepEqual(t.byLegs.map((x) => [x.key, x.picks]), [['1', 3], ['3', 2]])
  assert.deepEqual(t.bySport.map((x) => x.key).sort(), ['nba', 'nfl'])
  const ast = t.byMarket.find((m) => m.key === 'ast')
  assert.deepEqual([ast.w, ast.l, ast.units], [5, 1, null], 'every leg counts, a losing parlay’s winning legs too')
  assert.ok(t.byLegs.every((x) => x.small), `under ${SMALL} decided picks is a small sample`)
  assert.deepEqual(t.streak, { kind: 'win', n: 1 }, 'the latest decided pick (a day ago) won')
  assert.deepEqual(t.last10, ['loss', 'win', 'loss', 'win'], 'oldest to newest, pushes left out')
  assert.equal(tracking(picks, { now: T, range: 'all' }).record.picks, 6)
  assert.equal(tracking([], { now: T }).record.hit, null)
})

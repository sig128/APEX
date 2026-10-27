// The props board's bet types and order: counts per bet type and side under the other filters,
// any mix of bet types, every sort in both directions, and props without the sorted number kept
// at the bottom either way.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fullEngine } from './support.js'

let engine
before(async () => {
  engine = await fullEngine()
})
after(() => engine?.stop())

const board = (q) => engine.views.props({ limit: 100, ...q })
const countOf = (b, key) => b.facets.markets.find((m) => m.key === key)?.count ?? 0

test('bet types: each one says how many props it holds, and the totals add up', () => {
  const main = board({ market: 'core' })
  const all = board({ market: 'all' })
  assert.ok(main.total > 20)
  assert.equal(main.facets.marketTotals.core, main.total)
  assert.equal(main.facets.marketTotals.all, all.total)
  assert.equal(main.facets.markets.reduce((s, m) => s + m.count, 0), all.total)
  // the busiest single type, alone
  const top = [...main.facets.markets].sort((a, b) => b.count - a.count)[0]
  const one = board({ market: top.key })
  assert.equal(one.total, top.count)
  assert.ok(one.rows.every((r) => r.market === top.key))
  // two at once
  const second = [...main.facets.markets].sort((a, b) => b.count - a.count)[1]
  const two = board({ market: `${top.key},${second.key}` })
  assert.equal(two.total, top.count + second.count)
  assert.deepEqual(new Set(two.rows.map((r) => r.market)), new Set([top.key, second.key]))
})

test('bet types and sides count under the other filters', () => {
  const qbs = board({ market: 'all', pos: 'QB' })
  assert.equal(qbs.facets.markets.reduce((s, m) => s + m.count, 0), qbs.total, 'counts follow the position filter')
  assert.equal(countOf(qbs, 'rec'), 0, 'no receiving props for quarterbacks')
  const yards = board({ market: 'recYds' })
  assert.equal(yards.facets.sides.o + yards.facets.sides.u, yards.total, 'every receiving-yards prop is an over or an under')
  const overs = board({ market: 'recYds', side: 'o' })
  assert.equal(overs.total, yards.facets.sides.o)
  assert.equal(countOf(overs, 'recYds'), overs.total, 'bet type counts follow the side')
  assert.ok(overs.rows.every((r) => r.side === 'o'))
})

test('sorting: highest first by default, lowest first on request, start times earliest first', () => {
  const desc = board({ market: 'recYds', sort: 'line' })
  const lines = desc.rows.map((r) => r.line)
  assert.deepEqual(lines, [...lines].sort((a, b) => b - a))
  assert.equal(desc.dir, 'desc')
  const asc = board({ market: 'recYds', sort: 'line', dir: 'asc' })
  const up = asc.rows.map((r) => r.line)
  assert.deepEqual(up, [...up].sort((a, b) => a - b))
  assert.ok(up[0] <= lines.at(-1), 'the lowest lines come first')
  assert.equal(asc.dir, 'asc')
  for (const sort of ['score', 'prob', 'streak']) {
    const key = sort === 'score' ? 'rank' : sort
    const up = board({ market: 'all', sort, dir: 'asc' }).rows.map((r) => r[key])
    const down = board({ market: 'all', sort }).rows.map((r) => r[key])
    assert.deepEqual(up, [...up].sort((a, b) => a - b), `${sort} lowest first`)
    assert.deepEqual(down, [...down].sort((a, b) => b - a), `${sort} highest first`)
  }
  const times = board({ market: 'all', sort: 'kickoff' }).rows.map((r) => Date.parse(r.kickoff))
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
  assert.equal(board({ sort: 'kickoff' }).dir, 'asc')
  assert.equal(board({ sort: 'nonsense' }).sort, 'score', 'an unknown sort falls back to the APEX score')
})

test('props without the sorted number stay at the bottom in both directions', () => {
  // hit rate over the last 5 against this opponent: most players have no sample
  for (const dir of ['desc', 'asc']) {
    const rows = board({ market: 'all', sort: 'hit', window: 'h2h', dir }).rows
    const has = rows.map((r) => Boolean(r.win?.n))
    const firstMissing = has.indexOf(false)
    if (firstMissing >= 0) assert.ok(has.slice(firstMissing).every((x) => !x), `${dir}: no sample sinks to the end`)
    const rates = rows.filter((r) => r.win?.n).map((r) => r.win.hits / r.win.n)
    assert.deepEqual(rates, [...rates].sort((a, b) => (dir === 'asc' ? a - b : b - a)))
  }
  // edge needs a price; give one prop a price and it leads either way
  const wh = engine.wh
  const saved = wh.prices
  const r = board({ market: 'recYds' }).rows.find((x) => !x.oneSided)
  try {
    wh.prices = new Map([[`${r.playerId}:${r.market}:${r.line}`, { over: -110, under: -110, book: 'fanduel' }]])
    wh.bump('core')
    for (const dir of ['desc', 'asc']) {
      const rows = board({ market: 'recYds', sort: 'edge', dir }).rows
      assert.ok(rows[0].edge != null, `${dir}: the priced prop comes first`)
      assert.ok(rows.slice(2).every((x) => x.edge == null))
    }
  } finally {
    wh.prices = saved
    wh.bump('core')
  }
})

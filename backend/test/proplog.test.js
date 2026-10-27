// The prop log: the board's side on every line is saved before its game (first look kept,
// last look graded), then graded from the final box score and summed into days, series and
// segments, with units at the prices that were there. This is what the admin page reads.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { fullEngine, clock } from './support.js'
import { createStore } from '../src/lib/store.js'
import { COLS, rowObj, summarizeDay, segmentsOf, addTo, ACC, dayET, createPropLog } from '../src/nfl/proplog.js'
import { parsePropId } from '../src/nfl/analytics/core.js'

const C = Object.fromEntries(COLS.map((k, i) => [k, i]))
const HOUR = 3_600_000
let engine
after(() => engine?.stop())

test('before kickoff: every line the board backs is on file with its price, and the first look is kept', async () => {
  const now = clock()
  const store = createStore({ driver: 'memory' })
  engine = await fullEngine({ now, store })
  const log = engine.proplog
  const out = await log.record()
  assert.ok(out.rows > 100, `logged ${out.rows} rows`)
  const idx = await log.index()
  assert.deepEqual(idx.open, idx.all)
  const day = idx.all[0]
  const doc = await store.get('proplog-nfl', day)
  const rows = Object.values(doc.rows)
  for (const r of rows.slice(0, 50)) {
    const o = rowObj(r)
    assert.ok(parsePropId(o.id), o.id)
    assert.ok(o.p >= 0.5 && o.p < 1, `the board's side: ${o.p}`)
    const g = engine.wh.games.get(o.game)
    assert.equal(g.status.state, 'pre', 'only games that have not started')
    assert.equal(dayET(Date.parse(g.date)), day)
    assert.equal(o.t0, o.t1)
    assert.equal(o.p0, o.p)
    assert.ok(o.res === null && o.val === null)
  }
  assert.ok(rows.every((r) => r[C.price] === null || Number.isFinite(r[C.price])), 'a price when a book posted one')
  assert.ok(Object.keys(doc.pl).length > 20 && Object.keys(doc.games).length >= 1)

  // a later look moves the latest numbers and keeps the first ones
  now.add(20 * 60_000)
  const firstKey = Object.keys(doc.rows)[0]
  await log.record()
  const again = await store.get('proplog-nfl', day)
  assert.equal(again.rows[firstKey][C.t0], doc.rows[firstKey][C.t0])
  assert.ok(again.rows[firstKey][C.t1] > doc.rows[firstKey][C.t1])
  assert.equal(again.rows[firstKey][C.price0], doc.rows[firstKey][C.price0])

  // once a game starts its rows freeze: the last pre-game look is what gets graded
  const [gid, g] = Object.entries(again.games).sort((a, b) => a[1].k - b[1].k)[0]
  engine.wh.games.get(gid).status = { ...engine.wh.games.get(gid).status, state: 'in' }
  now.set(g.k + 60_000)
  await log.record()
  const frozen = await store.get('proplog-nfl', day)
  for (const [k, r] of Object.entries(frozen.rows)) if (r[C.game] === gid) assert.equal(r[C.t1], again.rows[k][C.t1])
})

test('after the games: graded from the box score, summed into the day, and the day closes', async () => {
  const store = createStore({ driver: 'memory' })
  const now = clock(Date.parse('2026-10-29T12:00:00Z')) // 37 hours after: long enough to call a no-show
  const gid = '401900001'
  const ko = Date.parse('2026-10-27T23:00:00Z')
  const summary = {
    status: { state: 'post' },
    home: { id: '10', score: 4 },
    away: { id: '20', score: 2 },
    players: {
      101: { stats: { sog: 4, toi: 18 } }, // over 2.5: win at +120
      102: { stats: { sog: 2, toi: 15 } }, // under 1.5: loss at -150
      103: { stats: { sog: 2, toi: 16 } }, // over 2: push
    },
  }
  const fake = { sport: { key: 'nhl' }, wh: { games: new Map(), summaries: new Map([[gid, { data: summary }]]), logs: new Map(), season: 2026, aVersion: 1 }, espn: null, views: null }
  const log = createPropLog({ engine: fake, store, now })
  const day = '2026-10-27'
  const row = (id, p, price, extra = {}) => {
    const a = Array(COLS.length).fill(null)
    Object.assign(a, { [C.id]: id, [C.game]: gid, [C.p]: p, [C.price]: price, [C.best]: price, [C.book]: 'fanduel', [C.edge]: 0.04, [C.score]: 80, [C.lean]: 'f', [C.mu]: 'h', [C.home]: 1, [C.p0]: p, [C.price0]: price + (extra.move || 0), [C.line0]: parsePropId(id).line, [C.t0]: ko - 5 * HOUR, [C.t1]: ko - HOUR })
    return a
  }
  await store.set('proplog-nhl', day, {
    v: 1,
    sport: 'nhl',
    day,
    games: { [gid]: { k: ko, n: 'AAA @ BBB' } },
    pl: { 101: ['A. One', 'AAA', 'BBB', 'F'], 102: ['B. Two', 'AAA', 'BBB', 'D'], 103: ['C. Three', 'BBB', 'AAA', 'F'], 104: ['D. Four', 'BBB', 'AAA', 'F'] },
    rows: {
      a: row('101.sog.o.2.5', 0.62, 120, { move: 10 }), // the price shortened after we saw it: the line moved our way
      b: row('102.sog.u.1.5', 0.58, -150),
      c: row('103.sog.o.2', 0.55, -110),
      d: row('104.sog.o.1.5', 0.6, -130), // no box line, no log: didn't play
    },
    done: false,
  })
  await store.set('proplog-nhl', 'index', { all: [day], open: [day] })
  const out = await log.grade({ maxLogFetches: 0 })
  assert.equal(out.days, 1)
  const doc = await store.get('proplog-nhl', day)
  assert.equal(doc.done, true)
  assert.deepEqual(['a', 'b', 'c', 'd'].map((k) => doc.rows[k][C.res]), ['w', 'l', 'p', 'v'])
  assert.deepEqual(['a', 'b', 'c'].map((k) => doc.rows[k][C.val]), [4, 2, 2])
  assert.deepEqual((await log.index()).open, [], 'a finished day leaves the grader’s list')

  const sum = (await log.summaries(['2026-10']))[day]
  const [n, w, l, p, u, r] = sum.all
  assert.deepEqual([n, w, l, p, r], [3, 1, 1, 1, 3])
  assert.equal(u, 0.2, '+1.2 on the win, -1 on the loss, 0 on the push')
  assert.equal(sum.voids, 1)
  assert.deepEqual(sum.seg['m:sog'].slice(0, 4), [3, 1, 1, 1])
  assert.deepEqual(sum.seg['s:u'].slice(0, 3), [1, 0, 1])
  assert.ok(sum.seg['cl:with'], 'the price moved toward the win after it was logged')

  // and the drill-down reads like the board
  const d = await log.day(day)
  const a = d.rows.find((x) => x.id === '101.sog.o.2.5')
  assert.equal(a.name, 'A. One')
  assert.equal(a.marketLabel, 'Shots on Goal')
  assert.equal(a.res, 'w')
  assert.equal(a.side, 'o')
  assert.equal(a.line, 2.5)
})

test('a day in numbers: units at the price, the top 10 and edge 3+ series, and segments', () => {
  const mk = (id, res, price, score, edge, p = 0.6) => {
    const a = Array(COLS.length).fill(null)
    Object.assign(a, { [C.id]: id, [C.game]: 'g', [C.p]: p, [C.price]: price, [C.best]: price, [C.edge]: edge, [C.score]: score, [C.res]: res, [C.line0]: parsePropId(id).line })
    return a
  }
  const rows = {}
  for (let i = 0; i < 12; i++) rows[i] = mk(`${100 + i}.rec.o.4.5`, i % 3 === 0 ? 'l' : 'w', -110, 70 + i, i >= 10 ? 0.05 : 0.01)
  const s = summarizeDay({ rows })
  assert.equal(s.all[0], 12)
  assert.equal(s.all[1], 8)
  assert.equal(s.top[0], 10, 'the 10 best scores')
  assert.equal(s.edge[0], 2, 'edge of at least 3 points at a real price')
  assert.equal(s.all[4], Math.round((8 * (1 / 1.1) - 4) * 1000) / 1000)
  assert.ok(s.seg['pb:60'] && s.seg['eb:0'] && s.seg['eb:4'] && s.seg['sc:80'] && s.seg['pr:even'])
  // pushes count as graded bets with no win or loss; voids count nowhere
  const acc = ACC.map(() => 0)
  addTo(acc, mk('1.rec.o.4', 'p', -110, 80, 0))
  addTo(acc, mk('2.rec.o.4', 'v', -110, 80, 0))
  assert.deepEqual(acc.slice(0, 6), [1, 0, 0, 1, 0, 1])
  assert.ok(segmentsOf(mk('3.anyTd.o.0.5', 'w', 150, 85, 0.02)).includes('s:y'), 'yes bets are their own side')
})

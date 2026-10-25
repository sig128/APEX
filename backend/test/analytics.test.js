import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { parsePropId, propId, outcome, hitCount, streakOf, apexScore, fairOdds } from '../src/nfl/analytics/core.js'
import { calibrate, lineFit } from '../src/nfl/analytics/props.js'
import { gameFraction, progressFor } from '../src/nfl/services/live.js'
import { americanToProb } from '../src/lib/odds.js'
import { fullEngine } from './support.js'

test('prop ids: strict parsing from shared links', () => {
  assert.deepEqual(parsePropId('3046779.passYds.o.291.5'), { id: '3046779.passYds.o.291.5', subject: '3046779', playerId: '3046779', teamId: null, market: 'passYds', side: 'o', line: 291.5 })
  assert.equal(parsePropId('3046779.passYds.u.291.50')?.id, '3046779.passYds.u.291.5', 'normalized')
  assert.equal(parsePropId('t8.teamPts.o.24.5')?.teamId, '8')
  assert.equal(parsePropId('8.teamPts.o.24.5'), null, 'team market needs a team subject')
  assert.equal(parsePropId('t8.passYds.o.24.5'), null, 'player market needs a player subject')
  assert.equal(parsePropId('4429795.anyTd.o.0.5')?.market, 'anyTd')
  assert.equal(parsePropId('4429795.anyTd.u.0.5'), null, 'anytime TD has no under')
  assert.equal(parsePropId('4429795.anyTd.o.1.5'), null, 'anytime TD is always 0.5')
  assert.equal(parsePropId('1.passYds.o.291.3'), null, 'lines move in quarter steps')
  assert.equal(parsePropId('1.nope.o.10.5'), null)
  assert.equal(parsePropId('1.passYds.o.900.5'), null)
  assert.equal(parsePropId(`${'1'.repeat(13)}.passYds.o.1.5`), null)
  assert.equal(parsePropId('1.passYds.o.1.5;drop'), null)
  assert.equal(parsePropId(42), null)
  assert.equal(propId('9', 'rec', 'x', '4.5'), '9.rec.o.4.5')
})

test('outcomes, hit counts and streaks', () => {
  assert.equal(outcome(300, 291.5, 'o'), 'hit')
  assert.equal(outcome(300, 291.5, 'u'), 'miss')
  assert.equal(outcome(5, 5, 'o'), 'push')
  assert.equal(outcome(NaN, 5, 'o'), null)
  assert.deepEqual(hitCount([1, 6, 7, 5, null], 5, 'o'), { hits: 2, n: 3 })
  assert.equal(streakOf([1, 9, 9, 5, 9], 5, 'o'), 3, 'pushes do not break a streak')
  assert.equal(streakOf([9, 9, 1], 5, 'o'), 0)
})

test('calibration stays inside sane bounds and leans toward the market', () => {
  for (const raw of [0.01, 0.2, 0.5, 0.8, 0.99]) {
    const p = calibrate(raw, {})
    assert.ok(p > 0.02 && p < 0.98, `bounded ${raw} -> ${p}`)
  }
  const free = calibrate(0.9, {})
  const priced = calibrate(0.9, { implied: 0.45 })
  assert.ok(priced < free, 'a market price below even money pulls an overconfident read down')
  assert.ok(priced > 0.45 && priced < 0.9, 'between the market and the raw read')
  assert.ok(calibrate(0.7, {}) > calibrate(0.6, {}), 'monotone')
  assert.ok(lineFit(250, 250.5, 'o', false) >= lineFit(250, 40.5, 'o', false), 'a line far from the average fits worse')
})

test('apex score and fair odds', () => {
  let prev = -1
  for (const p of [0.3, 0.45, 0.5, 0.55, 0.65, 0.8]) {
    const s = apexScore(p, 10)
    assert.ok(s >= 0 && s <= 100)
    assert.ok(s >= prev, 'higher probability, higher score')
    prev = s
  }
  assert.ok(apexScore(0.7, 2) < apexScore(0.7, 12), 'a thin sample is trusted less')
  assert.ok(Math.abs(americanToProb(fairOdds(0.62)) - 0.62) < 0.01)
})

test('game clock fraction', () => {
  assert.equal(gameFraction({ state: 'pre' }), 0)
  assert.equal(gameFraction({ state: 'post' }), 1)
  assert.equal(gameFraction({ state: 'in', period: 2, halftime: true }), 0.5)
  assert.equal(gameFraction({ state: 'in', period: 3, clock: '15:00' }), 0.5)
  assert.equal(gameFraction({ state: 'in', period: 4, clock: '0:00' }), 1)
  assert.equal(gameFraction({ state: 'in', period: 5, clock: '8:00' }), 1)
})

// ---- the recorded Week 7 slate ---------------------------------------------------------------

let engine
before(async () => {
  engine = await fullEngine()
})
after(() => engine?.stop())

test('board: every row is well formed', () => {
  const { rows } = engine.views.allRows()
  assert.ok(rows.length > 1000, `rows ${rows.length}`)
  const ids = new Set()
  for (const r of rows) {
    assert.ok(parsePropId(r.id), `id parses: ${r.id}`)
    assert.ok(!ids.has(r.id), `unique id ${r.id}`)
    ids.add(r.id)
    assert.ok(r.prob >= 0.02 && r.prob <= 0.97, `${r.id} prob ${r.prob}`)
    assert.ok(r.score >= 0 && r.score <= 100, `${r.id} score ${r.score}`)
    assert.ok(Number.isFinite(r.line))
    assert.ok(Math.abs(americanToProb(r.fair) - r.prob) < 0.02, `${r.id} fair ${r.fair} vs ${r.prob}`)
    assert.ok(r.windows.every((w) => w.hits <= w.n))
    if (r.kind === 'player') assert.ok(r.role >= 0 && r.role <= 1)
  }
})

test('home: tabs hold real starters, one card per player, upcoming games only', () => {
  const home = engine.views.home()
  assert.equal(home.counts.games, 14)
  assert.ok(home.tabs.apex.length >= 10)
  for (const [name, list] of Object.entries(home.tabs)) {
    const players = list.map((c) => c.playerId)
    assert.equal(new Set(players).size, players.length, `${name}: one card per player`)
    for (const c of list) {
      assert.equal(engine.wh.games.get(c.gameId).status.state, 'pre', `${name}: ${c.id} is upcoming`)
      if (name !== 'tds') assert.ok(c.role >= 0.6, `${name}: ${c.name} role ${c.role}`)
    }
  }
  for (const s of home.cheatsheets) assert.ok(s.rows.length <= 8)
  for (const p of home.parlays) {
    assert.equal(p.cards.length, p.legs.length)
    assert.equal(new Set(p.cards.map((c) => c.playerId)).size, p.cards.length, 'no player twice in a parlay')
  }
  assert.ok(JSON.stringify(home).length < 200_000, 'home payload stays small')
})

test('explorer: filters, sorting, paging', () => {
  const v = engine.views
  const all = v.props({ market: 'core' })
  assert.ok(all.total > 100)
  assert.ok(all.rows.length <= 40)
  const hit = v.props({ market: 'core', sort: 'hit', window: 'L10', minHit: 0.8 })
  for (const r of hit.rows) assert.ok(r.win.hits / r.win.n >= 0.8)
  const rb = v.props({ market: 'rushYds', pos: 'RB' })
  for (const r of rb.rows) assert.equal(r.market, 'rushYds')
  const unders = v.props({ side: 'u', limit: 100 })
  assert.ok(unders.rows.every((r) => r.side === 'u'))
  const page2 = v.props({ market: 'core', offset: 40 })
  assert.notEqual(page2.rows[0]?.id, all.rows[0]?.id)
  const name = v.props({ q: 'goff', market: 'all' })
  assert.ok(name.rows.length > 0 && name.rows.every((r) => /goff/i.test(r.name)))
  const capped = v.props({ limit: 5000 })
  assert.ok(capped.rows.length <= 100)
})

test('game, prop and player pages', () => {
  const v = engine.views
  const g = v.game('401873020')
  assert.ok(g.props.length > 20)
  for (let i = 1; i < g.props.length; i++) assert.ok(g.props[i - 1].rank >= g.props[i].rank, 'sorted by rank')
  assert.ok(g.home.trends.length > 0)
  const top = g.props[0]
  const pr = v.prop(top.id)
  assert.equal(pr.prop.id, top.id)
  assert.ok(pr.prop.windows.find((w) => w.key === 'L10'))
  const flip = v.prop(top.id.replace(/\.o\./, '.u.'))
  if (!top.oneSided) assert.ok(Math.abs(flip.prop.prob + pr.prop.prob - 1) < 0.08, 'over and under roughly sum to one')
  const alt = v.findProp(`${top.playerId}.${top.market}.${top.side}.${top.line + 10}`)
  if (alt && top.side === 'o') assert.ok(alt.prob <= pr.prop.prob + 1e-9, 'a higher over line is less likely')
  const pl = v.player(top.playerId)
  assert.ok(pl.props.length >= 1 && pl.log.rows.length >= 1)
  assert.equal(v.player('999999999'), null)
  assert.equal(v.game('123456789'), null)
  assert.equal(v.prop('1.passYds.o.250.5'), null)
})

test('search, defense vs position, rankings', () => {
  const v = engine.views
  const s = v.search('gibbs')
  assert.ok(s.players.some((p) => /Gibbs/.test(p.name)))
  assert.deepEqual(v.search('x'), { players: [], teams: [] })
  const d = v.dvp()
  for (const g of ['QB', 'RB', 'WR', 'TE']) assert.ok(Object.keys(d.groups[g]).length > 0, g)
  const r = v.rankings()
  assert.ok(r)
})

// ---- live tracking, simulated on a recorded pre-game ----------------------------------------

test('live tracker: on pace, behind, decided, then final results', async () => {
  const wh = engine.wh
  const v = engine.views
  const gameId = '401873020'
  const g0 = wh.games.get(gameId)
  const rows = v.game(gameId).props
  const qbRow = rows.find((r) => r.market === 'passYds')
  const recRow = rows.find((r) => r.market === 'recYds' && r.playerId !== qbRow?.playerId)
  assert.ok(qbRow && recRow, 'board has passing and receiving yards')
  const qbOver = `${qbRow.playerId}.passYds.o.${qbRow.line}`
  const qbUnder = `${qbRow.playerId}.passYds.u.${qbRow.line}`
  const recOver = `${recRow.playerId}.recYds.o.${recRow.line}`
  const aVersion = wh.aVersion

  // 3rd quarter, 7:30 left: 62.5% of the game played
  const sb = await engine.espn.scoreboard()
  const live = structuredClone(sb)
  const lg = live.games.find((g) => g.id === gameId)
  lg.status = { ...lg.status, state: 'in', completed: false, name: 'STATUS_IN_PROGRESS', detail: '7:30 - 3rd Quarter', short: '7:30 - 3rd', period: 3, clock: '7:30' }
  lg.home.score = 17
  lg.away.score = 13
  wh.setScoreboard(live, engine.now())
  const aAfterScoreboard = wh.aVersion
  const stats = {
    [qbRow.playerId]: { passYds: qbRow.line + 12, passAtt: 30, passCmp: 20 },
    [recRow.playerId]: { rec: 1, recYds: 6 },
  }
  const players = Object.fromEntries(Object.entries(stats).map(([id, s]) => [id, { id, name: wh.players.get(id)?.name || id, short: id, teamId: wh.players.get(id)?.teamId, stats: s }]))
  const pre = wh.summaries.get(gameId)?.data || {}
  wh.setSummary(gameId, { ...pre, status: lg.status, players }, engine.now())
  assert.ok(aAfterScoreboard > aVersion, 'kickoff (a state change) refreshes the analytics once')
  assert.equal(wh.aVersion, aAfterScoreboard, 'a live box score does not rebuild the prop analytics')

  const lv = v.live()
  const game = lv.games.find((x) => x.id === gameId)
  assert.ok(game && game.props.length > 10, 'the live game is listed with its props')
  const board = game.props.find((p) => p.id === qbRow.id)
  assert.equal(board.live.status, qbRow.side === 'o' ? 'hit' : 'miss', 'board row decided by the box score')
  const t = v.track([qbOver, qbUnder, recOver, 'nonsense'])
  assert.equal(t.legs[0].live.status, 'hit', 'over already cleared')
  assert.equal(t.legs[0].live.cur, qbRow.line + 12)
  assert.equal(t.legs[1].live.status, 'miss', 'under already lost')
  assert.ok(['behind', 'at_risk'].includes(t.legs[2].live.status), `receiving over is behind (${t.legs[2].live.status})`)
  assert.equal(t.legs[2].live.elapsed, 0.625)
  assert.equal(t.legs[3].missing, true)
  const diff1 = v.trackerDiff()
  assert.ok(diff1[qbRow.id], 'first diff has every tracked prop')
  assert.deepEqual(v.trackerDiff(), {}, 'nothing changed, nothing sent')

  // final: the receiver finishes under his line
  const fin = structuredClone(live)
  const fg = fin.games.find((g) => g.id === gameId)
  fg.status = { ...fg.status, state: 'post', completed: true, name: 'STATUS_FINAL', detail: 'Final', short: 'Final', period: 4, clock: '0:00' }
  wh.setScoreboard(fin, engine.now())
  wh.setSummary(gameId, { ...pre, status: fg.status, players }, engine.now())
  const done = v.track([qbOver, recOver])
  assert.equal(done.legs[0].live.status, 'hit')
  assert.equal(done.legs[0].live.final, true)
  assert.equal(done.legs[1].live.status, 'miss')
  const diff2 = v.trackerDiff()
  assert.ok(Object.keys(diff2).length > 0, 'going final is in the next diff')
  assert.equal(progressFor(done.legs[0], { status: { state: 'pre' } }, null), null)

  // put the slate back for the other tests
  wh.setScoreboard(sb, engine.now())
  wh.setSummary(gameId, pre, engine.now())
  assert.equal(wh.games.get(gameId).status.state, g0.status.state)
})

test('closing lines survive books pulling markets before kickoff', () => {
  const wh = engine.wh
  const id = '401873020'
  const before = wh.lines.get(id).props.length
  wh.setLines(id, [], engine.now())
  assert.equal(wh.lines.get(id).props.length, before, 'an empty reply keeps the board')
  const one = wh.lines.get(id).props.slice(0, 1)
  wh.setLines(id, one, engine.now(), { keepMissing: true })
  assert.equal(wh.lines.get(id).props.length, before, 'pulled markets stay in the last 45 minutes')
})

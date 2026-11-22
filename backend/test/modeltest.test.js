// The model test: graded props are rebuilt from what was known before each game, the model is
// asked for its own chance without seeing ours or the result, and both are scored the same way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/lib/store.js'
import { COLS } from '../src/nfl/proplog.js'
import { createModelTest, parseAnswer, scoreRun, brief, NS, BATCH } from '../src/modeltest/service.js'

const DAY = 86_400_000
const START = Date.parse('2026-10-20T23:00:00Z')
const PLAYERS = ['100', '101', '102', '103', '104', '105']

function row(o) {
  return COLS.map((k) => (k in o ? o[k] : null))
}

/** 30 graded NBA days, six players a night on points, with game logs that include the game itself. */
async function seed(store, { days = 30 } = {}) {
  const all = []
  const logs = {}
  for (const pid of PLAYERS) {
    // 15 games before the first prop day, then one game per prop day
    const rows = []
    for (let g = 0; g < 15; g++) rows.push({ eventId: `old${pid}${g}`, date: new Date(START - (15 - g) * 2 * DAY).toISOString(), season: 2027, home: g % 2 === 0, oppAbbr: 'BOS', s: { pts: 20 + (g % 7), min: 30 } })
    logs[pid] = rows
  }
  for (let d = 0; d < days; d++) {
    const ko = START + d * DAY
    const day = new Date(ko - 5 * 3600_000).toISOString().slice(0, 10)
    all.push(day)
    const doc = { v: 1, sport: 'nba', day, createdAt: ko - DAY, games: {}, pl: {}, rows: {}, done: true }
    PLAYERS.forEach((pid, j) => {
      const game = `9${d}${j}`
      doc.games[game] = { k: ko, n: 'NY @ BOS' }
      doc.pl[pid] = [`Player ${pid}`, 'NY', 'BOS', 'G']
      const p = 0.5 + ((d + j) % 5) * 0.06
      const won = (d + j) % 3 !== 0
      doc.rows[`${game}:${pid}:pts`] = row({ id: `${pid}.pts.o.22.5`, game, p, price: -110, best: -105, book: 'dk', edge: 0.02, home: j % 2, mu: 'h', res: won ? 'w' : 'l', val: won ? 30 : 10 })
      // each game joins the player's log once played; the last night's has a stat no prompt may show,
      // since no prop comes after it (a game is never among its own earlier games)
      logs[pid].push({ eventId: game, date: new Date(ko).toISOString(), season: 2027, home: true, oppAbbr: 'BOS', s: { pts: d === days - 1 ? 77.7 : 24, min: 30 } })
    })
    await store.set('proplog-nba', day, doc)
  }
  await store.set('proplog-nba', 'index', { all, open: [] })
  await store.set('nba', 'logteams', ['1'])
  await store.set('nba', 'logs:1', Object.fromEntries(PLAYERS.map((pid) => [pid, { rows: logs[pid], meta: {} }])))
}

function fakeAi({ answer = (i) => 0.55, fail = () => false } = {}) {
  const calls = []
  return {
    calls,
    ready: () => true,
    provider: () => 'openai',
    model: () => 'test-model',
    async complete({ system, messages, webSearch }) {
      calls.push({ system, text: messages[0].content, webSearch })
      if (fail(calls.length)) throw new Error('upstream 500 sk-abcdefghijklmnop')
      const n = (messages[0].content.match(/^\d+\. /gm) || []).length
      return { text: '```json\n' + JSON.stringify({ p: Array.from({ length: n }, (_, k) => ({ i: k + 1, p: answer(k) })) }) + '\n```', usage: { input_tokens: 100, output_tokens: 20 }, model: 'test-model' }
    },
  }
}

async function finish(t) {
  let v
  for (let k = 0; k < 50; k++) {
    v = await t.step()
    if (v.run.status !== 'running') break
  }
  return v
}

test('a run asks about every sampled prop without our chance, the result or the web, then scores it', async () => {
  const store = createStore({ driver: 'memory' })
  await seed(store)
  const ai = fakeAi()
  const t = createModelTest({ store, ai, leagues: ['nba', 'nhl'] })
  const started = await t.start({ size: 120 })
  assert.equal(started.run.status, 'running')
  assert.equal(started.run.size, 120)
  assert.equal(started.run.batches, 120 / BATCH)
  assert.deepEqual(started.run.leagues, { nba: 120 })

  const v = await finish(t)
  assert.equal(v.run.status, 'done')
  assert.equal(v.run.answered, 120)
  assert.equal(v.run.calls, 6)
  assert.deepEqual(v.run.tokens, { in: 600, out: 120 })
  assert.ok(v.run.results, 'scored')
  assert.equal(v.run.results.n, 120)

  for (const c of ai.calls) {
    assert.equal(c.webSearch, null, 'no web search')
    assert.ok(!/77\.7/.test(c.text), 'the game itself is not in the player\'s earlier games')
    assert.ok(!/0\.5[0-9]|0\.6[0-9]|0\.7[0-9]/.test(c.text), 'our chance is not in the prompt')
    assert.ok(!/\b(won|lost|hit it|missed)\b/i.test(c.text), 'no result words')
    assert.match(c.text, /Over 22\.5 Points/)
    assert.match(c.text, /Sportsbook price for this side: -110\./)
    assert.match(c.text, /The matchup favors this side\./)
  }
  // a second start while one runs is refused; a stopped run can be replaced
  await assert.rejects(t.start({ size: 60 }).then(() => t.start({ size: 60 })), (e) => e.code === 'running')
})

test('a failing batch is tried twice, then left out without holding up the run; keys never reach the record', async () => {
  const store = createStore({ driver: 'memory' })
  await seed(store)
  // three batches: the first fails twice (left out), the second once (answered on its retry)
  const ai = fakeAi({ fail: (n) => n === 1 || n === 2 || n === 4 })
  const t = createModelTest({ store, ai, leagues: ['nba'] })
  await t.start({ size: 60 })
  const v = await finish(t)
  assert.equal(v.run.status, 'done')
  assert.equal(v.run.answered, 40)
  assert.equal(v.run.calls, 5)
  assert.equal(v.run.errors.length, 3)
  for (const e of v.run.errors) assert.ok(!/sk-abcdef/.test(e.text), e.text)
})

test('stop keeps what was answered and scores it', async () => {
  const store = createStore({ driver: 'memory' })
  await seed(store)
  const t = createModelTest({ store, ai: fakeAi(), leagues: ['nba'] })
  await t.start({ size: 120 })
  await t.step()
  const v = await t.stop()
  assert.equal(v.run.status, 'stopped')
  assert.equal(v.run.answered, 60)
  assert.equal(v.run.results.n, 60)
  const after = await t.step()
  assert.equal(after.run.status, 'stopped', 'a stopped run takes no more steps')
})

test('no graded props, or no model key, is a plain refusal', async () => {
  const store = createStore({ driver: 'memory' })
  const t = createModelTest({ store, ai: fakeAi(), leagues: ['nba'] })
  await assert.rejects(t.start({ size: 60 }), (e) => e.code === 'no_data')
  const off = createModelTest({ store, ai: { ready: () => false, provider: () => null, model: () => null }, leagues: ['nba'] })
  await assert.rejects(off.start({ size: 60 }), (e) => e.code === 'no_model')
  assert.equal((await off.status()).run, null)
  assert.equal(await store.get(NS, 'run'), undefined)
})

test('the answer parser takes fences, percents and a bare list, and drops junk', () => {
  assert.deepEqual([...parseAnswer('```json\n{"p":[{"i":1,"p":0.62},{"i":2,"p":41}]}\n```', 2)], [[1, 0.62], [2, 0.41]])
  assert.deepEqual([...parseAnswer('[{"i":2,"p":0.3}]', 2)], [[2, 0.3]])
  assert.deepEqual([...parseAnswer('{"p":[{"i":3,"p":0.5},{"i":1,"p":"x"},{"i":2,"p":150}]}', 2)], [])
  assert.equal(parseAnswer('no json here', 3).size, 0)
  assert.deepEqual([...parseAnswer('{"p":[{"i":1,"p":0.999}]}', 1)], [[1, 0.99]])
})

test('the score: Brier, money at the logged price, and the verdict', () => {
  const two = [
    { lg: 'nba', p: 0.6, a: 0.7, y: 1, m: 0.5, o: -110 },
    { lg: 'nba', p: 0.6, a: 0.4, y: 0, m: 0.55, o: -120 },
  ]
  const s = scoreRun(two)
  assert.equal(s.n, 2)
  assert.equal(s.formula.brier, 0.26)
  assert.equal(s.model.brier, 0.125)
  assert.equal(s.money.formula.bets, 2)
  assert.equal(s.money.formula.units, -0.09)
  assert.equal(s.money.model.bets, 1)
  assert.equal(s.money.model.units, 0.91)
  assert.equal(s.closer.model, 2)
  assert.equal(s.verdict.winner, 'few')

  // the model 10 points better on every prop, over enough props for a verdict
  const many = Array.from({ length: 200 }, (_, i) => ({ lg: i % 2 ? 'nba' : 'nhl', p: 0.6, a: i % 4 === 0 ? 0.4 : 0.7, y: i % 4 === 0 ? 0 : 1, m: 0.55, o: -110 }))
  const w = scoreRun(many)
  assert.equal(w.verdict.winner, 'model')
  assert.match(w.verdict.text, /^OpenAI was closer than our formulas/)
  assert.equal(w.leagues.length, 2)
  // the same chances both ways: too close to call
  const same = many.map((r) => ({ ...r, a: r.p }))
  assert.equal(scoreRun(same).verdict.winner, 'tie')
  assert.equal(scoreRun([]), null)
})

test('a prop needs three earlier games for its stat', () => {
  const c = { lg: 'nba', pid: '1', market: 'pts', side: 'u', line: 20.5, game: 'g9', ko: Date.parse('2026-11-01T00:00:00Z'), name: 'A', team: 'NY', opp: 'BOS', pos: 'G', home: 0, mu: 'x', o: 120 }
  const logs = [0, 1].map((g) => ({ eventId: `e${g}`, date: '2026-10-2' + g + 'T00:00:00Z', season: 2027, s: { pts: 18, min: 30 } }))
  assert.equal(brief(c, logs, 1), null)
  logs.push({ eventId: 'e2', date: '2026-10-25T00:00:00Z', season: 2027, home: false, oppAbbr: 'BOS', s: { pts: 25, min: 30 } })
  const text = brief(c, logs, 1)
  assert.match(text, /^1\. A \(G, NY\) at BOS: Under 20\.5 Points/)
  assert.match(text, /Last 3 games, newest first: 25, 18, 18/)
  assert.match(text, /This side hit: last 5 2\/3/)
  assert.match(text, /The matchup works against this side\. Sportsbook price for this side: \+120\./)
})

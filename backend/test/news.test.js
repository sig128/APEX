// Lineup and injury news: the report as it stands, each change kept from when it was seen, and
// notes built from the numbers (his props, teammates' averages without him).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { fullEngine, clock } from './support.js'
import { createStore } from '../src/lib/store.js'
import { noteFor } from '../src/nfl/news.js'

let engine
after(() => engine?.stop())

test('notes: out, a downgrade, off the report', () => {
  const lifts = [{ short: 'J. Gibbs', stat: 'rushing yards', withoutAvg: 92.5, avg: 71.2, games: 4 }]
  assert.equal(noteFor({ player: { short: 'D. Montgomery' }, tag: 'out', detail: 'knee', own: [{}, {}], lifts }), 'D. Montgomery is out (knee). His props come off the board; books usually void bets on players who don’t play. Without him: J. Gibbs averaged 92.5 rushing yards in 4 games without him, against 71.2 overall.')
  assert.match(noteFor({ player: { short: 'X' }, tag: 'doubtful', from: 'questionable', own: [{}], lifts }), /^X is listed doubtful, down from questionable\. 1 of his props is on the board.*If he sits: J\. Gibbs averaged 92\.5/)
  assert.equal(noteFor({ player: { short: 'X' }, tag: null, from: 'out', lifts }), 'X is off the injury report (was out). Teammates’ bumps from his absences no longer apply.')
})

test('the feed: the report first, then each change as it happens; notes for members only', async () => {
  const now = clock()
  engine = await fullEngine({ now, store: createStore({ driver: 'memory' }) })
  const first = await engine.news.view({ member: true })
  assert.equal(first.changes.length, 0, 'the first look records the report, it isn’t news')
  assert.ok(first.report.every((x) => x.note && x.tag))
  // a starter with props goes on the report
  const row = engine.views.home().tabs.apex.find((c) => c.playerId && !c.inj)
  const p = engine.wh.players.get(String(row.playerId))
  engine.wh.injuries.set(p.teamId, [...(engine.wh.injuries.get(p.teamId) || []), { athleteId: p.id, status: 'Questionable', detail: 'Hamstring' }])
  now.add(60_000)
  engine.wh.bump('injuries')
  const second = await engine.news.view({ member: true })
  const ch = second.changes[0]
  assert.equal(ch.kind, 'change')
  assert.equal(ch.player.id, String(p.id))
  assert.equal(ch.tag, 'questionable')
  assert.match(ch.note, /is listed questionable \(Hamstring\)/)
  assert.ok(second.report.some((x) => x.id === String(p.id)))
  // a free viewer: the headline, no note
  const free = await engine.news.view({ member: false })
  assert.equal(free.locked, true)
  assert.ok(free.changes.length && free.changes.every((x) => x.note === null && x.player && x.tag !== undefined))
  // he's cleared
  engine.wh.injuries.set(p.teamId, (engine.wh.injuries.get(p.teamId) || []).filter((i) => i.athleteId !== p.id))
  now.add(60_000)
  engine.wh.bump('injuries')
  const third = await engine.news.view({ member: true })
  assert.equal(third.changes[0].tag, null)
  assert.match(third.changes[0].note, /off the injury report \(was questionable\)/)
})

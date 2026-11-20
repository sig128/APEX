// Live signals: flagged only on a real gap backed by usage, with enough game played and left;
// worded as candidates; graded from the final number.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signalFor, gradeSignal, usageKey } from '../src/nfl/signals.js'

const hist = (key, vals) => vals.map((v) => ({ s: { [key]: v } }))
const prop = (x) => ({ id: 'p.recYds.o.62.5', kind: 'player', name: 'Wade Smith', short: 'W. Smith', playerId: '7', gameId: '401', market: 'recYds', label: 'Over 62.5 Receiving Yards', line: 62.5, proj: 60, ...x })

test('a candidate needs the gap, the usage behind it, and the right part of the game', () => {
  assert.equal(usageKey('nfl', 'recYds'), 'rec')
  assert.equal(usageKey('nba', 'pts'), 'min')
  // second quarter: 48 yards on 5 catches, against a usual 4 a game
  const s = signalFor({ p: prop({ live: { cur: 48, elapsed: 0.4, final: false } }), box: { rec: 5, recYds: 48 }, history: hist('rec', [4, 4, 3, 5, 4]), sport: 'nfl', clockText: 'Q2 2:10' })
  assert.ok(s, 'flagged')
  assert.equal(s.side, 'o')
  assert.ok(s.projected > 62.5 * 1.15)
  assert.equal(s.usage.ratio, 3.13, '5 catches in 40% of the game against 4 a game')
  assert.match(s.note, /^W\. Smith over 62\.5 receiving yards, Q2 2:10: 48 so far, on pace for about \d+(\.\d)?\./)
  assert.match(s.note, /Signal: catches well above his usual\. A candidate against the pre-game line of 62\.5/)
  assert.ok(!/guarantee|bet this|lock/i.test(s.note))
  // same yards, usage at his normal pace: no candidate
  assert.equal(signalFor({ p: prop({ live: { cur: 48, elapsed: 0.4, final: false } }), box: { rec: 1.6 }, history: hist('rec', [4, 4, 4, 4]), sport: 'nfl' }), null)
  // too early, too late, or a small gap
  assert.equal(signalFor({ p: prop({ live: { cur: 20, elapsed: 0.1, final: false } }), box: { rec: 2 }, history: hist('rec', [4, 4, 4]), sport: 'nfl' }), null)
  assert.equal(signalFor({ p: prop({ live: { cur: 60, elapsed: 0.85, final: false } }), box: { rec: 6 }, history: hist('rec', [4, 4, 4]), sport: 'nfl' }), null)
  assert.equal(signalFor({ p: prop({ live: { cur: 26, elapsed: 0.4, final: false } }), box: { rec: 4 }, history: hist('rec', [4, 4, 4]), sport: 'nfl' }), null)
  // an under: minutes well down at halftime (foul trouble), points far behind
  const u = signalFor({ p: { id: 'c.pts.o.22.5', kind: 'player', name: 'C', short: 'C', playerId: '9', gameId: '5', market: 'pts', label: 'Over 22.5 Points', line: 22.5, proj: 23, live: { cur: 5, elapsed: 0.5, final: false } }, box: { min: 9, pts: 5 }, history: hist('min', [34, 33, 35, 32]), sport: 'nba' })
  assert.equal(u.side, 'u')
  assert.match(u.note, /minutes well below his usual/)
})

test('grading a candidate', () => {
  assert.equal(gradeSignal({ side: 'o', line: 62.5 }, 80), 'hit')
  assert.equal(gradeSignal({ side: 'o', line: 62.5 }, 50), 'miss')
  assert.equal(gradeSignal({ side: 'u', line: 22.5 }, 14), 'hit')
  assert.equal(gradeSignal({ side: 'u', line: 22 }, 22), 'push')
  assert.equal(gradeSignal({ side: 'u', line: 22 }, null), null)
})

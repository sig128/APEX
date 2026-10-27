// The read on a prop: the hit rate weighed against tonight's matchup. A 7-of-10 player who went
// 1 for 4 against defenses like tonight's gets told so; unders flip what helps and hurts; and
// every board row carries its bottom line and most telling reason.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { propNotes, tierOf } from '../src/nfl/analytics/notes.js'
import { fullEngine } from './support.js'

// eight defenses: four that allow few shots on goal (ranks 29-32 of 32), four that allow a lot
const cell = (rank) => ({ rank, of: 32, perGame: rank > 16 ? 9.5 : 14.5, trusted: true })
const dvp = { byDef: {}, league: { F: { sog: 12 } } }
for (const [id, rank] of [['t29', 29], ['t30', 30], ['t31', 31], ['t32', 32], ['s1', 1], ['s2', 2], ['s3', 3], ['s4', 4]]) dvp.byDef[id] = { F: { sog: cell(rank) } }
// 1 for 4 against the tough ones, 6 for 6 against the soft ones: 7 of 10 overall, and no trend
// (the first five and the last five average the same)
const games = [
  ['t29', 1], ['s1', 5], ['t30', 1], ['s2', 6], ['t31', 3], ['s3', 4], ['t32', 2], ['s4', 4], ['s1', 3], ['s2', 3],
].map(([oppId, v], i) => ({ oppId, v, eventId: `e${i}`, home: i % 2 === 0 }))
const matchup = { group: 'F', stat: 'sog', rank: 30, of: 32, perGame: 9.6, avg: 12.1, games: 8 }
const windows = [
  { key: 'L5', label: 'L5', hits: 4, n: 5 },
  { key: 'L10', label: 'L10', hits: 7, n: 10 },
  { key: 'h2h', label: 'vs CHI', hits: 0, n: 2 },
]
const base = { rows: games, line: 2.5, side: 'o', matchup, dvp, opp: { id: 't30', abbr: 'CHI' }, windows, statNoun: 'shots on goal', noun: 'shots on goal', groupName: 'forwards', short: 'E. Kane' }
const note = (out, key) => out.notes.find((n) => n.key === key)

test('a good hit rate built on easy matchups: the read says so', () => {
  assert.equal(tierOf(30, 32), 'tough')
  assert.equal(tierOf(2, 32), 'soft')
  assert.equal(tierOf(16, 32), 'mid')
  const out = propNotes({ ...base, proj: 2.4 })
  const split = note(out, 'split')
  assert.equal(split.tone, 'against')
  assert.equal(split.text, '7 of 10 lately, but only 1 of 4 against defenses that allow few shots on goal, like CHI.')
  assert.equal(out.notes[0].key, 'split', 'the most telling note comes first')
  const m = note(out, 'matchup')
  assert.equal(m.tone, 'against')
  assert.equal(m.text, 'CHI allows the 3rd-fewest shots on goal to forwards: 9.6 a game, against a league average of 12.1.')
  assert.equal(note(out, 'h2h').text, '0 of 2 against CHI in recent meetings.')
  assert.equal(note(out, 'h2h').tone, 'against')
  assert.equal(note(out, 'projection').text, 'APEX projects 2.4, 0.1 below the line.')
  assert.equal(note(out, 'projection').tone, 'info', 'a tenth off the line is no signal')
  assert.equal(out.read.lean, 'mixed', 'recent form still backs it')
  assert.equal(out.read.label, 'Mixed')
  assert.match(out.read.text, /^recent form favors it, the matchup and head to head don't\.$/)
})

test('unders flip what helps and hurts', () => {
  const out = propNotes({ ...base, side: 'u', windows: [{ key: 'L10', label: 'L10', hits: 3, n: 10 }], proj: 1.6 })
  assert.equal(note(out, 'matchup').tone, 'for', 'a stingy defense helps an under')
  assert.equal(note(out, 'projection').tone, 'for')
  assert.equal(note(out, 'projection').text, 'APEX projects 1.6, 0.9 below the line.')
  // against tough defenses the under hit 3 of 4
  assert.equal(note(out, 'split').tone, 'for')
  assert.match(note(out, 'split').text, /and 3 of 4 against defenses that allow few shots on goal, like CHI\./)
})

test('no notes from a matchup the data can not back yet, and plain grammar for one reason', () => {
  const thin = propNotes({ ...base, matchup: { ...matchup, games: 2 }, windows: [], proj: 4.1 })
  assert.equal(note(thin, 'split'), undefined)
  assert.equal(note(thin, 'matchup'), undefined)
  assert.equal(note(thin, 'projection').tone, 'for')
  assert.deepEqual(thin.read, { lean: 'for', label: 'Leans yes', text: 'the projection backs it.' })
  const soft = propNotes({ ...base, opp: { id: 's2', abbr: 'SJ' }, matchup: { ...matchup, rank: 2 }, proj: 4.4 })
  assert.equal(note(soft, 'matchup').text, 'SJ allows the 2nd-most shots on goal to forwards: 9.6 a game, against a league average of 12.1.')
  assert.equal(note(soft, 'split').text, '7 of 10 lately, and 6 of 6 against defenses that give up a lot of shots on goal, like SJ.')
  assert.equal(soft.read.label, 'Mixed', 'head to head still says no')
  const yes = propNotes({ ...base, opp: { id: 's2', abbr: 'SJ' }, matchup: { ...matchup, rank: 2 }, windows: windows.filter((w) => w.key !== 'h2h'), proj: 4.4 })
  assert.equal(yes.read.label, 'Lines up')
  assert.equal(yes.read.text, 'the matchup, the projection and recent form all back it.')
  const short = propNotes({ ...base, rows: games.slice(0, 4), windows: [], matchup: null, proj: null })
  assert.deepEqual(short.notes.map((n) => n.key), ['sample'])
  assert.equal(short.read.text, 'a thin sample works against it.')
})

let engine
after(() => engine?.stop())

test('every board row carries its bottom line and most telling reason; the prop page has them all', async () => {
  engine = await fullEngine()
  const rows = engine.views.props({ market: 'all', limit: 100 }).rows
  assert.ok(rows.filter((r) => r.note).length >= rows.length * 0.8, 'nearly every prop has a note')
  for (const r of rows.filter((x) => x.note).slice(0, 30)) {
    assert.ok(['for', 'against', 'info'].includes(r.note.tone))
    assert.ok(r.note.text.length > 10 && r.note.text.length < 200, r.note.text)
    assert.ok(!/undefined|NaN|null/.test(r.note.text), r.note.text)
    const full = engine.views.findProp(r.id)
    assert.deepEqual(full.notes[0], r.note, 'the list shows the first of the full read')
    for (const n of full.notes) assert.ok(!/undefined|NaN|null/.test(n.text), n.text)
    if (r.read) assert.ok(['for', 'against', 'mixed'].includes(r.read.lean) && r.read.label && r.read.text)
    // the pick card: the strongest reason each way
    assert.deepEqual(r.pro, full.notes.find((n) => n.tone === 'for') || null)
    assert.deepEqual(r.con, full.notes.find((n) => n.tone === 'against') || null)
  }
  assert.ok(rows.some((r) => engine.views.findProp(r.id).notes.some((n) => n.key === 'split')), 'splits against defenses like tonight’s show up on real data')
})

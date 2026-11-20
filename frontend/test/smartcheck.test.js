// Smart Check: the rules behind each note on a slip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { smartCheck, relation } from '../src/lib/smartcheck.js'

const leg = (x) => ({ sport: 'nfl', gameId: 'g1', teamAbbr: 'KC', side: 'o', prob: 0.6, price: -110, ...x })
const qb = leg({ id: 'qb', short: 'P. Mahomes', shortLabel: 'O 262.5 Pass Yds', market: 'passYds' })
const wr = leg({ id: 'wr', short: 'T. Kelce', shortLabel: 'O 64.5 Rec Yds', market: 'recYds' })

test('pairs: legs that move together, legs that work against each other, and unknown pairs', () => {
  assert.equal(relation(qb, wr), 1)
  assert.equal(relation(qb, { ...wr, gameId: 'g2' }), 0, 'different games')
  assert.equal(relation(qb, { ...wr, teamAbbr: 'BUF' }), 0, 'opponents: no claim')
  const together = smartCheck([qb, wr])
  assert.deepEqual(together.map((n) => n.type), ['together'])
  const against = smartCheck([qb, { ...wr, side: 'u', shortLabel: 'U 64.5 Rec Yds' }])
  assert.equal(against[0].type, 'conflict')
  assert.equal(against[0].level, 'caution')
  assert.match(against[0].text, /work against each other/)
})

test('leg count, the weakest leg, injuries, prices, thin samples, your record; types can be turned off', () => {
  const legs = [
    leg({ id: 'a', gameId: 'g1', prob: 0.7 }),
    leg({ id: 'b', gameId: 'g2', prob: 0.62 }),
    leg({ id: 'c', gameId: 'g3', prob: 0.51, short: 'J. Doe', shortLabel: 'O 4.5 Rec', inj: { tag: 'questionable', detail: 'ankle' }, n10: 3 }),
    leg({ id: 'd', gameId: 'g4', prob: 0.66, price: 105, book: 'fanduel', bookPrice: -110, bookName: 'draftkings', short: 'X', shortLabel: 'O 1.5' }),
  ]
  const notes = smartCheck(legs, { record: { byLegs: [{ key: '4+', label: '4+ leg parlays', w: 2, l: 14, units: -9.5, picks: 16, small: false }] } })
  const types = notes.map((n) => n.type)
  assert.deepEqual(types.slice(0, 3), ['injury', 'weak', 'legs'], 'strongest first: caution before info')
  const legsNote = notes.find((n) => n.type === 'legs')
  assert.match(legsNote.text, /All 4 legs together: about 15%.*best two alone: 46%.*best single leg: 70%/)
  const weak = notes.find((n) => n.type === 'weak')
  assert.match(weak.text, /J\. Doe O 4\.5 Rec at 51%\. Without it, the slip goes from about 15% to 29%/)
  assert.deepEqual(weak.action, { kind: 'remove', id: 'c', label: 'Take it off' })
  assert.match(notes.find((n) => n.type === 'injury').text, /listed questionable \(ankle\)/)
  assert.match(notes.find((n) => n.type === 'price').text, /FanDuel’s \+105, better than DraftKings’ -110/)
  assert.match(notes.find((n) => n.type === 'sample').text, /only 3 recent games/)
  assert.match(notes.find((n) => n.type === 'personal').text, /Your 4\+ leg parlays in the last 90 days: 2-14, -9\.5 units over 16 picks/)
  const quiet = smartCheck(legs, { off: ['legs', 'price', 'sample', 'personal'] })
  assert.deepEqual(quiet.map((n) => n.type), ['injury', 'weak'])
  const ruledOut = smartCheck([leg({ id: 'z', inj: { tag: 'out' } })])
  assert.equal(ruledOut[0].level, 'strong')
  assert.equal(smartCheck([], {}).length, 0)
})

// The math the slip and Kelly pages show people, checked without a browser: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kellyFraction, simulate, rng, edgeOf } from '../src/lib/kelly.js'
import { parlayMath, parseShare, shareUrl } from '../src/lib/slip.js'
import { pct, odds, parseOdds, decimalOf, americanOf, fairOf, clock } from '../src/lib/format.js'
import { transferData } from '../src/lib/wallet.js'
import { legRef, shareRef, splitRef, sp, slateLabel, leagueSwitchPath, isSharedPath, byLeague, legsSport } from '../src/lib/leagues.js'

test('odds helpers', () => {
  assert.equal(parseOdds('-110'), -110)
  assert.equal(parseOdds('+150'), 150)
  assert.equal(parseOdds('150'), 150)
  assert.equal(parseOdds(' -2500 '), -2500)
  assert.equal(parseOdds('99'), null)
  assert.equal(parseOdds('abc'), null)
  assert.equal(parseOdds(''), null)
  assert.equal(odds(120), '+120')
  assert.equal(odds(-120), '-120')
  assert.equal(pct(0.5612), '56%')
  assert.equal(pct(0.5612, 1), '56.1%')
  assert.ok(Math.abs(decimalOf(-110) - 1.909090909) < 1e-6)
  assert.equal(americanOf(2.5), 150)
  assert.equal(americanOf(1.5), -200)
  assert.equal(fairOf(0.5), 100)
  assert.equal(fairOf(0.75), -300)
})

test('game clock text', () => {
  assert.equal(clock({ state: 'post', short: 'Final' }), 'Final')
  assert.equal(clock({ state: 'in', period: 3, clock: '7:30' }), 'Q3 7:30')
  assert.equal(clock({ state: 'in', period: 5, clock: '4:00' }), 'OT 4:00')
  assert.equal(clock({ state: 'in', period: 2, halftime: true }), 'Halftime')
})

test('Kelly: no edge, no bet; the formula otherwise', () => {
  assert.equal(kellyFraction(0.5, 1.909), 0, 'a coin flip at -110 is a pass')
  assert.equal(kellyFraction(0.4, 2.5), 0, 'break-even is not an edge')
  const f = kellyFraction(0.55, 2)
  assert.ok(Math.abs(f - 0.1) < 1e-12, `(0.55*2-1)/(2-1) = 0.1, got ${f}`)
  assert.ok(Math.abs(edgeOf(0.55, 2) - 0.1) < 1e-12)
  assert.equal(kellyFraction(1.2, 2), 0, 'nonsense probabilities size nothing')
})

test('simulator: deterministic, sensible, and Kelly beats over-betting', () => {
  const a = simulate({ p: 0.56, d: 1.91, bets: 300, mult: 0.25, paths: 2000, seed: 3 })
  const b = simulate({ p: 0.56, d: 1.91, bets: 300, mult: 0.25, paths: 2000, seed: 3 })
  assert.deepEqual(a.bands.at(-1), b.bands.at(-1), 'same seed, same result')
  assert.ok(a.median > 1000, 'an edge grows the median bankroll')
  for (const band of a.bands) assert.ok(band.p5 <= band.p25 && band.p25 <= band.p50 && band.p50 <= band.p75 && band.p75 <= band.p95)
  const reckless = simulate({ p: 0.56, d: 1.91, bets: 300, mult: 4, maxStake: 1, paths: 2000, seed: 3 })
  assert.ok(reckless.broke > a.broke, 'four times Kelly goes broke more often')
  assert.ok(reckless.median < a.median, 'and grows less')
  const noEdge = simulate({ p: 0.5, d: 1.91, bets: 100, paths: 500 })
  assert.equal(noEdge.stake, 0)
  assert.equal(noEdge.median, 1000, 'nothing staked, nothing changes')
  const r = rng(9)
  const xs = Array.from({ length: 10000 }, r)
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  assert.ok(Math.abs(mean - 0.5) < 0.02 && xs.every((x) => x >= 0 && x < 1))
})

const legs = [
  { id: '1.rec.o.4.5', prob: 0.6, price: -110, gameId: 'g1' },
  { id: '2.rushYds.o.60.5', prob: 0.55, price: 120, gameId: 'g2' },
]

test('parlay math: multiplied probability, fair price, EV and Kelly at your price', () => {
  const m = parlayMath(legs, null)
  assert.ok(Math.abs(m.prob - 0.33) < 1e-9)
  assert.equal(m.fair, fairOf(0.33))
  const dec = decimalOf(-110) * decimalOf(120)
  assert.ok(Math.abs(m.bookDecimal - dec) < 1e-9)
  assert.ok(Math.abs(m.ev - (0.33 * dec - 1)) < 1e-9)
  assert.ok(m.kelly > 0)
  assert.equal(m.sameGame, false)
  const boosted = parlayMath(legs, 400)
  assert.equal(boosted.book, 400, 'a parlay price you type wins over the multiplied legs')
  const sgp = parlayMath([legs[0], { ...legs[1], gameId: 'g1' }], null)
  assert.equal(sgp.sameGame, true, 'same-game legs get flagged')
  const unpriced = parlayMath([{ ...legs[0], price: null }, legs[1]], null)
  assert.equal(unpriced.priced, false)
  assert.equal(unpriced.kelly, null)
})

test('share links round-trip legs and odds', () => {
  const url = shareUrl(legs)
  const q = new URL(url, 'https://apex.test').search
  const back = parseShare(q)
  assert.deepEqual(back.ids, legs.map((l) => l.id))
  assert.deepEqual(back.prices, { '1.rec.o.4.5': -110, '2.rushYds.o.60.5': 120 })
  assert.deepEqual(parseShare('?legs=').ids, [])
})

test('USDC transfer calldata', () => {
  const data = transferData('0x1111111111111111111111111111111111111111', '29004213')
  assert.equal(data.slice(0, 10), '0xa9059cbb')
  assert.equal(data.length, 10 + 64 + 64)
  assert.equal(BigInt(`0x${data.slice(-64)}`), 29004213n)
  assert.equal(`0x${data.slice(34, 74)}`, '0x1111111111111111111111111111111111111111')
  assert.throws(() => transferData('0x123', '1'))
  assert.throws(() => transferData('0x1111111111111111111111111111111111111111', '0'))
})

test('leagues: refs, links, slates and switching', () => {
  const nfl = { id: '1.rec.o.4.5', sport: 'nfl' }
  const nba = { id: '101.pts.o.27.5', sport: 'nba' }
  assert.equal(legRef(nfl), 'nfl:1.rec.o.4.5', 'the API always hears the league')
  assert.equal(legRef({ id: 'x' }), 'nfl:x', 'legs saved before leagues are NFL')
  assert.equal(shareRef(nfl), '1.rec.o.4.5', 'old links stay valid')
  assert.equal(shareRef(nba), 'nba:101.pts.o.27.5')
  assert.deepEqual(splitRef('nba:101.pts.o.27.5'), { sport: 'nba', id: '101.pts.o.27.5' })
  assert.deepEqual(splitRef('1.rec.o.4.5'), { sport: 'nfl', id: '1.rec.o.4.5' })
  assert.deepEqual(splitRef('zzz:1.rec.o.4.5'), { sport: 'nfl', id: 'zzz:1.rec.o.4.5' }, 'an unknown league is not a league')
  assert.equal(sp('nfl', ''), '/')
  assert.equal(sp('nba', ''), '/nba')
  assert.equal(sp('nba', '/props'), '/nba/props')
  assert.equal(slateLabel(8), 'Week 8')
  assert.equal(slateLabel('2026-10-25'), 'Sun, Oct 25')
  assert.equal(slateLabel('2026-10-25', 'tiny'), 'Oct 25')
  assert.equal(leagueSwitchPath('/nfl/props', 'nba'), '/nba/props', 'props stays props')
  assert.equal(leagueSwitchPath('/lock', 'nhl'), '/nhl/lock')
  assert.equal(leagueSwitchPath('/nba/game/401', 'nfl'), '/', 'a game page goes home')
  assert.equal(isSharedPath('/tools/sim'), true)
  assert.equal(isSharedPath('/nba/props'), false)
  assert.deepEqual([...byLeague([nfl, nba, { id: 'y', sport: 'nfl' }]).keys()], ['nfl', 'nba'])
  assert.equal(legsSport([nba, nfl]), 'nba')
})

test('a shared slip across leagues', () => {
  const legs = [
    { id: '1.rec.o.4.5', sport: 'nfl', price: -110, prob: 0.6 },
    { id: '101.pts.o.27.5', sport: 'nba', price: 120, prob: 0.5 },
  ]
  const q = new URL(shareUrl(legs), 'https://apex.test')
  assert.equal(q.pathname, '/slip')
  const back = parseShare(q.search)
  assert.deepEqual(back.refs, [{ sport: 'nfl', id: '1.rec.o.4.5' }, { sport: 'nba', id: '101.pts.o.27.5' }])
  assert.deepEqual(back.prices, { '1.rec.o.4.5': -110, 'nba:101.pts.o.27.5': 120 })
})


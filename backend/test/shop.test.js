import test from 'node:test'
import assert from 'node:assert/strict'
import { shop, legQuotes, parlayLink, linesIndex, otherLineQuotes } from '../src/nfl/shop.js'

const fd = (m, s) => `https://sportsbook.fanduel.com/addToBetslip?marketId=${m}&selectionId=${s}`
const row = (id, books, side = 'o') => ({ id, name: id, short: id, label: 'Over', side, prob: 0.7, price: { books } })

test('every book priced per leg, best first; the parlay priced at each book', () => {
  const a = row('a', { fanduel: { over: -110, links: { over: fd('1.1', 11) }, deep: { over: true } }, draftkings: { over: -120 }, betmgm: { over: 100 } })
  const b = row('b', { fanduel: { over: -105, links: { over: fd('2.2', 22) }, deep: { over: true } }, draftkings: { over: -115 } })
  assert.deepEqual(legQuotes(a).map((q) => q.book), ['betmgm', 'fanduel', 'draftkings'])
  const out = shop([a, b])
  assert.equal(out.best, 'fanduel', 'FanDuel has both legs at the better prices')
  const f = out.books[0]
  assert.equal(f.book, 'fanduel')
  assert.equal(f.complete, true)
  assert.ok(Math.abs(f.decimal - (1 + 100 / 110) * (1 + 100 / 105)) < 1e-3)
  assert.equal(f.allOnSlip, true)
  assert.equal(f.link, 'https://sportsbook.fanduel.com/addToBetslip?marketId[0]=1.1&selectionId[0]=11&marketId[1]=2.2&selectionId[1]=22')
  const dk = out.books.find((x) => x.book === 'draftkings')
  assert.equal(dk.complete, true)
  assert.equal(dk.link, 'https://sportsbook.draftkings.com/', 'no selection links: the book itself')
  const mgm = out.books.find((x) => x.book === 'betmgm')
  assert.equal(mgm.complete, false)
  assert.equal(mgm.priced, 1)
  const b365 = out.books.find((x) => x.book === 'bet365')
  assert.equal(b365.noFeed, true)
  assert.equal(b365.link, 'https://www.bet365.com/')
  assert.ok(out.spread > 0, 'how much better the best book pays than the worst')
  assert.equal(parlayLink('fanduel', [{ deep: true, link: fd('1', 1) }, { deep: false, link: 'https://sportsbook.fanduel.com/' }]), null)
})

test('a book on another number shows its own line and price, never as the best price', () => {
  // the slip: Over 225.5 passing yards and Over 4.5 catches (DraftKings' lines)
  const pass = { ...row('p', { draftkings: { over: -115 } }), kind: 'player', playerId: '1', market: 'passYds', line: 225.5 }
  const rec = { ...row('r', { draftkings: { over: -120 }, betmgm: { over: -125 } }), kind: 'player', playerId: '2', market: 'rec', line: 4.5 }
  const prices = new Map([
    ['1:passYds:225.5', { books: { draftkings: { over: -115, under: -105 } } }],
    // BetMGM and FanDuel hang 224.5; FanDuel also has 226.5 at a better price, but 224.5 is kinder to an over
    ['1:passYds:224.5', { books: { betmgm: { over: -118, under: -110, links: { over: 'https://sports.betmgm.com/x' }, deep: { over: true } }, fanduel: { over: -130, links: { over: fd('9.9', 99) }, deep: { over: true } } } }],
    ['1:passYds:226.5', { books: { fanduel: { over: -105 } } }],
    ['1:passYds:240.5', { books: { betrivers: { over: 150 } } }],
    ['2:rec:4.5', { books: { draftkings: { over: -120 }, betmgm: { over: -125 } } }],
    ['2:rec:5.5', { books: { fanduel: { over: 120, links: { over: fd('8.8', 88) }, deep: { over: true } } } }],
  ])
  const idx = linesIndex(prices)
  assert.equal(linesIndex(prices), idx, 'built once per map')
  const near = otherLineQuotes(pass, idx, new Set(['draftkings']))
  assert.deepEqual(near.map((q) => [q.book, q.line, q.price]).sort(), [['betmgm', 224.5, -118], ['betrivers', 240.5, 150], ['fanduel', 224.5, -130]])
  assert.deepEqual(otherLineQuotes({ ...pass, side: 'u', label: 'Under' }, idx, new Set()).find((q) => q.book === 'draftkings'), undefined, 'no other line at DraftKings')

  const out = shop([pass, rec], { lines: () => idx })
  assert.deepEqual(out.legs[0].other.map((q) => q.book).sort(), ['betmgm', 'betrivers', 'fanduel'])
  assert.equal(out.best, 'draftkings', 'the only book with the slip itself')
  const mgm = out.books.find((b) => b.book === 'betmgm')
  assert.equal(mgm.complete, false)
  assert.equal(mgm.covered, true, 'every leg at BetMGM: one at its own line')
  assert.deepEqual([mgm.priced, mgm.near], [1, 1])
  assert.deepEqual(mgm.lines, [224.5, null])
  assert.deepEqual(mgm.linePrices, [-118, null])
  assert.ok(Math.abs(mgm.altDecimal - (1 + 100 / 118) * (1 + 100 / 125)) < 1e-3)
  assert.equal(mgm.american, null, 'no price for the slip as it stands')
  const fdl = out.books.find((b) => b.book === 'fanduel')
  assert.equal(fdl.covered, true)
  assert.equal(fdl.allOnSlip, true, 'FanDuel still takes both selections at once, at its lines')
  assert.equal(fdl.link, 'https://sportsbook.fanduel.com/addToBetslip?marketId[0]=9.9&selectionId[0]=99&marketId[1]=8.8&selectionId[1]=88')
  const riv = out.books.find((b) => b.book === 'betrivers')
  assert.deepEqual([riv.covered, riv.near, riv.priced], [false, 1, 0], 'one leg at its line, the other not posted')
  assert.deepEqual(out.books.slice(0, 3).map((b) => b.book), ['draftkings', 'fanduel', 'betmgm'], 'the slip first, then whole slips at their lines, best paying first')
  // anytime TD sits at one line: nothing to offer at another
  assert.deepEqual(otherLineQuotes({ ...pass, oneSided: true, side: 'o', market: 'anyTd', line: 0.5 }, idx), [])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { shop, legQuotes, parlayLink } from '../src/nfl/shop.js'

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

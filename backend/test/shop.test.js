import test from 'node:test'
import assert from 'node:assert/strict'
import { shop, legQuotes, parlayLink, linesIndex, otherLineQuotes, cleanLink } from '../src/nfl/shop.js'
import { safeLink } from '../src/providers/oddsapi/props.js'

// links as the odds feed sends them (Nov 22, 2026), ids shortened
const DK = (id) => `https://sportsbook.draftkings.com/?outcomes=${id}`
const MGM = (o) => `https://sports.{state}.betmgm.com/en/sports?options=${o}&type=Single`
const CZR = (id) => `https://sportsbook.caesars.com/us/{state}/bet?selectionIds=${id}&dl=betslip`
const BR = (id) => `https://{state}.betrivers.com/?page=sportsbook#event/1028824836?coupon={pickType}|${id}|{wagerAmount}`

test('one link puts the whole parlay on the slip at DraftKings, BetMGM and Caesars too', () => {
  const q = (link) => ({ deep: true, link })
  assert.equal(parlayLink('draftkings', [q(DK('0QA1%232_13L88808Q1-3Q20')), q(DK('0QA4%235_13L88808Q1-6Q20'))]), 'https://sportsbook.draftkings.com/?outcomes=0QA1%232_13L88808Q1-3Q20+0QA4%235_13L88808Q1-6Q20', "ids joined by '+', each '#' kept as %23")
  assert.equal(parlayLink('betmgm', [q(MGM('6:44014-4597301-7577032')), q(MGM('6:44015-11-22'))]), 'https://sports.{state}.betmgm.com/en/sports?options=6:44014-4597301-7577032,6:44015-11-22&type=combo')
  assert.equal(parlayLink('williamhill_us', [q(CZR('b5bc9ee1')), q(CZR('c6cd0ff2'))]), 'https://sportsbook.caesars.com/us/{state}/bet?selectionIds=b5bc9ee1,c6cd0ff2&dl=betslip')
  const SCORE = (id, n, d) => `https://sportsbook.thescore.bet/?market_selection_id[0]=${id}&odds_numerator[0]=${n}&odds_denominator[0]=${d}`
  assert.equal(parlayLink('espnbet', [q(SCORE('45c4a13d', 2, 1)), q(SCORE('9f00e2aa', 5, 6))]), 'https://sportsbook.thescore.bet/?market_selection_id[0]=45c4a13d&odds_numerator[0]=2&odds_denominator[0]=1&market_selection_id[1]=9f00e2aa&odds_numerator[1]=5&odds_denominator[1]=6')
  // BetRivers has no several-selection link; a single gets its bet type and an open stake
  assert.equal(parlayLink('betrivers', [q(BR('4420456148'))]), 'https://{state}.betrivers.com/?page=sportsbook#event/1028824836?coupon=single|4420456148|')
  assert.equal(parlayLink('betrivers', [q(BR('1')), q(BR('2'))]), null)
  // a leg without its own selection link: no all-in-one link
  assert.equal(parlayLink('draftkings', [q(DK('a')), { deep: false, link: 'https://sportsbook.draftkings.com/' }]), null)
  // through shop(): DraftKings adds every leg in one tap
  const a = row('a', { draftkings: { over: -110, links: { over: DK('0QA1%232') }, deep: { over: true } } })
  const b = row('b', { draftkings: { over: -115, links: { over: DK('0QA3%234') }, deep: { over: true } } })
  const dk = shop([a, b]).books.find((x) => x.book === 'draftkings')
  assert.equal(dk.allOnSlip, true)
  assert.equal(dk.link, 'https://sportsbook.draftkings.com/?outcomes=0QA1%232+0QA3%234')
})

test("the feed's {state} placeholder survives, so the slip can fill in the bettor's state", () => {
  const raw = 'https://sportsbook.caesars.com/us/{state}/bet?selectionIds=b5bc9ee1&dl=betslip'
  assert.equal(safeLink(raw), raw, 'kept as written, not escaped to %7Bstate%7D')
  assert.equal(safeLink('https://evil.example.com/{state}'), null, 'only sportsbooks')
  // a snapshot saved before the fix holds it escaped: read back as {state}
  assert.equal(cleanLink('https://sportsbook.caesars.com/us/%7Bstate%7D/bet?selectionIds=x&dl=betslip'), raw.replace('b5bc9ee1', 'x'))
})

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

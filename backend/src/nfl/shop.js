// Line shopping: every sportsbook's price on a slip's legs, the parlay priced at each book, and
// links that open the book (with the selections on its bet slip where the book's links allow).
import { americanToDecimal, decimalToAmerican } from '../lib/odds.js'
import { round } from '../lib/util.js'

/** The books people bet with. bet365 has no US price feed, so it only gets a link. */
export const BOOK_INFO = {
  fanduel: { name: 'FanDuel', home: 'https://sportsbook.fanduel.com/' },
  draftkings: { name: 'DraftKings', home: 'https://sportsbook.draftkings.com/' },
  betmgm: { name: 'BetMGM', home: 'https://www.betmgm.com/' },
  bet365: { name: 'bet365', home: 'https://www.bet365.com/', noFeed: true },
  fanatics: { name: 'Fanatics', home: 'https://sportsbook.fanatics.com/' },
  betrivers: { name: 'BetRivers', home: 'https://www.betrivers.com/' },
  espnbet: { name: 'theScore Bet', home: 'https://thescore.bet/' },
  williamhill_us: { name: 'Caesars', home: 'https://sportsbook.caesars.com/' },
}
export const SHOP_ORDER = ['fanduel', 'draftkings', 'betmgm', 'bet365', 'fanatics', 'betrivers', 'espnbet', 'williamhill_us']

export const sideKey = (row) => (row.oneSided ? 'yes' : row.side === 'u' ? 'under' : 'over')

/** Every book's price for the side this leg bets, best first. */
export function legQuotes(row) {
  const side = sideKey(row)
  const out = []
  for (const [book, b] of Object.entries(row.price?.books || {})) {
    const price = b?.[side]
    if (!Number.isFinite(price) || Math.abs(price) < 100) continue
    out.push({ book, price, link: b.links?.[side] || null, deep: Boolean(b.deep?.[side]) })
  }
  return out.sort((a, b) => americanToDecimal(b.price) - americanToDecimal(a.price))
}

const FD_RE = /^https:\/\/sportsbook\.fanduel\.com\/addToBetslip\?marketId=([^&]+)&selectionId=([^&]+)$/

/**
 * One link that puts every leg on the book's slip, when its links allow it (FanDuel's bet slip
 * takes indexed selections). Other books get a link per leg: each tap adds one selection.
 */
export function parlayLink(book, quotes) {
  if (!quotes.length || quotes.some((q) => !q?.deep || !q.link)) return null
  if (quotes.length === 1) return quotes[0].link
  if (book === 'fanduel') {
    const parts = quotes.map((q) => FD_RE.exec(q.link))
    if (parts.some((m) => !m)) return null
    return `https://sportsbook.fanduel.com/addToBetslip?${parts.map((m, i) => `marketId[${i}]=${m[1]}&selectionId[${i}]=${m[2]}`).join('&')}`
  }
  return null
}

/** The slip at every book: price where all legs are posted, links either way. */
export function shop(rows) {
  const quotes = rows.map(legQuotes)
  const legs = rows.map((r, i) => ({ id: r.id, name: r.name, short: r.short, label: r.label, side: r.side, prob: r.prob, books: quotes[i] }))
  const books = SHOP_ORDER.map((book) => {
    const info = BOOK_INFO[book]
    const q = quotes.map((list) => list.find((x) => x.book === book) || null)
    const priced = q.filter(Boolean).length
    const complete = priced === rows.length && rows.length > 0
    const decimal = complete ? q.reduce((d, x) => d * americanToDecimal(x.price), 1) : null
    const combined = complete ? parlayLink(book, q) : null
    return {
      book,
      name: info.name,
      noFeed: Boolean(info.noFeed),
      priced,
      complete,
      decimal: decimal ? round(decimal, 4) : null,
      american: decimal ? decimalToAmerican(decimal) : null,
      prices: q.map((x) => x?.price ?? null),
      legLinks: q.map((x) => (x?.deep ? x.link : null)),
      link: combined || q.find((x) => x?.link)?.link || info.home,
      allOnSlip: Boolean(combined),
    }
  })
  const rank = (b) => (b.complete ? 3 : b.priced ? 2 : b.noFeed ? 0 : 1)
  books.sort((a, b) => rank(b) - rank(a) || (b.decimal ?? 0) - (a.decimal ?? 0) || b.priced - a.priced)
  const best = books.find((b) => b.complete) || null
  const worst = [...books].reverse().find((b) => b.complete) || null
  return { legs, books, best: best ? best.book : null, spread: best && worst && best !== worst ? round(best.decimal / worst.decimal - 1, 4) : null }
}

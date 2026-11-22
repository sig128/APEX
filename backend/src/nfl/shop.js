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

const subjectOf = (row) => (row.kind === 'team' ? `t${row.teamId}` : row.playerId)

const indexes = new WeakMap()
/**
 * The price map's lines per player (or team) and market, `${subject}:${market}` -> [[line,
 * entry]], built once per version of the map.
 */
export function linesIndex(priceMap) {
  if (!priceMap) return new Map()
  let idx = indexes.get(priceMap)
  if (idx) return idx
  idx = new Map()
  for (const [k, v] of priceMap) {
    const i = String(k).lastIndexOf(':')
    const line = Number(String(k).slice(i + 1))
    if (i < 0 || !Number.isFinite(line)) continue
    const head = String(k).slice(0, i)
    if (!idx.has(head)) idx.set(head, [])
    idx.get(head).push([line, v])
  }
  indexes.set(priceMap, idx)
  return idx
}

/**
 * The books that hang another number on this leg (224.5 passing yards where the slip has 225.5):
 * each one's price at its own line closest to the slip's, same side. A tie goes to the line
 * kinder to the bettor (lower for an over, higher for an under). `skip`: books that have the
 * exact line. One-sided markets (anytime TD) sit at one line, so they have no other.
 */
export function otherLineQuotes(row, index, skip = new Set()) {
  const side = sideKey(row)
  if (side === 'yes' || !index) return []
  const want = Number(row.line)
  const kinder = (a, b) => (side === 'over' ? a < b : a > b)
  const pick = new Map()
  for (const [line, entry] of index.get(`${subjectOf(row)}:${row.market}`) || []) {
    if (line === want) continue
    for (const [book, b] of Object.entries(entry?.books || {})) {
      if (skip.has(book)) continue
      const price = b?.[side]
      if (!Number.isFinite(price) || Math.abs(price) < 100) continue
      const cur = pick.get(book)
      const d = Math.abs(line - want)
      if (cur) {
        const dc = Math.abs(cur.line - want)
        if (dc < d || (dc === d && !kinder(line, cur.line))) continue
      }
      pick.set(book, { book, price, line, link: cleanLink(b.links?.[side]), deep: Boolean(b.deep?.[side]) })
    }
  }
  return [...pick.values()]
}

/**
 * A book's link ready to open, but for the state: the feed's links carry placeholders. {state}
 * stays (the slip fills in the bettor's state; an older snapshot may hold it escaped as
 * %7Bstate%7D); BetRivers' coupon wants a bet type and a stake: a single, no stake set.
 */
export function cleanLink(link) {
  if (!link) return null
  return String(link)
    .replace(/%7Bstate%7D/gi, '{state}')
    .replace(/\{pickType\}/g, 'single')
    .replace(/\{wagerAmount\}/g, '')
}

/** Every book's price for the side this leg bets, best first. */
export function legQuotes(row) {
  const side = sideKey(row)
  const out = []
  for (const [book, b] of Object.entries(row.price?.books || {})) {
    const price = b?.[side]
    if (!Number.isFinite(price) || Math.abs(price) < 100) continue
    out.push({ book, price, link: cleanLink(b.links?.[side]), deep: Boolean(b.deep?.[side]) })
  }
  return out.sort((a, b) => americanToDecimal(b.price) - americanToDecimal(a.price))
}

// The bet slip links of the books whose slips take several selections in one link, and how each
// joins them. The odds feed gives one link per selection; these put a whole parlay on the slip.
//   FanDuel:    addToBetslip?marketId[0]=…&selectionId[0]=…&marketId[1]=…  (indexed pairs)
//   DraftKings: ?outcomes=id1+id2  (each id as given, its '#' kept as %23)
//   BetMGM:     /en/sports?options=f-m-o,f-m-o&type=combo  (BetMGM's deep-link guide)
//   Caesars:    /us/{state}/bet?selectionIds=a,b&dl=betslip
//   theScore:   ?market_selection_id[0]=…&odds_numerator[0]=…&odds_denominator[0]=…, [1]…  (re-indexed)
// BetRivers (and anything else) has no several-selection form: a link per leg.
const FD_RE = /^https:\/\/sportsbook\.fanduel\.com\/addToBetslip\?marketId=([^&#]+)&selectionId=([^&#]+)$/
const DK_RE = /^https:\/\/sportsbook\.draftkings\.com\/[^?#]*\?outcomes=([^&#]+)$/
const MGM_RE = /^(https:\/\/sports\.[^/?#]+\.betmgm\.com\/en\/sports)\?options=([^&#]+)(?:&type=[A-Za-z]+)?$/
const CZR_RE = /^(https:\/\/sportsbook\.caesars\.com\/us\/[^/?#]+\/bet)\?selectionIds=([^&#]+)&dl=betslip$/
const I0 = '(?:\\[|%5B)0(?:\\]|%5D)'
const SCORE_RE = new RegExp(`^https://sportsbook\\.thescore\\.bet/\\?market_selection_id${I0}=([^&#]+)&odds_numerator${I0}=([^&#]+)&odds_denominator${I0}=([^&#]+)$`, 'i')

/**
 * One link that puts every leg on the book's slip, when the book's links allow it (see above).
 * Other books get a link per leg: each tap adds one selection.
 */
export function parlayLink(book, quotes) {
  if (!quotes.length || quotes.some((q) => !q?.deep || !q.link)) return null
  const links = quotes.map((q) => cleanLink(q.link))
  if (links.length === 1) return links[0]
  const all = (re) => {
    const parts = links.map((l) => re.exec(l))
    return parts.some((m) => !m) ? null : parts
  }
  if (book === 'fanduel') {
    const parts = all(FD_RE)
    return parts && `https://sportsbook.fanduel.com/addToBetslip?${parts.map((m, i) => `marketId[${i}]=${m[1]}&selectionId[${i}]=${m[2]}`).join('&')}`
  }
  if (book === 'draftkings') {
    const parts = all(DK_RE)
    return parts && `https://sportsbook.draftkings.com/?outcomes=${parts.map((m) => m[1]).join('+')}`
  }
  if (book === 'betmgm') {
    const parts = all(MGM_RE)
    if (!parts || parts.some((m) => m[1] !== parts[0][1])) return null
    return `${parts[0][1]}?options=${parts.map((m) => m[2]).join(',')}&type=combo`
  }
  if (book === 'williamhill_us') {
    const parts = all(CZR_RE)
    if (!parts || parts.some((m) => m[1] !== parts[0][1])) return null
    return `${parts[0][1]}?selectionIds=${parts.map((m) => m[2]).join(',')}&dl=betslip`
  }
  if (book === 'espnbet') {
    const parts = all(SCORE_RE)
    return parts && `https://sportsbook.thescore.bet/?${parts.map((m, i) => `market_selection_id[${i}]=${m[1]}&odds_numerator[${i}]=${m[2]}&odds_denominator[${i}]=${m[3]}`).join('&')}`
  }
  return null
}

/**
 * The slip at every book: the price where all legs are posted at the slip's lines, links either
 * way. `lines(row)` gives the price map's lines for a leg's player and market (see linesIndex):
 * with it, a book that hangs another number on a leg shows its own line and price there, and a
 * book with every leg at some line gets a parlay price "at its lines". Those never count as the
 * best price, which compares the same bet everywhere.
 */
export function shop(rows, { lines = null } = {}) {
  const quotes = rows.map(legQuotes)
  const others = rows.map((r, i) => (lines ? otherLineQuotes(r, lines(r), new Set(quotes[i].map((q) => q.book))) : []))
  const legs = rows.map((r, i) => ({ id: r.id, name: r.name, short: r.short, label: r.label, side: r.side, line: r.line, prob: r.prob, books: quotes[i], other: others[i] }))
  const books = SHOP_ORDER.map((book) => {
    const info = BOOK_INFO[book]
    const q = quotes.map((list) => list.find((x) => x.book === book) || null)
    const o = others.map((list, i) => (q[i] ? null : list.find((x) => x.book === book) || null))
    const priced = q.filter(Boolean).length
    const near = o.filter(Boolean).length
    const complete = priced === rows.length && rows.length > 0
    // every leg at some line, at least one of them the book's own
    const covered = !complete && near > 0 && priced + near === rows.length
    const decimal = complete ? q.reduce((d, x) => d * americanToDecimal(x.price), 1) : null
    const either = q.map((x, i) => x || o[i])
    const altDecimal = covered ? either.reduce((d, x) => d * americanToDecimal(x.price), 1) : null
    const combined = complete ? parlayLink(book, q) : covered ? parlayLink(book, either) : null
    return {
      book,
      name: info.name,
      noFeed: Boolean(info.noFeed),
      priced,
      near,
      complete,
      covered,
      decimal: decimal ? round(decimal, 4) : null,
      american: decimal ? decimalToAmerican(decimal) : null,
      altDecimal: altDecimal ? round(altDecimal, 4) : null,
      altAmerican: altDecimal ? decimalToAmerican(altDecimal) : null,
      prices: q.map((x) => x?.price ?? null),
      // where the book hangs another number: its line and its price there
      lines: o.map((x) => x?.line ?? null),
      linePrices: o.map((x) => x?.price ?? null),
      legLinks: either.map((x) => (x?.deep ? x.link : null)),
      link: combined || either.find((x) => x?.link)?.link || info.home,
      allOnSlip: Boolean(combined),
    }
  })
  const rank = (b) => (b.complete ? 4 : b.covered ? 3 : b.priced + b.near ? 2 : b.noFeed ? 0 : 1)
  books.sort((a, b) => rank(b) - rank(a) || (b.decimal ?? b.altDecimal ?? 0) - (a.decimal ?? a.altDecimal ?? 0) || b.priced + b.near - (a.priced + a.near))
  const best = books.find((b) => b.complete) || null
  const worst = [...books].reverse().find((b) => b.complete) || null
  return { legs, books, best: best ? best.book : null, spread: best && worst && best !== worst ? round(best.decimal / worst.decimal - 1, 4) : null }
}

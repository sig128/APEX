// Smart Check: notes on the whole slip, the moment a leg goes on. Rules first, so it answers
// instantly: legs that work against each other or tend to hit together, how many legs it takes,
// the weakest leg, injury news, prices, thin samples, and your own record at this many legs.
// Three levels: info, caution, strong. Nothing here blocks a pick.

export const LEVEL = { info: 0, caution: 1, strong: 2 }
export const TYPE_NAME = {
  injury: 'Injury news',
  conflict: 'Legs working against each other',
  together: 'Legs that tend to hit together',
  legs: 'How many legs',
  weak: 'The weakest leg',
  price: 'Prices',
  sample: 'Thin samples',
  personal: 'Your record',
}

const FB_PASS = new Set(['passYds', 'passCmp', 'passTd', 'passAtt', 'longPass'])
const FB_REC = new Set(['recYds', 'rec', 'longRec', 'rushRecYds'])
const FB_RUSH = new Set(['rushYds', 'rushAtt', 'longRush'])
const FB_TD = new Set(['anyTd', 'td2'])
const FOOTBALL = new Set(['nfl', 'ncaaf'])
const BASKETBALL = new Set(['nba', 'wnba', 'ncaab'])

/**
 * How two legs in the same game move: +1 together, -1 apart, 0 no known link. Only pairs where
 * the link is well known; everything else says nothing rather than guess.
 */
export function relation(a, b) {
  if (!a.gameId || a.gameId !== b.gameId || a.id === b.id) return 0
  const same = a.teamAbbr && a.teamAbbr === b.teamAbbr
  const pair = (x, y) => (x(a) && y(b)) || (x(b) && y(a))
  const m = (set) => (l) => set.has(l.market)
  if (FOOTBALL.has(a.sport) && FOOTBALL.has(b.sport)) {
    if (same && pair(m(FB_PASS), m(FB_REC))) return 1 // the QB's passing feeds his receivers
    if (same && pair((l) => l.market === 'passAtt', (l) => l.market === 'rushAtt')) return -1 // more passes, fewer runs
    if (same && pair((l) => l.market === 'teamPts', (l) => FB_TD.has(l.market) || FB_PASS.has(l.market))) return 1
    if (!same && pair((l) => l.market === 'teamPts', (l) => l.market === 'teamPts')) return 0
  }
  if (BASKETBALL.has(a.sport) && BASKETBALL.has(b.sport)) {
    if (same && pair((l) => l.market === 'ast', (l) => ['pts', 'threes', 'pa', 'pra'].includes(l.market))) return 1 // assists come from teammates' baskets
  }
  if (a.sport === 'nhl' && b.sport === 'nhl') {
    if (same && pair((l) => l.market === 'g', (l) => l.market === 'a')) return 1
  }
  return 0
}
const dir = (l) => (l.side === 'u' ? -1 : 1)
const who = (l) => `${l.short || l.name} ${l.shortLabel || l.label}`
const pct = (p) => `${Math.round(p * 100)}%`
const fmtOdds = (a) => (a > 0 ? `+${a}` : `${a}`)
const prod = (xs) => xs.reduce((p, x) => p * x, 1)
const BOOK = { fanduel: 'FanDuel', draftkings: 'DraftKings', betmgm: 'BetMGM', bet365: 'bet365', fanatics: 'Fanatics', betrivers: 'BetRivers', espnbet: 'theScore Bet', williamhill_us: 'Caesars', caesars: 'Caesars' }
const bookName = (k) => BOOK[String(k || '').toLowerCase()] || k
const owns = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`)

/**
 * The notes for a slip. legs: the slip's legs (with prob, price, inj, ...). record: your graded
 * history by leg count ({ byLegs: [...] }), when you have one. off: note types you've turned off.
 */
export function smartCheck(legs, { record = null, off = [] } = {}) {
  const out = []
  const add = (n) => {
    if (!off.includes(n.type)) out.push(n)
  }
  // injury news on a leg
  for (const l of legs) {
    const tag = l.inj?.tag || (typeof l.inj === 'string' ? l.inj : null)
    if (!tag || tag === 'probable' || tag === 'returning') continue
    const word = { out: 'ruled out', doubtful: 'doubtful', questionable: 'questionable', daytoday: 'day-to-day' }[tag] || tag
    add({ type: 'injury', level: tag === 'out' || tag === 'doubtful' ? 'strong' : 'caution', legs: [l.id], text: `${l.short || l.name} is listed ${word}${l.inj?.detail ? ` (${l.inj.detail})` : ''}. If he sits, books usually void his props; if he plays limited, the number can fall short.`, action: { kind: 'remove', id: l.id, label: `Take ${l.short || l.name} off` } })
  }
  // pairs in the same game
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]
      const b = legs[j]
      const r = relation(a, b)
      if (!r) continue
      if (r * dir(a) * dir(b) < 0) add({ type: 'conflict', level: 'caution', legs: [a.id, b.id], text: `${who(a)} and ${who(b)} work against each other: these usually rise and fall together, so this pair needs the game to go two ways at once. A bigger payout here reflects a lower real chance, not extra value. Consider swapping one.` })
      else add({ type: 'together', level: 'info', legs: [a.id, b.id], text: `${who(a)} and ${who(b)} tend to hit together. That makes the slip likelier than the multiplied chance, and books often shrink same-game payouts for exactly this.` })
    }
  }
  const probs = legs.map((l) => l.prob).filter((p) => p > 0 && p < 1)
  if (probs.length === legs.length && legs.length >= 3) {
    const sorted = [...probs].sort((a, b) => b - a)
    const all = prod(probs)
    add({ type: 'legs', level: all < 0.1 ? 'caution' : 'info', legs: [], text: `All ${legs.length} legs together: about ${pct(all)}, multiplied. The best two alone: ${pct(sorted[0] * sorted[1])}. The best single leg: ${pct(sorted[0])}. Each leg is one more thing that has to go right.` })
  }
  if (probs.length === legs.length && legs.length >= 2) {
    const all = prod(probs)
    const weakest = legs.reduce((w, l) => (l.prob < w.prob ? l : w), legs[0])
    const without = all / weakest.prob
    if (weakest.prob < 0.56 && without >= all * 1.6) add({ type: 'weak', level: 'caution', legs: [weakest.id], text: `The weakest leg is ${who(weakest)} at ${pct(weakest.prob)}. Without it, the slip goes from about ${pct(all)} to ${pct(without)}.`, action: { kind: 'remove', id: weakest.id, label: 'Take it off' } })
  }
  // prices: one note for legs with none yet, one for better prices found
  const unpriced = legs.filter((l) => l.price == null)
  if (unpriced.length) add({ type: 'price', level: 'info', legs: unpriced.map((l) => l.id), text: `No sportsbook price yet for ${unpriced.map(who).join(', ')}, so the slip can’t show what ${unpriced.length === 1 ? 'it pays' : 'they pay'}.` })
  const better = legs.filter((l) => l.price != null && l.book && l.bookPrice != null && l.price > l.bookPrice && l.bookName && l.book !== l.bookName)
  if (better.length) add({ type: 'price', level: 'info', legs: better.map((l) => l.id), text: better.length === 1 ? `${who(better[0])} is priced at ${owns(bookName(better[0].book))} ${fmtOdds(better[0].price)}, better than ${owns(bookName(better[0].bookName))} ${fmtOdds(better[0].bookPrice)}.` : `Better prices found: ${better.map((l) => `${l.short || l.name} at ${owns(bookName(l.book))} ${fmtOdds(l.price)} (not ${fmtOdds(l.bookPrice)})`).join('; ')}.` })
  // thin samples
  for (const l of legs) if (Number.isFinite(l.n10) && l.n10 > 0 && l.n10 < 5) add({ type: 'sample', level: 'info', legs: [l.id], text: `${who(l)} rests on only ${l.n10} recent games. Small samples swing a lot.` })
  // your own record at this many legs (only with enough of it to mean something)
  const bucket = legs.length >= 4 ? '4+' : String(legs.length)
  const mine = record?.byLegs?.find((x) => x.key === bucket)
  if (mine && !mine.small && legs.length >= 2) add({ type: 'personal', level: 'info', legs: [], text: `Your ${mine.label.toLowerCase()} in the last 90 days: ${mine.w}-${mine.l}, ${mine.units > 0 ? '+' : ''}${mine.units} units over ${mine.picks} picks.` })
  return out.sort((x, y) => LEVEL[y.level] - LEVEL[x.level])
}

// ---- turning a type off, and remembering what was shown ----------------------------------------
const OFF_KEY = 'apex_smartcheck_off'
export function offTypes() {
  try {
    const v = JSON.parse(localStorage.getItem(OFF_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => TYPE_NAME[x]) : []
  } catch {
    return []
  }
}
export function turnOff(type) {
  const next = [...new Set([...offTypes(), type])]
  try {
    localStorage.setItem(OFF_KEY, JSON.stringify(next))
  } catch {
    /* blocked: just for this visit */
  }
  return next
}
export function turnAllOn() {
  try {
    localStorage.removeItem(OFF_KEY)
  } catch {
    /* blocked */
  }
}

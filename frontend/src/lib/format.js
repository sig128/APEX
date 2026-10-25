// How numbers, odds and times read across the app.
export const pct = (p, digits = 0) => (Number.isFinite(p) ? `${(p * 100).toFixed(digits)}%` : '–')

export function odds(a) {
  if (!Number.isFinite(a)) return '–'
  return a > 0 ? `+${a}` : String(a)
}

export const ratio = (w) => (w && w.n ? `${w.hits}/${w.n}` : '–')
export const rate = (w) => (w && w.n ? w.hits / w.n : null)

export function num(x, digits = 1) {
  if (!Number.isFinite(x)) return '–'
  return Number.isInteger(x) ? String(x) : x.toFixed(digits)
}

export function units(u) {
  if (!Number.isFinite(u)) return '–'
  const s = Math.abs(u) >= 100 ? u.toFixed(0) : u.toFixed(2).replace(/\.00$/, '')
  return `${u > 0 ? '+' : ''}${s}u`
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** "Sun 4:25 PM" this week, "Oct 25" further out. */
export function kickoff(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const days = (t - Date.now()) / 86_400_000
  if (days > -1 && days < 6) return `${dayFmt.format(d)} ${timeFmt.format(d)}`
  return dateFmt.format(d)
}

export function shortDate(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? dateFmt.format(new Date(t)) : ''
}

export function ago(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

/** What the game clock shows: "Final", "Q3 7:30", "Halftime", or the kickoff time. */
export function clock(status, date) {
  if (!status) return kickoff(date)
  if (status.state === 'post') return status.short || 'Final'
  if (status.state === 'in') {
    if (status.halftime) return 'Halftime'
    const q = status.period > 4 ? 'OT' : `Q${status.period}`
    return `${q} ${status.clock || ''}`.trim()
  }
  return kickoff(date)
}

export const isLive = (g) => g?.status?.state === 'in'
export const isFinal = (g) => g?.status?.state === 'post'

/** Probability -> fair American price (matches the API's fair odds). */
export function fairOf(p) {
  if (!(p > 0 && p < 1)) return null
  return p > 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100)
}

export function decimalOf(american) {
  const n = Number(american)
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null
  return n > 0 ? 1 + n / 100 : 1 + 100 / -n
}

export function americanOf(decimal) {
  if (!(decimal > 1)) return null
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1))
}

/** "+150" / "-110" / "150" -> number, or null. */
export function parseOdds(s) {
  const m = /^\s*([+-]?)(\d{3,5})\s*$/.exec(String(s ?? ''))
  if (!m) return null
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1)
  return Math.abs(n) >= 100 ? n : null
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const BOOKS = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', espnbet: 'ESPN BET' }
/** "draftkings" -> "DraftKings"; names that are already readable pass through. */
export const bookName = (k) => (k ? BOOKS[k] || BOOKS[String(k).toLowerCase()] || k : '')

/** American odds -> the probability the price implies (vig included): -110 -> 0.5238. */
export function impliedOf(american) {
  const n = Number(american)
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100)
}

/** Two sides of one market -> the book's cut and each side's chance with the cut taken out. */
export function noVigOf(a, b) {
  const pa = impliedOf(a)
  const pb = impliedOf(b)
  if (pa == null || pb == null) return null
  const sum = pa + pb
  return { vig: sum - 1, a: pa / sum, b: pb / sum }
}

/** "What does -110 mean" in one sentence. */
export function oddsMeaning(american) {
  const n = Number(american)
  const p = impliedOf(n)
  if (p == null) return ''
  const pp = `${(p * 100).toFixed(1)}%`
  return n < 0 ? `${n}: risk $${-n} to win $100. The book is saying this happens ${pp} of the time.` : `+${n}: risk $100 to win $${n}. The book is saying this happens ${pp} of the time.`
}

// The leagues on Propify and where each one's pages and API live, with no React in it (the slip
// math and the tests use it). NFL keeps the root of the site ("/" is NFL Today); every other
// league lives under its key ("/nba", "/nba/props"). The hooks are in sport.js.

export const SPORTS = [
  { key: 'nfl', name: 'NFL', title: 'NFL', calendar: 'week', unit: 'Week' },
  { key: 'nba', name: 'NBA', title: 'NBA', calendar: 'day' },
  { key: 'mlb', name: 'MLB', title: 'MLB', calendar: 'day' },
  { key: 'nhl', name: 'NHL', title: 'NHL', calendar: 'day' },
  { key: 'ncaaf', name: 'NCAAF', title: 'College Football', calendar: 'week', unit: 'Week' },
  { key: 'ncaab', name: 'NCAAB', title: 'College Basketball', calendar: 'day' },
  { key: 'wnba', name: 'WNBA', title: 'WNBA', calendar: 'day' },
]
export const SPORT_KEYS = SPORTS.map((s) => s.key)
export const sportInfo = (key) => SPORTS.find((s) => s.key === key) || SPORTS[0]
export const isSport = (key) => SPORT_KEYS.includes(key)

// Pages that belong to no league (picks, tools, account, a shared slip).
export const SHARED_PATHS = /^\/(picks|u|me|kelly|tools|pricing|account|login|apex|admin|adminn|slip)(\/|$)/
export const isSharedPath = (pathname) => SHARED_PATHS.test(String(pathname || ''))

/** The same section in another league: props stays props, a game page goes to that league's home. */
export function leagueSwitchPath(pathname, key) {
  const m = /^\/(?:[a-z]+\/)?(props|live|lock|dvp)\/?$/.exec(String(pathname || ''))
  return sp(key, m ? `/${m[1]}` : '')
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** Daily leagues key their slate by date ("2026-10-25"); weekly ones by week number. */
export const isDaySlate = (slate) => DAY_RE.test(String(slate ?? ''))
/** "Sunday, October 25" (long), "Sun, Oct 25" (short), "Oct 25" (tiny). */
export function slateDay(slate, style = 'long') {
  const m = DAY_RE.exec(String(slate ?? ''))
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))
  const o = style === 'long' ? { weekday: 'long', month: 'long', day: 'numeric' } : style === 'short' ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' }
  return d.toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })
}
/** "Week 8" or "Sun, Oct 25". */
export const slateLabel = (slate, style = 'short') => (isDaySlate(slate) ? slateDay(slate, style) : slate != null && slate !== '' ? `Week ${slate}` : '')

/** ESPN names winter seasons by the year they end (NBA 2027 is 2026-27); show them the usual way. */
const SPANS = new Set(['nba', 'nhl', 'ncaab'])
export const seasonLabel = (sport, season) => (season && SPANS.has(sport) ? `${season - 1}-${String(season).slice(2)}` : season ? String(season) : '')

/** "/api/nba" */
export const apiOf = (sport) => `/api/${sport || 'nfl'}`
/** A page of a league: sp('nba', '/props') -> "/nba/props"; sp('nfl', '') -> "/". */
export function sp(sport, path = '') {
  const s = sport || 'nfl'
  if (!path || path === '/') return s === 'nfl' ? '/' : `/${s}`
  return `/${s}${path}`
}
/** Links for a card or leg, in its own league. */
export const propHref = (c) => sp(c?.sport, `/prop/${encodeURIComponent(c.id)}`)
export const playerHref = (c, id = c?.playerId) => sp(c?.sport, `/player/${id}`)
export const gameHref = (sport, id) => sp(sport, `/game/${id}`)

/** How a leg is named to the API: "<league>:<id>", so any league's endpoint can take it (a slip can mix leagues). */
export const legRef = (l) => `${l?.sport || 'nfl'}:${l?.id}`
/** The same in a share link, where NFL legs keep their bare id (older links stay valid). */
export const shareRef = (l) => (!l?.sport || l.sport === 'nfl' ? l.id : `${l.sport}:${l.id}`)
/** "nba:123.pts.o.24.5" -> { sport: 'nba', id: '123.pts.o.24.5' }; a bare id is NFL. */
export function splitRef(ref) {
  const s = String(ref || '')
  const i = s.indexOf(':')
  if (i > 0 && isSport(s.slice(0, i))) return { sport: s.slice(0, i), id: s.slice(i + 1) }
  return { sport: 'nfl', id: s }
}
/** The league whose API takes a request for these legs: the first leg's (any league's API takes the others). */
export const legsSport = (legs, fallback = 'nfl') => legs?.find((l) => l?.sport)?.sport || fallback
/** Legs grouped by league, keeping their order inside each league. */
export function byLeague(legs) {
  const out = new Map()
  for (const l of legs || []) {
    const k = l?.sport || 'nfl'
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(l)
  }
  return out
}

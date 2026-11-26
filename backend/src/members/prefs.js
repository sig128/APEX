// What a member sets up after signing up: the leagues they follow (the first is where the app
// opens), how odds read, where they bet, their sportsbooks, and when they finished the setup.
// Kept per account, so the website and the iPhone app show the same.
import { ApiError } from '../lib/router.js'
import { SPORT_KEYS } from '../sports/index.js'

export const PREF_ODDS = ['american', 'decimal']
// the books we have prices for (the slip's grid and the line shop)
export const PREF_BOOKS = ['fanduel', 'draftkings', 'betmgm', 'williamhill_us', 'bet365', 'fanatics', 'betrivers', 'espnbet']
export const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
export const CA_PROVINCES = 'AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' ')

/** "US-NY", "CA-ON", or "other" (outside the US and Canada). */
export function okRegion(r) {
  if (r === 'other') return true
  const m = /^(US|CA)-([A-Z]{2})$/.exec(String(r || ''))
  return Boolean(m && (m[1] === 'US' ? US_STATES : CA_PROVINCES).includes(m[2]))
}

const bad = (msg) => new ApiError(400, 'bad_prefs', msg)

/** The fields sent, checked; leaves out what wasn't sent, so a step can save just its answer. */
export function cleanPrefs(p = {}) {
  const out = {}
  if (p.leagues !== undefined) {
    if (!Array.isArray(p.leagues)) throw bad('Pick your leagues from the list.')
    const keys = [...new Set(p.leagues.map(String))]
    if (keys.some((k) => !SPORT_KEYS.includes(k))) throw bad('One of those leagues isn’t on PropPickz.')
    out.leagues = keys
  }
  if (p.odds !== undefined) {
    if (!PREF_ODDS.includes(p.odds)) throw bad('Odds read American or decimal.')
    out.odds = p.odds
  }
  if (p.region !== undefined) {
    if (p.region !== null && !okRegion(p.region)) throw bad('Pick where you bet from the list.')
    out.region = p.region
  }
  if (p.books !== undefined) {
    if (!Array.isArray(p.books)) throw bad('Pick your sportsbooks from the list.')
    const keys = [...new Set(p.books.map(String))]
    if (keys.some((k) => !PREF_BOOKS.includes(k))) throw bad('One of those sportsbooks isn’t on the list.')
    out.books = keys
  }
  return out
}

export function createPrefs({ store, ns = 'members', now = () => Date.now() }) {
  const key = (uid) => `prefs-u-${uid}`
  const shape = (doc) => ({
    leagues: doc?.leagues || [],
    odds: doc?.odds || 'american',
    region: doc?.region ?? null,
    books: doc?.books || [],
    onboarded: doc?.onboarded || null,
    at: doc?.at || null,
  })

  async function get(uid) {
    return shape(uid ? await store.get(ns, key(uid)) : null)
  }

  /** Saves what was sent over what's there; `done` marks the setup finished (the first time counts). */
  async function set(uid, body = {}) {
    if (!uid) throw new ApiError(401, 'sign_in', 'Sign in to save your setup.')
    const next = cleanPrefs(body)
    const t = now()
    let saved = null
    await store.update(ns, key(uid), (cur) => {
      const doc = { ...(cur || {}), ...next, at: t }
      if (body.done === true && !doc.onboarded) doc.onboarded = t
      saved = doc
      return doc
    })
    return shape(saved)
  }

  async function erase(uid) {
    if (uid) await store.del(ns, key(uid)).catch(() => null)
  }

  return { get, set, erase }
}

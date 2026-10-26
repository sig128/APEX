// The Odds API keys, in the order they're spent: THE_ODDS_API_KEY (it may list several,
// comma-separated), then THE_ODDS_API_KEY_BACKUP. When the API refuses a key (a bad or
// cancelled key, or its monthly credits are used up) that key is set aside for a few hours and
// the next one answers the same request. A set-aside key gets tried again later on its own, so a
// paid plan that renews takes over from the backup again. Keys never go into logs or responses,
// only their position ("key 1 of 2").
import { log } from '../../lib/log.js'

const REFUSED = new Set(['MISSING_KEY', 'INVALID_KEY', 'DEACTIVATED_KEY', 'OUT_OF_USAGE_CREDITS'])
const BENCH_MS = 6 * 3600e3

/** Keys from strings that may each hold several (comma or space separated), first ones first, no repeats. */
export function splitKeys(input) {
  const out = []
  for (const part of Array.isArray(input) ? input : [input]) {
    for (const k of String(part ?? '').split(/[\s,]+/)) if (k && !out.includes(k)) out.push(k)
  }
  return out
}

/** Every key the environment names: THE_ODDS_API_KEY, then THE_ODDS_API_KEY_BACKUP. */
export function oddsKeys(env = process.env) {
  return splitKeys([env.THE_ODDS_API_KEY, env.THE_ODDS_API_KEY_BACKUP])
}

/** The API's error code from a failed response body (`{"error_code": "INVALID_KEY", ...}`), if any. */
export function oddsErrorCode(body) {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text.startsWith('{')) return ''
  try {
    const code = JSON.parse(text)?.error_code
    return typeof code === 'string' && /^[A-Z_]{2,64}$/.test(code) ? code : ''
  } catch {
    return ''
  }
}

/** Did The Odds API turn down the key itself, rather than this particular request? */
export function keyRefused(err) {
  if (!err || typeof err !== 'object') return false
  const code = err.upstreamCode || ''
  if (code) return REFUSED.has(code)
  const status = err.upstreamStatus ?? err.status
  return status === 401 || status === 403
}

/** The error for a failed Odds API response, carrying what keyRefused needs. */
export function oddsFailure(message, status, body) {
  return Object.assign(new Error(message), { upstreamStatus: status, upstreamCode: oddsErrorCode(body) })
}

export function createKeyRing(input, { now = () => Date.now(), benchMs = BENCH_MS } = {}) {
  const list = splitKeys(input)
  const asideUntil = new Map() // key -> time it gets tried again
  const usable = () => list.filter((k) => !(asideUntil.get(k) > now()))
  const ring = {
    size: list.length,
    /** The key a call would use now; null when there are none. */
    current: () => usable()[0] ?? list[0] ?? null,
    /**
     * fn(key) with the first usable key; when the API refuses that key, it's set aside and fn
     * runs again with the next. Any other failure goes straight back to the caller.
     */
    async run(fn) {
      const order = usable()
      // every key set aside: ask with the first one again rather than not at all
      if (!order.length && list.length) order.push(list[0])
      let last = null
      for (const key of order) {
        try {
          return await fn(key)
        } catch (e) {
          if (!keyRefused(e)) throw e
          last = e
          asideUntil.set(key, now() + benchMs)
          const next = order[order.indexOf(key) + 1]
          log.warn(next ? 'odds api refused a key, using the next one' : 'odds api refused every key', { key: list.indexOf(key) + 1, of: list.length, reason: e.upstreamCode || e.upstreamStatus || e.status || null })
        }
      }
      throw last || new Error('No Odds API key is set.')
    },
    status() {
      const cur = ring.current()
      return { keys: list.length, using: cur ? list.indexOf(cur) + 1 : 0, setAside: list.filter((k) => asideUntil.get(k) > now()).length }
    },
  }
  return ring
}

// One ring per set of keys for the whole instance: every league's board and the older odds
// endpoints share it, so a key refused once is set aside for all of them.
const rings = new Map()
export function keyRing(input) {
  const id = splitKeys(input).join(',')
  let ring = rings.get(id)
  if (!ring) {
    ring = createKeyRing(input)
    rings.set(id, ring)
  }
  return ring
}

/** For tests: forget which keys were set aside. */
export function _resetKeyRings() {
  rings.clear()
}

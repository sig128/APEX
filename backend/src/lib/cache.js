// In-memory cache with TTL, stale-while-revalidate and single-flight loading.
import { log, errText } from './log.js'

export function createCache({ max = 4000 } = {}) {
  const map = new Map() // key -> { value, freshUntil, staleUntil }
  const flights = new Map()

  function evict() {
    while (map.size > max) map.delete(map.keys().next().value)
  }

  function get(key) {
    const e = map.get(key)
    if (!e) return undefined
    if (Date.now() > e.staleUntil) {
      map.delete(key)
      return undefined
    }
    return e.value
  }

  function set(key, value, ttlMs, staleMs = 0) {
    const now = Date.now()
    map.delete(key)
    map.set(key, { value, freshUntil: now + ttlMs, staleUntil: now + ttlMs + staleMs })
    evict()
    return value
  }

  function load(key, ttlMs, staleMs, fn) {
    let f = flights.get(key)
    if (!f) {
      f = (async () => {
        try {
          const v = await fn()
          set(key, v, ttlMs, staleMs)
          return v
        } finally {
          flights.delete(key)
        }
      })()
      flights.set(key, f)
    }
    return f
  }

  /** Fresh value -> return it. Stale -> return it and refresh in the background. Missing -> load. */
  async function wrap(key, { ttlMs, staleMs = 0 }, fn) {
    const e = map.get(key)
    const now = Date.now()
    if (e && now <= e.freshUntil) return e.value
    if (e && now <= e.staleUntil) {
      load(key, ttlMs, staleMs, fn).catch((err) => log.warn('background refresh failed', { key, err: errText(err) }))
      return e.value
    }
    try {
      return await load(key, ttlMs, staleMs, fn)
    } catch (err) {
      if (e) return e.value // expired but better than nothing
      throw err
    }
  }

  return {
    get,
    set,
    wrap,
    has: (k) => get(k) !== undefined,
    del: (k) => map.delete(k),
    clear: () => map.clear(),
    get size() {
      return map.size
    },
  }
}

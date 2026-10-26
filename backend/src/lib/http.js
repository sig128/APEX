// Outbound JSON fetching: timeouts, retries with backoff, a per-host circuit breaker and a
// per-host priority queue so live-game refreshes never wait behind background backfills.
import { log } from './log.js'
import { sleep } from './util.js'

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', code = 'http' } = {}) {
    super(message)
    this.status = status
    this.url = url
    this.code = code
  }
}

const PRIORITY = { live: 0, user: 1, normal: 2, background: 3 }

function errorCodeOf(text) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('{')) return ''
  try {
    const code = JSON.parse(text)?.error_code
    return typeof code === 'string' && /^[A-Z_]{2,64}$/.test(code) ? code : ''
  } catch {
    return ''
  }
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}

export function createHttp({ transport, defaultTimeoutMs = 9000, maxPerHost = 6, breakerFailures = 6, breakerCooldownMs = 30_000 } = {}) {
  const doFetch = transport || globalThis.fetch
  const hosts = new Map()
  const counters = { requests: 0, failures: 0, retries: 0, circuitOpen: 0 }

  function hostState(h) {
    let s = hosts.get(h)
    if (!s) {
      s = { active: 0, queue: [], fails: 0, openUntil: 0 }
      hosts.set(h, s)
    }
    return s
  }

  function acquire(s, priority) {
    if (s.active < maxPerHost) {
      s.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const p = PRIORITY[priority] ?? PRIORITY.normal
      const item = { p, resolve }
      const i = s.queue.findIndex((q) => q.p > p)
      if (i < 0) s.queue.push(item)
      else s.queue.splice(i, 0, item)
    })
  }

  function release(s) {
    const next = s.queue.shift()
    if (next) next.resolve()
    else s.active--
  }

  async function once(url, { timeoutMs, headers, signal }) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
    const onAbort = () => ctrl.abort(signal.reason)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await doFetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctrl.signal })
      if (!res.ok) {
        const retryAfter = Number(res.headers?.get?.('retry-after')) || 0
        // an API that says why (`{"error_code": "..."}`) lets the caller tell a refused key from a bad request
        let upstreamCode = ''
        try {
          upstreamCode = errorCodeOf(await res.text())
        } catch {
          /* no readable body */
        }
        throw Object.assign(new HttpError(`HTTP ${res.status}`, { status: res.status, url }), { retryAfter, upstreamCode })
      }
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new HttpError('Bad JSON', { status: res.status, url, code: 'bad_json' })
      }
    } catch (e) {
      if (e instanceof HttpError) throw e
      const timedOut = ctrl.signal.aborted && !signal?.aborted
      throw new HttpError(timedOut ? 'Timed out' : e?.message || 'Network error', { url, code: timedOut ? 'timeout' : 'network' })
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  async function getJson(url, { timeoutMs = defaultTimeoutMs, retries = 2, priority = 'normal', headers, signal } = {}) {
    const h = hostOf(url)
    const s = hostState(h)
    if (s.openUntil > Date.now()) {
      counters.circuitOpen++
      throw new HttpError(`Upstream ${h} is cooling down`, { url, code: 'circuit_open' })
    }
    await acquire(s, priority)
    try {
      let attempt = 0
      for (;;) {
        counters.requests++
        try {
          const json = await once(url, { timeoutMs, headers, signal })
          s.fails = 0
          return json
        } catch (e) {
          const retryable = e.code === 'timeout' || e.code === 'network' || e.status === 429 || e.status >= 500
          if (!retryable || attempt >= retries || signal?.aborted) {
            if (retryable) {
              s.fails++
              counters.failures++
              if (s.fails >= breakerFailures) {
                s.openUntil = Date.now() + breakerCooldownMs
                s.fails = 0
                log.warn('circuit open', { host: h, cooldownMs: breakerCooldownMs })
              }
            }
            throw e
          }
          attempt++
          counters.retries++
          const wait = Math.min(3000, e.retryAfter ? e.retryAfter * 1000 : 300 * 3 ** (attempt - 1)) + Math.random() * 150
          await sleep(wait)
        }
      }
    } finally {
      release(s)
    }
  }

  return {
    getJson,
    stats: () => ({ ...counters, hosts: Object.fromEntries([...hosts].map(([k, v]) => [k, { active: v.active, queued: v.queue.length, open: v.openUntil > Date.now() }])) }),
  }
}

/** Same key the fixture recorder uses: host + path + sorted query, ignoring lang/region. */
export function fixtureKey(url) {
  const x = new URL(url.replace(/^http:\/\//, 'https://'))
  const q = [...x.searchParams.entries()].filter(([k]) => k !== 'lang' && k !== 'region').sort(([a], [b]) => a.localeCompare(b))
  return x.host + x.pathname + (q.length ? `?${q.map(([k, v]) => `${k}=${v}`).join('&')}` : '')
}

/** A fetch() stand-in that answers from recorded fixtures (tests, offline dev). */
export function createFixtureTransport(fixtures, { onMiss } = {}) {
  const misses = new Set()
  const fn = async (url) => {
    const k = fixtureKey(url)
    const hit = Object.prototype.hasOwnProperty.call(fixtures, k) ? fixtures[k] : undefined
    if (hit === undefined) {
      misses.add(k)
      if (onMiss) onMiss(k)
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{"error":"no fixture"}' }
    }
    const body = JSON.stringify(hit)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) }
  }
  fn.misses = misses
  return fn
}

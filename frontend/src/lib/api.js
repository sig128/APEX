// fetch() for the APEX API: JSON in and out, the signed-in user's token attached, errors that
// carry the server's code (signin, upgrade, quota...) so screens can react to them.
import { DATA_BASE } from './config.js'

let tokenGetter = null
/** AuthContext registers how to get a Firebase ID token (force = skip the SDK's cache). */
export function setTokenGetter(fn) {
  tokenGetter = fn
}

export async function authHeaders(force = false) {
  if (!tokenGetter) return {}
  try {
    const t = await tokenGetter(force)
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch {
    return {}
  }
}

export class ApiError extends Error {
  constructor(status, body, fallback) {
    super(body?.error || fallback || `Request failed (${status})`)
    this.status = status
    this.code = body?.code || (status === 0 ? 'network' : null)
    this.body = body || {}
  }
}

/**
 * api('/api/nfl/home'), api('/api/picks', { method: 'POST', body: {...} }).
 * A 401 with a stale token is retried once with a fresh one.
 */
export async function api(path, { method = 'GET', body, signal, base = DATA_BASE, headers = {}, auth = true, raw = false } = {}) {
  const url = `${base}${path}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const h = { Accept: 'application/json', ...headers, ...(auth ? await authHeaders(attempt > 0) : {}) }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal })
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      throw new ApiError(0, null, 'Could not reach APEX. Check your connection.')
    }
    if (raw && res.ok) return res
    let data = null
    const text = await res.text()
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (res.ok) return data
    if (res.status === 401 && data?.code === 'bad_token' && attempt === 0 && auth) continue
    const err = new ApiError(res.status, data)
    const ra = Number(res.headers.get('retry-after'))
    if (ra) err.retryAfter = ra
    throw err
  }
  throw new ApiError(401, { code: 'signin', error: 'Sign in again.' })
}

/** POST that streams NDJSON events back: onEvent({type, ...}) for each line. */
export async function streamNdjson(url, body, { onEvent, signal } = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...(await authHeaders()) }, body: JSON.stringify(body), signal })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    const err = new ApiError(res.status, data)
    err.usage = res.headers.get('x-apex-usage')
    throw err
  }
  const usage = res.headers.get('x-apex-usage')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let last = null
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        last = JSON.parse(line)
      } catch {
        continue
      }
      onEvent?.(last)
    }
    if (done) break
  }
  if (buf.trim()) {
    try {
      last = JSON.parse(buf)
      onEvent?.(last)
    } catch {
      /* partial line */
    }
  }
  return { last, usage }
}

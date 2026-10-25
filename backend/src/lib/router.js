// A small route table for the JSON API: pattern matching, ETags, cache headers, and errors that
// never crash the process.
import { hash } from './util.js'
import { log, errText } from './log.js'

export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message || code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export const RAW = Symbol('raw')

function compile(pattern) {
  const keys = []
  const re = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { re: new RegExp(`^${re}/?$`), keys }
}

/**
 * The caller's IP. Behind Google's front end (or APEX_TRUST_PROXY=1) each trusted proxy appends
 * the address it saw to X-Forwarded-For, so the real client is APEX_TRUSTED_HOPS from the right
 * (1 = Cloud Functions called directly; 2 = through a Firebase Hosting rewrite). Anything further
 * left was written by the client and is never trusted.
 */
export function clientIp(req) {
  const trust = Boolean(process.env.K_SERVICE) || process.env.APEX_TRUST_PROXY === '1'
  if (trust) {
    const xff = String(req.headers?.['x-forwarded-for'] || '')
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    const hops = Math.min(4, Math.max(1, Number.parseInt(process.env.APEX_TRUSTED_HOPS || '1', 10) || 1))
    if (parts.length) return parts[Math.max(0, parts.length - hops)]
  }
  return req.socket?.remoteAddress || req.ip || 'unknown'
}

function cacheHeader(c) {
  if (!c) return 'no-store'
  if (c.priv) return `private, max-age=${c.maxAge ?? 0}`
  const parts = ['public', `max-age=${c.maxAge ?? 0}`]
  if (c.sMaxAge != null) parts.push(`s-maxage=${c.sMaxAge}`)
  if (c.swr) parts.push(`stale-while-revalidate=${c.swr}`)
  return parts.join(', ')
}

export function createRouter() {
  const routes = []
  const mws = []

  function add(method, pattern, opts, handler) {
    if (typeof opts === 'function') {
      handler = opts
      opts = {}
    }
    routes.push({ method, pattern, opts, handler, ...compile(pattern) })
  }

  function match(method, path) {
    for (const r of routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue
      const m = r.re.exec(path)
      if (!m) continue
      const params = {}
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1])
        } catch {
          params[k] = m[i + 1]
        }
      })
      return { route: r, params }
    }
    return null
  }

  function send(ctx, status, body) {
    const { req, res } = ctx
    if (res.headersSent) return
    const json = JSON.stringify(body)
    const etag = `W/"${hash(json)}"`
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', status === 200 ? cacheHeader(ctx.cache) : 'no-store')
    if (ctx.cache && !ctx.cache.priv) res.setHeader('Vary', 'Accept-Encoding')
    if (ctx.cache?.priv) res.setHeader('Vary', 'Authorization')
    if (status === 200) {
      res.setHeader('ETag', etag)
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304
        return res.end()
      }
    }
    res.statusCode = status
    res.end(req.method === 'HEAD' ? undefined : json)
  }

  /** Express-compatible entry point. Never throws. */
  async function handle(req, res, next) {
    const path = req.path || new URL(req.url, 'http://x').pathname
    const found = match(req.method, path)
    if (!found) return next ? next() : send({ req, res }, 404, { error: 'Not found', code: 'not_found' })
    const { route, params } = found
    const ctx = { req, res, params, query: req.query || {}, route, cache: route.opts.cache || null, user: null, access: null }
    try {
      for (const mw of mws) {
        const stop = await mw(ctx)
        if (stop === RAW || res.headersSent) return
      }
      const out = await route.handler(ctx)
      if (out === RAW || res.headersSent) return
      send(ctx, 200, out ?? { ok: true })
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 429 && e.extra?.retryAfter) res.setHeader('Retry-After', String(e.extra.retryAfter))
        return send(ctx, e.status, { error: e.message, code: e.code, ...(e.extra || {}) })
      }
      log.error('route failed', { path, err: errText(e), stack: e?.stack?.split('\n').slice(0, 4).join(' | ') })
      try {
        send(ctx, 500, { error: 'Something went wrong on our side.', code: 'internal' })
      } catch {
        /* response is gone */
      }
    }
  }

  return {
    get: (p, o, h) => add('GET', p, o, h),
    post: (p, o, h) => add('POST', p, o, h),
    put: (p, o, h) => add('PUT', p, o, h),
    del: (p, o, h) => add('DELETE', p, o, h),
    use: (mw) => mws.push(mw),
    handle,
    match,
    routes,
  }
}

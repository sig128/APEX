// A small route table for the JSON API: pattern matching, ETags, cache headers, and errors that
// never crash the process.
import net from 'node:net'
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

// Proxies allowed to speak for a client in X-Forwarded-For. Firebase Hosting's CDN (Fastly,
// https://api.fastly.com/public-ip-list) and Google's load balancer proxy ranges. Nobody can
// send traffic from these themselves (short of running their own Fastly service), so an
// address they appended is the real client.
const PROXY_SETS = {
  fastly: ['23.235.32.0/20', '43.249.72.0/22', '90.98.0.0/17', '90.98.128.0/18', '103.244.50.0/24', '103.245.222.0/23', '103.245.224.0/24', '104.156.80.0/20', '140.248.64.0/18', '140.248.128.0/17', '146.75.0.0/17', '151.101.0.0/16', '157.52.64.0/18', '167.82.0.0/17', '167.82.128.0/20', '167.82.160.0/20', '167.82.224.0/20', '172.111.64.0/18', '185.31.16.0/22', '199.27.72.0/21', '199.232.0.0/16', '2a04:4e40::/32', '2a04:4e42::/31', '2a04:4e44::/32'],
  google: ['35.191.0.0/16', '130.211.0.0/22'],
}
let proxyCache = { spec: null, list: null }

function trustedProxies() {
  const spec = process.env.APEX_TRUSTED_PROXIES ?? 'fastly,google'
  if (proxyCache.spec === spec) return proxyCache.list
  const list = new net.BlockList()
  for (const item of spec.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    for (const cidr of PROXY_SETS[item] || [item]) {
      const [addr, bits] = cidr.split('/')
      const v = net.isIP(addr)
      if (!v) continue
      const prefix = bits == null ? (v === 6 ? 128 : 32) : Number(bits)
      if (!Number.isInteger(prefix)) continue
      try {
        list.addSubnet(addr, prefix, v === 6 ? 'ipv6' : 'ipv4')
      } catch {
        /* bad entry: skip */
      }
    }
  }
  proxyCache = { spec, list }
  return list
}

/** "1.2.3.4", "1.2.3.4:5678", "[2001:db8::1]:443", "::ffff:1.2.3.4" -> a bare address or ''. */
function bareIp(s) {
  let a = String(s || '').trim()
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(a)
  if (bracket) a = bracket[1]
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'))
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(a)) a = a.slice(7)
  return net.isIP(a) ? a : ''
}

function isTrustedProxy(ip) {
  const a = bareIp(ip)
  if (!a) return false
  return trustedProxies().check(a, net.isIP(a) === 6 ? 'ipv6' : 'ipv4')
}

/**
 * The caller's IP. On Cloud Functions (or with APEX_TRUST_PROXY=1) Google's front end appends
 * the address that connected to it to X-Forwarded-For, so the last entry is real. We step left
 * only past addresses that belong to trusted proxies (Firebase Hosting's CDN by default;
 * APEX_TRUSTED_PROXIES to change), so whatever a client writes into the header itself is never
 * believed.
 */
export function clientIp(req) {
  const peer = bareIp(req.socket?.remoteAddress || req.ip) || 'unknown'
  const trust = Boolean(process.env.K_SERVICE) || process.env.APEX_TRUST_PROXY === '1'
  if (!trust) return peer
  const parts = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (!parts.length) return peer
  let i = parts.length - 1
  for (let steps = 0; i > 0 && steps < 4 && isTrustedProxy(parts[i]); steps++) i--
  return bareIp(parts[i]) || peer
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

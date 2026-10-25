// /api/picks/* — user pages, the Elite feed and leaderboard, posting and deleting picks.
import express from 'express'
import { ApiError, clientIp } from '../lib/router.js'
import { createLimiter } from '../security/rateLimit.js'
import { log, errText } from '../lib/log.js'

export function picksRoutes({ picks, access }) {
  const r = express.Router()
  const writeLimit = createLimiter({ burst: 10, perSec: 1 / 6 })
  const readLimit = createLimiter({ burst: 120, perSec: 4 })

  // Grade lazily on traffic, but never make a reader wait more than 2.5 seconds for it.
  r.use((req, _res, next) => {
    const timer = new Promise((resolve) => setTimeout(resolve, 2500).unref?.())
    Promise.race([picks.maybeGrade(), timer]).finally(() => next())
  })

  const wrap = (fn, cache) => async (req, res) => {
    res.set('Cache-Control', cache || 'no-store')
    try {
      const out = await fn(req, res)
      if (!res.headersSent) res.json(out ?? { ok: true })
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.extra?.retryAfter) res.set('Retry-After', String(e.extra.retryAfter))
        res.set('Cache-Control', 'no-store')
        return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
      }
      log.error('picks route failed', { path: req.path, err: errText(e) })
      res.set('Cache-Control', 'no-store').status(500).json({ error: 'Something went wrong on our side.', code: 'internal' })
    }
  }
  const viewer = async (req) => (await access.resolve(req)).user
  const signedIn = async (req) => {
    const u = await viewer(req)
    if (!u) throw new ApiError(401, 'signin', 'Sign in first.')
    return u
  }
  // without a database (a Vercel deploy with no service account) pages and picks can't be kept
  const needDb = () => {
    if (process.env.APEX_EPHEMERAL === '1') throw new ApiError(503, 'no_database', 'Picks pages aren’t switched on yet. Check back soon.')
  }
  const throttle = (lim, key, cost = 1) => {
    const t = lim.take(key, cost)
    if (!t.ok) throw new ApiError(429, 'slow_down', 'Slow down a little.', { retryAfter: t.retryAfter })
  }

  // older pages miss the CDN and cost real reads, so they count for more
  const pageCost = (req) => (req.query.before ? 4 : 1)
  r.get('/feed', wrap(async (req) => {
    throttle(readLimit, clientIp(req), pageCost(req))
    return picks.feed({ before: req.query.before })
  }, 'public, max-age=10, s-maxage=20, stale-while-revalidate=60'))

  r.get('/leaderboard', wrap(async (req) => {
    throttle(readLimit, clientIp(req))
    return picks.leaderboard({ range: req.query.range === 'all' ? 'all' : '30d' })
  }, 'public, max-age=30, s-maxage=60, stale-while-revalidate=180'))

  r.get('/u/:handle', wrap(async (req, res) => {
    throttle(readLimit, clientIp(req), pageCost(req))
    // Owners see their own page fresh (and hidden pages); everyone else gets the cached copy.
    const auth = req.headers.authorization || req.headers['x-apex-admin-key']
    const v = auth ? await viewer(req).catch(() => null) : null
    if (v) res.set('Cache-Control', 'private, no-store')
    return picks.page(req.params.handle, { before: req.query.before, viewer: v })
  }, 'public, max-age=10, s-maxage=15, stale-while-revalidate=60'))

  r.get('/me', wrap(async (req) => picks.me(await signedIn(req))))
  r.put('/me', wrap(async (req) => {
    needDb()
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.saveProfile(u, req.body || {})
  }))
  r.post('/', wrap(async (req) => {
    needDb()
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.post(u, req.body || {})
  }))
  r.post('/check', wrap(async (req) => {
    throttle(readLimit, clientIp(req))
    return picks.check(req.body || {})
  }))
  r.delete('/:id', wrap(async (req) => {
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.remove(u, req.params.id)
  }))
  r.post('/admin/hide', wrap(async (req) => picks.setHidden(await signedIn(req), req.body || {})))

  return r
}

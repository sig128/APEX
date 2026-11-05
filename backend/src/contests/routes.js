// /api/contests (anyone can look, signed-in users enter) and /api/admin/contests (behind the
// admin password, like the rest of the admin page). Traffic on either grades finished games.
import express from 'express'
import { ApiError, clientIp } from '../lib/router.js'
import { createLimiter } from '../security/rateLimit.js'
import { log, errText } from '../lib/log.js'

export function contestsRoutes({ contests, access, lock }) {
  const writeLimit = createLimiter({ burst: 10, perSec: 1 / 6 })
  const readLimit = createLimiter({ burst: 120, perSec: 4 })
  const adminLimit = createLimiter({ burst: 30, perSec: 1 / 2 })

  // Grade lazily on traffic, but never make a reader wait more than 2.5 seconds for it.
  const gradeOnTraffic = (req, _res, next) => {
    const timer = new Promise((resolve) => setTimeout(resolve, 2500).unref?.())
    Promise.race([contests.maybeGrade(), timer]).finally(() => next())
  }

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
      log.error('contests route failed', { path: req.path, err: errText(e) })
      res.set('Cache-Control', 'no-store').status(500).json({ error: 'Something went wrong on our side.', code: 'internal' })
    }
  }
  const viewer = async (req) => (await access.resolve(req)).user
  const signedIn = async (req) => {
    const u = await viewer(req)
    if (!u) throw new ApiError(401, 'signin', 'Sign in with Google to enter.')
    return u
  }
  // without a database (a Vercel deploy with no service account) entries can't be kept
  const needDb = () => {
    if (process.env.APEX_EPHEMERAL === '1') throw new ApiError(503, 'no_database', 'Contests aren’t switched on yet. Check back soon.')
  }
  const throttle = (lim, key, cost = 1) => {
    const t = lim.take(key, cost)
    if (!t.ok) throw new ApiError(429, 'slow_down', 'Slow down a little.', { retryAfter: t.retryAfter })
  }

  const pub = express.Router()
  pub.use(gradeOnTraffic)
  pub.get(
    '/',
    wrap(async (req) => {
      throttle(readLimit, clientIp(req))
      return contests.list()
    }, 'public, max-age=15, s-maxage=30, stale-while-revalidate=60'),
  )
  pub.get(
    '/:id',
    wrap(async (req, res) => {
      throttle(readLimit, clientIp(req))
      // signed in: your own entry, fresh; everyone else shares the cached copy
      const v = req.headers.authorization ? await viewer(req) : null
      res.set('Vary', 'Authorization')
      if (v) res.set('Cache-Control', 'private, no-store')
      return contests.view(req.params.id, v)
    }, 'public, max-age=10, s-maxage=15, stale-while-revalidate=30'),
  )
  pub.post(
    '/:id/entry',
    wrap(async (req) => {
      needDb()
      const u = await signedIn(req)
      throttle(writeLimit, u.uid)
      return contests.enter(u, req.params.id, req.body || {})
    }),
  )

  // the password is the only way in (a Google admin account alone doesn't open it)
  const admin = express.Router()
  admin.use(gradeOnTraffic)
  const as = (fn, { write = false } = {}) =>
    wrap(async (req) => {
      const a = lock.require(req)
      if (write) {
        needDb()
        throttle(adminLimit, 'admin')
      }
      return fn(a, req)
    })
  admin.get('/', as((a) => contests.adminList(a)))
  admin.post('/', as((a, req) => contests.create(a, req.body || {}), { write: true }))
  // "Grade now": the same run traffic triggers, without waiting for it
  admin.post('/grade', as((a) => contests.gradeNow(a), { write: true }))
  admin.get('/:id', as((a, req) => contests.adminView(a, req.params.id)))
  admin.put('/:id', as((a, req) => contests.update(a, req.params.id, req.body || {}), { write: true }))
  admin.post('/:id/publish', as((a, req) => contests.publish(a, req.params.id), { write: true }))
  admin.post('/:id/close', as((a, req) => contests.close(a, req.params.id), { write: true }))
  admin.post('/:id/cancel', as((a, req) => contests.cancel(a, req.params.id), { write: true }))

  return { public: pub, admin }
}

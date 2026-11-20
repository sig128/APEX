// /api/breakdown/* — the Bet Breakdown: the demo (anyone), and your own settled picks (members).
import express from 'express'
import { ApiError, clientIp } from '../lib/router.js'
import { createLimiter } from '../security/rateLimit.js'
import { log, errText } from '../lib/log.js'

export function breakdownRoutes({ breakdowns, access }) {
  const r = express.Router()
  const buildLimit = createLimiter({ burst: 6, perSec: 1 / 10 })
  const askLimit = createLimiter({ burst: 10, perSec: 1 / 4 })
  const readLimit = createLimiter({ burst: 60, perSec: 2 })
  const wrap = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      const out = await fn(req, res)
      if (!res.headersSent) res.json(out ?? { ok: true })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
      log.warn('breakdown route failed', { err: errText(e) })
      res.status(500).json({ error: 'Something went wrong.', code: 'server' })
    }
  }
  const throttle = (lim, key) => {
    const t = lim.take(key)
    if (!t.ok) throw new ApiError(429, 'rate', 'One moment, then try again.', { retryAfter: t.retryAfter })
  }
  const userOf = async (req) => (await access.resolve(req).catch(() => null))?.user || null

  // the demo: made-up data, labelled as such, the same pipeline
  r.get('/demo', wrap(async (req, res) => {
    throttle(readLimit, clientIp(req))
    res.set('Cache-Control', 'public, max-age=300')
    return breakdowns.demo(String(req.query.mode || 'events'))
  }))
  r.post('/demo/ask', express.json({ limit: '4kb' }), wrap(async (req) => {
    throttle(askLimit, clientIp(req))
    return breakdowns.demoAsk(String(req.body?.mode || 'events'), req.body?.q)
  }))

  r.get('/:id', wrap(async (req) => {
    throttle(readLimit, clientIp(req))
    return breakdowns.get(await userOf(req), req.params.id)
  }))
  r.post('/:id', wrap(async (req) => {
    const u = await userOf(req)
    throttle(buildLimit, u?.uid || clientIp(req))
    return breakdowns.generate(u, req.params.id)
  }))
  r.post('/:id/ask', express.json({ limit: '4kb' }), wrap(async (req) => {
    const u = await userOf(req)
    throttle(askLimit, u?.uid || clientIp(req))
    return breakdowns.ask(u, req.params.id, req.body?.q)
  }))
  return r
}

// /api/admin/* for the admin page (signed-in admins only, every response no-store), and the
// daily run Vercel's cron calls: every league saves its lines and grades yesterday's.
import express from 'express'
import crypto from 'node:crypto'
import { ApiError } from '../lib/router.js'
import { log, errText } from '../lib/log.js'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function adminRoutes({ access, metrics, sports }) {
  const r = express.Router()
  const wrap = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      const out = await fn(req, res)
      if (!res.headersSent) res.json(out ?? { ok: true })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ error: e.message, code: e.code })
      log.error('admin route failed', { path: req.path, err: errText(e) })
      res.status(500).json({ error: 'The admin numbers could not be loaded. Try again in a minute.', code: 'internal' })
    }
  }
  const admin = async (req) => {
    const a = await access.resolve(req)
    if (!a.user) throw new ApiError(401, 'signin', 'Sign in first.')
    if (!a.user.admin) throw new ApiError(403, 'admin', 'Admins only.')
    return a.user
  }
  const dayParam = (v) => (typeof v === 'string' && DAY_RE.test(v) ? v : null)
  const sportParam = (v) => (sports.includes(v) ? v : null)

  r.get(
    '/overview',
    wrap(async (req) => {
      const u = await admin(req)
      const from = dayParam(req.query.from)
      const to = dayParam(req.query.to)
      if (from && to && from > to) throw new ApiError(400, 'bad_range', 'The start comes after the end.')
      return metrics.overview({ admin: u, from, to, sport: sportParam(req.query.sport), parts: req.query.parts === 'board' ? 'board' : 'all' })
    }),
  )
  r.get(
    '/day',
    wrap(async (req) => {
      await admin(req)
      const sport = sportParam(req.query.sport)
      const day = dayParam(req.query.day)
      if (!sport || !day) throw new ApiError(400, 'bad_day', 'Pick a league and a day.')
      const out = await metrics.day({ sport, day })
      if (!out) throw new ApiError(404, 'not_found', 'Nothing on file for that day.')
      return out
    }),
  )
  // "Update now" on the admin page: the same run as the daily cron, shorter
  r.post(
    '/run',
    wrap(async (req) => {
      await admin(req)
      return { ran: await metrics.daily({ budgetMs: 100_000 }) }
    }),
  )
  return r
}

/** GET /api/cron/daily. With CRON_SECRET set, only Vercel's cron (which sends it) gets in. */
export function cronHandler({ metrics, minGapMs = 10 * 60_000 }) {
  let last = 0
  let running = null
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const secret = process.env.CRON_SECRET
    if (secret) {
      const got = Buffer.from(String(req.headers.authorization || ''))
      const want = Buffer.from(`Bearer ${secret}`)
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: 'Not allowed.', code: 'cron_secret' })
    }
    // the work is the same any visit would do; this only keeps one instance from repeating it
    if (running) return res.json({ ok: true, already: true })
    if (Date.now() - last < minGapMs) return res.json({ ok: true, skipped: true })
    last = Date.now()
    running = metrics
      .daily()
      .catch((e) => ({ error: errText(e) }))
      .finally(() => {
        running = null
      })
    const ran = await running
    log.info('daily run', { ran })
    res.json({ ok: true, ran })
  }
}

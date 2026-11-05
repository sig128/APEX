// /api/calibration/* for the public calibration page: no sign-in, cacheable, and rate limited per
// address like the other public reads (src/picks/routes.js). Errors are { error, code }.
//   GET /api/calibration                    bands, headline and range   ?league&market&window&season&basis
//   GET /api/calibration/fingerprints       each closed day's SHA-256    ?league&window&season
//   GET /api/calibration/day/:league/:day   one closed day's graded rows, its fingerprint, and the
//                                           fingerprint worked out again (?format=text: the hashed text)
import express from 'express'
import { ApiError, clientIp } from '../lib/router.js'
import { createLimiter } from '../security/rateLimit.js'
import { log, errText } from '../lib/log.js'
import { parseFilters, FORMAT } from './service.js'

export const CACHE = 'public, max-age=60, s-maxage=300'
// an answer still adding closed days is kept only briefly, so the rest shows up soon
const SHORT = 'public, max-age=5, s-maxage=10'

export function calibrationRoutes({ calibration, limiter = createLimiter({ burst: 60, perSec: 2 }) }) {
  const r = express.Router()
  const wrap = (fn, cost = 1) => async (req, res) => {
    try {
      const t = limiter.take(clientIp(req), cost)
      if (!t.ok) throw new ApiError(429, 'slow_down', 'Too many requests. Slow down a moment.', { retryAfter: t.retryAfter })
      const out = await fn(req, res)
      if (res.headersSent) return
      res.set('Cache-Control', out?.complete === false || out?.range?.complete === false ? SHORT : CACHE)
      res.json(out)
    } catch (e) {
      res.set('Cache-Control', 'no-store')
      if (e instanceof ApiError) {
        if (e.extra?.retryAfter) res.set('Retry-After', String(e.extra.retryAfter))
        return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
      }
      log.error('calibration route failed', { path: req.path, err: errText(e) })
      res.status(500).json({ error: 'The calibration numbers could not be loaded. Try again in a minute.', code: 'internal' })
    }
  }
  const filters = (req) => parseFilters(req.query, calibration.leagues())

  r.get('/', wrap((req) => calibration.summary(filters(req))))

  r.get(
    '/fingerprints',
    wrap((req) => {
      const { league, window, season } = filters(req)
      return calibration.fingerprints({ league, window, season })
    }),
  )

  // a raw day is the heaviest read here, so it counts for more
  r.get(
    '/day/:league/:day',
    wrap(async (req, res) => {
      const format = String(req.query.format || 'json')
      if (format !== 'json' && format !== 'text') throw new ApiError(400, 'bad_format', 'Format is json or text.')
      const { body, text } = await calibration.closedDay(String(req.params.league).toLowerCase(), String(req.params.day))
      if (format === 'text') {
        res.set('Cache-Control', CACHE).set('X-Fingerprint-Format', FORMAT).type('text/plain; charset=utf-8').send(text)
        return null
      }
      return body
    }, 3),
  )

  return r
}

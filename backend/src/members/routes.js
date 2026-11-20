// /api/members/* — the consent screen's record, the onboarding tour's counts, and feedback.
import express from 'express'
import { ApiError, clientIp } from '../lib/router.js'
import { createLimiter } from '../security/rateLimit.js'
import { log, errText } from '../lib/log.js'
import { CONSENT_VERSION } from './service.js'

export function membersRoutes({ members, access }) {
  const r = express.Router()
  const small = createLimiter({ burst: 30, perSec: 1 })
  // a person writes a few notes a day at most; a script that tries more is turned away
  const notes = createLimiter({ burst: 5, perSec: 1 / 30 })
  const taps = createLimiter({ burst: 40, perSec: 1 / 3 })

  const wrap = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      const out = await fn(req, res)
      if (!res.headersSent) res.json(out ?? { ok: true })
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.extra?.retryAfter) res.set('Retry-After', String(e.extra.retryAfter))
        return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
      }
      log.error('members route failed', { path: req.path, err: errText(e) })
      res.status(500).json({ error: 'That didn’t go through. Try again in a minute.', code: 'internal' })
    }
  }
  const throttle = (lim, key, msg = 'Slow down a little.') => {
    const t = lim.take(key)
    if (!t.ok) throw new ApiError(429, 'slow_down', msg, { retryAfter: t.retryAfter })
  }
  const who = async (req) => (await access.resolve(req).catch(() => null))?.user || null

  r.get('/consent', wrap(async (req) => {
    const user = await who(req)
    return user ? members.consentOf(user.uid) : { version: CONSENT_VERSION, accepted: null }
  }))
  r.post('/consent', wrap(async (req) => {
    throttle(small, clientIp(req))
    const b = req.body || {}
    if (b.agree !== true) throw new ApiError(400, 'not_agreed', 'Tick the box to agree first.')
    const user = await who(req)
    return members.consent({ device: b.device, version: b.version, app: b.app, uid: user?.uid || null })
  }))

  r.post('/tour', wrap(async (req) => {
    throttle(small, clientIp(req))
    const b = req.body || {}
    return members.tour({ action: String(b.action || ''), step: Number.isInteger(b.step) ? b.step : null })
  }))

  // Smart Check: counts of the notes shown and what happened next
  r.post('/nudges', wrap(async (req) => {
    throttle(small, clientIp(req))
    const b = req.body || {}
    return members.nudges({ types: b.types, action: String(b.action || '') })
  }))

  r.post('/feedback', wrap(async (req) => {
    const b = req.body || {}
    const tap = b.helpful === true || b.helpful === false
    throttle(tap ? taps : notes, clientIp(req), 'Thanks, we got your last note. Give it a minute before sending another.')
    // a field people never see: only a script fills it in, and it gets a quiet "thanks"
    if (b.website) return { ok: true }
    const user = await who(req)
    return members.feedback({
      kind: b.kind,
      message: b.message,
      rating: Number.isInteger(b.rating) ? b.rating : null,
      helpful: tap ? b.helpful : null,
      about: b.about,
      page: b.page,
      app: b.app,
      device: req.get('user-agent'),
      include: b.include === true,
      shot: b.shot ?? null,
      user,
    })
  }))
  return r
}

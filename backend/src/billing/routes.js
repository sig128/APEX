// /api/billing/* — pass purchase and admin endpoints. Every response is no-store.
import express from 'express'
import { ApiError } from '../lib/router.js'
import { publicBillingConfig } from './config.js'
import { createLimiter } from '../security/rateLimit.js'
import { log, errText } from '../lib/log.js'
import { redeemInvite } from './invites.js'

export function billingRoutes({ billing, access, getDb = null, now = Date.now }) {
  const r = express.Router()
  const confirmLimit = createLimiter({ burst: 20, perSec: 1 / 3 })
  const scanLimit = createLimiter({ burst: 4, perSec: 1 / 15 })
  const invoiceLimit = createLimiter({ burst: 6, perSec: 1 / 20 })

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
      log.error('billing route failed', { path: req.path, err: errText(e) })
      res.status(502).json({ error: 'Could not reach the payment network. Try again in a minute.', code: 'upstream' })
    }
  }

  const who = async (req) => {
    const a = await access.resolve(req)
    if (!a.user) throw new ApiError(401, 'signin', 'Sign in first.')
    return a.user
  }
  const admin = async (req) => {
    const u = await who(req)
    if (!u.admin) throw new ApiError(403, 'admin', 'Admins only.')
    return u
  }
  const limited = (lim, key) => {
    const t = lim.take(key)
    if (!t.ok) throw new ApiError(429, 'slow_down', 'Slow down a little.', { retryAfter: t.retryAfter })
  }

  r.get('/config', wrap(async () => publicBillingConfig()))
  // invite and plan codes (the same rules as the Firebase callable, which uses this too)
  r.post(
    '/redeem',
    wrap(async (req) => {
      const u = await who(req)
      const db = getDb ? getDb() : null
      if (!db) throw new ApiError(503, 'no_database', 'Codes can’t be redeemed on this server yet.')
      const out = await redeemInvite(db, u, req.body?.code, { now })
      billing.changed(u.uid)
      return out
    }),
  )
  r.get('/me', wrap(async (req) => billing.me(await who(req))))
  r.post(
    '/invoice',
    wrap(async (req) => {
      const u = await who(req)
      limited(invoiceLimit, u.uid)
      return billing.createInvoice(u, String(req.body?.plan || ''))
    }),
  )
  r.get('/invoice/:id', wrap(async (req) => billing.getInvoice(await who(req), req.params.id)))
  r.post(
    '/invoice/:id/confirm',
    wrap(async (req) => {
      const u = await who(req)
      limited(confirmLimit, u.uid)
      return billing.confirm(u, req.params.id, req.body?.txHash)
    }),
  )
  r.post(
    '/invoice/:id/scan',
    wrap(async (req) => {
      const u = await who(req)
      limited(scanLimit, u.uid)
      return billing.scan(u, req.params.id)
    }),
  )

  r.get('/admin/payments', wrap(async (req) => ({ payments: await billing.payments(await admin(req), { limit: Number(req.query.limit) || 50 }) })))
  r.get('/admin/subscriptions', wrap(async (req) => ({ subscriptions: await billing.subscriptions(await admin(req), { limit: Number(req.query.limit) || 100 }) })))
  r.post('/admin/grant', wrap(async (req) => billing.grant(await admin(req), req.body || {})))
  r.post('/admin/revoke', wrap(async (req) => billing.revoke(await admin(req), req.body || {})))

  return r
}

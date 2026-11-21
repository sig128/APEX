// /api/picks/* — user pages, the Elite feed and leaderboard, posting and deleting picks, and each
// person's own tools: alerts, the coach, live slips, limits and breaks, subscribers.
import express from 'express'
import { ApiError, clientIp } from '../lib/router.js'
import { createLimiter } from '../security/rateLimit.js'
import { log, errText } from '../lib/log.js'
import { billingConfig } from '../billing/config.js'
import { atLeast } from '../billing/service.js'
import { authMode } from '../security/auth.js'

export function picksRoutes({ picks, access, billing = null, groups = null }) {
  /**
   * The members' leaderboard is for members: the admin and anyone holding a real Pro or Elite
   * pass (paid, given by the admin, or from a plan code), passes on sale or not. Local dev
   * without sign-in sees it all.
   */
  async function isMember(req) {
    const a = await access.resolve(req).catch(() => null)
    if (authMode() === 'optional' && !billingConfig().paywall) return true
    if (!a?.user) return false
    if (billing?.aiAccess) return (await billing.aiAccess(a.user)).allowed
    return Boolean(a.user.admin) || (billingConfig().paywall && atLeast(a.tier || 'free', 'pro'))
  }
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

  // the handles this reader has blocked (none for a signed-out reader): their picks drop out of
  // what this reader sees, and the answer is then private to them
  const blockedFor = async (req, res) => {
    if (!req.get('authorization')) return null
    const v = await viewer(req).catch(() => null)
    const set = v ? await picks.blockedHandles(v) : null
    if (!set?.size) return null
    res.set('Cache-Control', 'private, no-store')
    return set
  }

  // older pages miss the CDN and cost real reads, so they count for more
  const pageCost = (req) => (req.query.before ? 4 : 1)
  r.get('/feed', wrap(async (req, res) => {
    throttle(readLimit, clientIp(req), pageCost(req))
    const out = await picks.feed({ before: req.query.before })
    const blocked = await blockedFor(req, res)
    return blocked ? { ...out, picks: out.picks.filter((x) => !blocked.has(x.profile?.handle || x.handle)) } : out
  }, 'public, max-age=10, s-maxage=20, stale-while-revalidate=60'))

  // The full leaderboard is for members; a free visitor gets the podium and how many are behind
  // it. Decided here on the server, so the rest of the board never reaches a free browser.
  r.get('/leaderboard', wrap(async (req, res) => {
    throttle(readLimit, clientIp(req))
    const q = req.query
    const board = await picks.leaderboard({ range: String(q.range || '30d'), sport: String(q.sport || 'all'), legs: String(q.legs || 'all'), sort: String(q.sort || 'roi') })
    const paid = await isMember(req)
    const blocked = await blockedFor(req, res)
    const out = blocked ? { ...board, rows: board.rows.filter((x) => !blocked.has(x.profile?.handle)) } : board
    res.set('Vary', 'Authorization')
    // anyone signed in gets their own answer; the anonymous one is the same for everybody
    if (!blocked) res.set('Cache-Control', req.get('authorization') ? 'private, max-age=30' : 'public, max-age=30, s-maxage=60, stale-while-revalidate=180')
    return paid ? { ...out, locked: false, total: out.rows.length } : { ...out, rows: out.rows.slice(0, 3), total: out.rows.length, locked: true }
  }))

  r.get('/u/:handle', wrap(async (req, res) => {
    throttle(readLimit, clientIp(req), pageCost(req))
    // Owners see their own page fresh (and hidden pages); everyone else gets the cached copy.
    const auth = req.headers.authorization || req.headers['x-apex-admin-key']
    const v = auth ? await viewer(req).catch(() => null) : null
    if (v) res.set('Cache-Control', 'private, no-store')
    return picks.page(req.params.handle, { before: req.query.before, viewer: v })
  }, 'public, max-age=10, s-maxage=15, stale-while-revalidate=60'))

  r.get('/me', wrap(async (req) => picks.me(await signedIn(req))))
  // blocking someone, and the list of who you've blocked
  r.get('/blocks', wrap(async (req) => ({ blocked: (await picks.blocks(await signedIn(req))).map((b) => ({ handle: b.handle, at: b.at })) })))
  r.post('/blocks', wrap(async (req) => {
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.block(u, { handle: req.body?.handle, on: req.body?.on !== false })
  }))
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
    return picks.post(u, req.body || {}, { ip: clientIp(req) })
  }))
  r.post('/check', wrap(async (req) => {
    throttle(readLimit, clientIp(req))
    return picks.check(req.body || {})
  }))
  r.post('/:id/tail', wrap(async (req) => {
    needDb()
    const u = await viewer(req).catch(() => null)
    const who = u ? `u:${u.uid}` : `ip:${clientIp(req)}`
    throttle(writeLimit, who)
    return picks.tail(req.params.id, who, u)
  }))
  // tail a pick into your own record (your units, your limits), marked as tailed
  r.post('/:id/track', wrap(async (req) => {
    needDb()
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    const units = Number(req.body?.units)
    return picks.track(u, req.params.id, { units: Number.isFinite(units) ? units : undefined, ip: clientIp(req) })
  }))

  // ---- private groups: their own boards ---------------------------------------------------
  if (groups) {
    const groupLimit = createLimiter({ burst: 20, perSec: 1 / 3 })
    // a group board without the people this member blocked
    const filterBoard = async (u, out) => {
      const blocked = await picks.blockedHandles(u)
      return blocked.size ? { ...out, rows: out.rows.filter((r) => r.you || !blocked.has(r.profile?.handle)) } : out
    }
    const g = (fn) =>
      wrap(async (req) => {
        needDb()
        const u = await signedIn(req)
        throttle(groupLimit, u.uid)
        return fn(u, req)
      })
    r.get('/groups', g((u) => groups.mine(u)))
    r.post('/groups', g((u, req) => groups.create(u, req.body || {})))
    r.post('/groups/join', g((u, req) => groups.join(u, req.body || {})))
    // what a code opens (name and size), for the join link; no sign-in needed to look
    r.get('/groups/code/:code', wrap(async (req) => {
      throttle(readLimit, clientIp(req), 4)
      return groups.preview(req.params.code)
    }))
    r.get(
      '/groups/:id',
      g(async (u, req) => filterBoard(u, await groups.board(u, req.params.id, { range: String(req.query.range || '30d'), sport: String(req.query.sport || 'all'), legs: String(req.query.legs || 'all'), sort: String(req.query.sort || 'roi') }))),
    )
    r.post('/groups/:id/leave', g((u, req) => groups.leave(u, req.params.id)))
    r.post('/groups/:id/remove', g((u, req) => groups.removeMember(u, req.params.id, req.body || {})))
    r.post('/groups/:id/rename', g((u, req) => groups.rename(u, req.params.id, req.body || {})))
    r.post('/groups/:id/code', g((u, req) => groups.resetCode(u, req.params.id)))
    r.delete('/groups/:id', g((u, req) => groups.remove(u, req.params.id)))
  }

  // one pick (subscriber picks show their legs to subscribers)
  r.get('/p/:id', wrap(async (req) => {
    throttle(readLimit, clientIp(req))
    const v = await viewer(req).catch(() => null)
    return picks.pickFor(req.params.id, v)
  }))

  // ---- the signed-in person's own tools ------------------------------------------------------
  r.get('/me/alerts', wrap(async (req) => picks.alertsFor(await signedIn(req))))
  r.post('/me/alerts/seen', wrap(async (req) => picks.seenAlerts(await signedIn(req))))
  // tracking: your P&L line, record and trends. The line and trends are for members; anyone
  // signed in sees their own record.
  r.get('/me/tracking', wrap(async (req) => {
    const u = await signedIn(req)
    throttle(readLimit, u.uid, 4)
    const range = ['30d', '90d', 'all'].includes(String(req.query.range)) ? String(req.query.range) : '30d'
    const out = await picks.trackingFor(u, range)
    if (await isMember(req)) return { ...out, locked: false }
    return { range: out.range, from: out.from, to: out.to, record: out.record, streak: out.streak, locked: true }
  }))
  r.get('/me/coach', wrap(async (req) => {
    const u = await signedIn(req)
    throttle(readLimit, u.uid, 4)
    return picks.coachFor(u)
  }))
  r.get('/me/live', wrap(async (req) => {
    const u = await signedIn(req)
    throttle(readLimit, u.uid)
    return picks.liveFor(u)
  }))
  r.get('/me/rg', wrap(async (req) => picks.rgGet(await signedIn(req))))
  r.put('/me/rg', wrap(async (req) => {
    needDb()
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.rgLimits(u, req.body || {})
  }))
  r.post('/me/rg/pause', wrap(async (req) => {
    needDb()
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.rgPause(u, req.body || {})
  }))
  r.get('/me/subscribers', wrap(async (req) => picks.subscribers(await signedIn(req))))
  r.post('/me/subscribers', wrap(async (req) => {
    needDb()
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.setSubscriber(u, { handle: req.body?.handle })
  }))
  r.delete('/me/subscribers/:handle', wrap(async (req) => {
    needDb()
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.setSubscriber(u, { handle: req.params.handle, remove: true })
  }))
  r.delete('/:id', wrap(async (req) => {
    const u = await signedIn(req)
    throttle(writeLimit, u.uid)
    return picks.remove(u, req.params.id)
  }))
  r.post('/admin/hide', wrap(async (req) => picks.setHidden(await signedIn(req), req.body || {})))

  return r
}

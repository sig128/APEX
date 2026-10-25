// /api/nfl/* — the stats API (free), the live stream, and the AI prop read (Pro).
import { createRouter, ApiError, RAW, clientIp } from '../lib/router.js'
import { ROUTE_TIER, TOPIC_RE, topicAllowed } from './gate.js'
import { streamPropInsight } from './ai.js'
import { atLeast } from '../billing/service.js'
import { billingConfig } from '../billing/config.js'
import { createLimiter } from '../security/rateLimit.js'
import { signTicket, verifyTicket } from '../security/ticket.js'
import { defaultAuthInstance, authMode } from '../security/auth.js'
import { parsePropId } from './analytics/core.js'
import { envInt } from '../lib/util.js'

/** Optional: make every read require sign-in (APEX_READS_NEED_AUTH=1). Off by default: stats are free. */
const readsNeedAuth = () => process.env.APEX_READS_NEED_AUTH === '1'

export function createNflRouter(engine, { anthropicKey, auth = defaultAuthInstance, access, billing } = {}) {
  const r = createRouter()
  const views = engine.views
  const limiter = createLimiter({ burst: envInt('APEX_RATE_BURST', 600, { min: 10 }), perSec: envInt('APEX_RATE_RPS', 20, { min: 1 }) })
  const insightLimiter = createLimiter({ burst: 6, perSec: 1 / 5 })
  const paywallOn = () => Boolean(access && billing && billingConfig().paywall)
  const OPEN = { ok: true, user: null, ent: { plan: 'elite', status: 'open' }, tier: 'elite' }

  async function accessFor(req) {
    if (paywallOn()) return access.resolve(req)
    if (readsNeedAuth()) {
      const user = await auth.authenticate(req)
      return { ok: true, user, ent: OPEN.ent, tier: 'elite' }
    }
    return OPEN
  }

  function needPlan(need, a) {
    if (!a.user) throw new ApiError(401, 'signin', 'Sign in to use this.', { need })
    throw new ApiError(402, 'upgrade', need === 'pro' ? 'This is part of Pro and Elite.' : 'This is part of Elite.', { need, plan: a.tier, status: a.ent?.status })
  }

  r.use(async (ctx) => {
    const ip = clientIp(ctx.req)
    const t = limiter.take(ip)
    if (!t.ok) throw new ApiError(429, 'rate', 'Too many requests. Slow down a moment.', { retryAfter: t.retryAfter })
    const need = ctx.route.opts.tier || 'free'
    const mustAuth = readsNeedAuth()
    if (!ctx.route.opts.selfAuth && (mustAuth || (need !== 'free' && paywallOn()))) {
      const a = await accessFor(ctx.req)
      if (mustAuth && !a.user) needPlan(need, a)
      if (!atLeast(a.tier, need)) needPlan(need, a)
      ctx.access = a
      ctx.user = a.user
      if (ctx.route.opts.cache) ctx.cache = { ...ctx.route.opts.cache, priv: true }
    }
    await engine.ensureStarted()
  })

  const t = (name) => ROUTE_TIER[name] || 'free'
  const C = (maxAge, sMaxAge = maxAge, swr = maxAge * 3) => ({ maxAge, sMaxAge, swr })

  r.get('/status', { tier: t('status'), cache: C(5) }, () => {
    const s = engine.status()
    return { season: s.season, week: s.week, games: s.games, live: s.live, props: s.props, players: s.players, logs: s.logs, wanted: s.wanted, at: s.at, mode: s.mode, version: s.version, odds: s.odds?.enabled || false }
  })
  r.get('/week', { tier: t('week'), cache: C(5, 5, 20) }, () => views.strip())
  r.get('/home', { tier: t('home'), cache: C(15, 20, 60) }, () => views.home())
  r.get('/board', { tier: t('board'), cache: C(15, 20, 60) }, (ctx) => views.props(ctx.query))
  r.get('/props/:id', { tier: t('props'), cache: C(15, 20, 60) }, (ctx) => {
    if (!parsePropId(ctx.params.id)) throw new ApiError(400, 'bad_prop', 'That prop id is not valid.')
    const out = views.prop(ctx.params.id)
    if (!out) throw new ApiError(404, 'not_found', 'That prop is not on this week’s board.')
    return out
  })
  r.get('/games/:id', { tier: t('games'), cache: C(10, 10, 30) }, (ctx) => {
    if (!/^\d{6,12}$/.test(ctx.params.id)) throw new ApiError(400, 'bad_game', 'Bad game id.')
    const out = views.game(ctx.params.id)
    if (!out) throw new ApiError(404, 'not_found', 'That game is not on this week’s slate.')
    if (out.game.status.state === 'in') ctx.cache = { ...(ctx.cache || {}), maxAge: 4, sMaxAge: 4, swr: 10 }
    return out
  })
  r.get('/players/:id', { tier: t('players'), cache: C(30, 60, 180) }, (ctx) => {
    if (!/^\d{3,12}$/.test(ctx.params.id)) throw new ApiError(400, 'bad_player', 'Bad player id.')
    const out = views.player(ctx.params.id)
    if (!out) throw new ApiError(404, 'not_found', 'No player with that id this week.')
    return out
  })
  r.get('/live', { tier: t('live'), cache: C(4, 4, 10) }, () => views.live())
  r.get('/track', { tier: t('track'), cache: C(4, 4, 10) }, (ctx) => {
    const ids = String(ctx.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!ids.length || ids.length > 40) throw new ApiError(400, 'bad_ids', 'Send 1 to 40 prop ids.')
    return views.track(ids)
  })
  r.get('/search', { tier: t('search'), cache: C(30, 60, 300) }, (ctx) => views.search(String(ctx.query.q || '').slice(0, 60)))
  r.get('/dvp', { tier: t('dvp'), cache: C(120, 300, 900) }, () => views.dvp())
  r.get('/rankings', { tier: t('rankings'), cache: C(30, 60, 180) }, () => views.rankings())

  /** A ticket for the stream when reads need sign-in. */
  r.get('/ticket', { selfAuth: true }, async (ctx) => {
    ctx.cache = null
    if (!readsNeedAuth()) return { ticket: null, required: false }
    const user = await auth.authenticate(ctx.req)
    return { ticket: signTicket({ uid: user.uid }), required: true, ttlMs: 10 * 60_000 }
  })

  r.get('/stream', { selfAuth: true }, async (ctx) => {
    const { req, res } = ctx
    if (readsNeedAuth()) {
      const ok = verifyTicket(String(ctx.query.ticket || ''))
      if (!ok) throw new ApiError(401, 'signin', 'Sign in again to get live updates.')
    }
    const list = [...new Set(String(ctx.query.topics || 'scoreboard').split(',').map((s) => s.trim()))].filter((x) => TOPIC_RE.test(x) && topicAllowed(x)).slice(0, 12)
    if (!list.length) {
      res.statusCode = 204
      res.end()
      return RAW
    }
    const hub = engine.hub
    if (!hub) throw new ApiError(503, 'no_stream', 'Live updates are off on this server.')
    hub.stream(req, res, {
      list,
      initial: (topic) => {
        if (topic === 'scoreboard') return views.strip()
        if (topic.startsWith('game:')) {
          const g = views.liveGame(topic.slice(5))
          return g && g.status.state !== 'pre' ? g : null
        }
        return null
      },
      maxDurationMs: 30 * 60_000,
    })
    engine.onSubscribersChanged?.(hub.stats().clients)
    req.on('close', () => engine.onSubscribersChanged?.(hub.stats().clients))
    return RAW
  })

  /** AI read of one prop. Pro and Elite (or the invite rule while the paywall is off). */
  r.post('/insight', { selfAuth: true }, async (ctx) => {
    const { req, res } = ctx
    ctx.cache = null
    const propId = String(req.body?.propId || '')
    if (!parsePropId(propId)) throw new ApiError(400, 'bad_prop', 'That prop id is not valid.')
    let user
    let ent
    if (paywallOn()) {
      const a = await access.resolve(req)
      if (!a.user) throw new ApiError(401, 'signin', 'Sign in to get AI reads.', { need: 'pro' })
      if (!atLeast(a.tier, 'pro')) throw new ApiError(402, 'upgrade', 'AI picks are part of Pro and Elite.', { need: 'pro', plan: a.tier, status: a.ent.status })
      user = a.user
      ent = a.ent
    } else if (authMode() === 'optional') {
      // local `npm run dev` without Firebase: the AI is open, like the analyzer
      user = (await auth.identify(req).catch(() => null)) || { uid: `dev:${clientIp(req)}` }
    } else {
      user = await auth.authenticate(req)
      if (!(await auth.inviteVerified(user))) throw new ApiError(403, 'invite', 'Redeem an invite code to use AI reads.')
    }
    const lim = insightLimiter.take(user.uid)
    if (!lim.ok) throw new ApiError(429, 'slow_down', 'One AI read at a time. Try again in a few seconds.', { retryAfter: lim.retryAfter })
    let usage = null
    if (paywallOn()) {
      usage = await billing.useQuota(user, ent, 'aiReads')
      if (usage.limit != null) res.setHeader('X-Apex-Usage', `${usage.used}/${usage.limit}`)
    }
    const out = await streamPropInsight({ propId, views, res, apiKey: typeof anthropicKey === 'function' ? anthropicKey() : anthropicKey })
    if (paywallOn() && usage && !out.produced) await billing.refundQuota(user, 'aiReads').catch(() => {})
    return RAW
  })

  return r
}

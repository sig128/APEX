// /api/<sport>/* — the stats API (free), the live stream, the AI tools (Pro). One router per
// sport engine; NFL was first, so the file keeps its name.
import { createRouter, ApiError, RAW, clientIp } from '../lib/router.js'
import { ROUTE_TIER, TOPIC_RE, topicAllowed } from './gate.js'
import { streamPropInsight } from './ai.js'
import { createIntel } from './intel.js'
import { createLedger } from './ledger.js'
import { shop } from './shop.js'
import { extractLegs, matchLegs, streamParlayCheck, cleanImage, MAX_TEXT } from './parlay.js'
import { atLeast } from '../billing/service.js'
import { billingConfig } from '../billing/config.js'
import { createLimiter } from '../security/rateLimit.js'
import { signTicket, verifyTicket } from '../security/ticket.js'
import { defaultAuthInstance, authMode } from '../security/auth.js'
import { parsePropId } from './analytics/core.js'
import { simulateSlip } from './analytics/sim.js'
import { envInt } from '../lib/util.js'

/** Optional: make every read require sign-in (APEX_READS_NEED_AUTH=1). Off by default: stats are free. */
const readsNeedAuth = () => process.env.APEX_READS_NEED_AUTH === '1'

export function createNflRouter(engine, { anthropicKey, auth = defaultAuthInstance, access, billing, engines = null } = {}) {
  const r = createRouter()
  const views = engine.views
  const home = engine.sport?.key || 'nfl'
  // another league's engine, by its key ("nba"); nothing for junk like "__proto__"
  const engineFor = (key) => (key === home ? engine : engines && Object.hasOwn(engines, key) && engines[key]?.views ? engines[key] : null)

  /**
   * A slip can mix leagues. A leg is "<id>" (this league) or "<league>:<id>"; the row comes from
   * that league's board. Games, teams and players are told apart by league, so legs from two
   * leagues never share a factor in the simulation.
   */
  function legRows(refs) {
    const rows = []
    const missing = []
    const leagues = new Set()
    for (const ref of refs) {
      const s = String(ref)
      const i = s.indexOf(':')
      const key = i > 0 ? s.slice(0, i) : home
      const id = i > 0 ? s.slice(i + 1) : s
      const eng = engineFor(key)
      const row = eng && parsePropId(id) ? eng.views.findProp(id) : null
      if (!row) {
        missing.push(s)
        continue
      }
      leagues.add(key)
      rows.push({ row, key })
    }
    const mixed = leagues.size > 1
    const tag = (key, v) => (v == null || !mixed ? v : `${key}:${v}`)
    return {
      missing,
      mixed,
      rows: rows.map(({ row, key }) => (mixed ? { ...row, gameId: tag(key, row.gameId), teamId: tag(key, row.teamId), oppId: tag(key, row.oppId), playerId: tag(key, row.playerId) } : row)),
      raw: rows.map((x) => x.row),
    }
  }
  const limiter = createLimiter({ burst: envInt('APEX_RATE_BURST', 600, { min: 10 }), perSec: envInt('APEX_RATE_RPS', 20, { min: 1 }) })
  const insightLimiter = createLimiter({ burst: 6, perSec: 1 / 5 })
  const checkLimiter = createLimiter({ burst: 3, perSec: 1 / 10 })
  const intelLimiter = createLimiter({ burst: 3, perSec: 1 / 20 })
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
  // A fresh serverless instance has no game logs yet, so its board is empty. The request then
  // spends a few seconds loading them (every poll from a waiting page moves it along), and an
  // empty board is never cached, so nobody keeps getting it once the data is in.
  const WARM_MS = envInt('APEX_WARM_MS', 8000, { min: 0, max: 60_000 })
  /** Load before answering: the whole budget when the board is empty, a little while older seasons' logs are still coming. */
  async function warmed(ctx, build, empty) {
    let out = build()
    const left = engine.logsLeft?.() || 0
    if (WARM_MS && engine.catchUp && left > 0) {
      await engine.catchUp(empty(out) ? WARM_MS : Math.min(WARM_MS, 2000))
      out = build()
    }
    const loading = (engine.logsLeft?.() || 0) > 0
    // a board still filling in is never cached: the next request gets the rest
    if (loading || empty(out)) ctx.cache = null
    return { ...out, loading }
  }
  r.get('/home', { tier: t('home'), cache: C(15, 20, 60) }, (ctx) => warmed(ctx, () => views.home(), (o) => !o.counts.props && o.counts.pending > 0))
  r.get('/board', { tier: t('board'), cache: C(15, 20, 60) }, (ctx) => warmed(ctx, () => views.props(ctx.query), (o) => !o.total && o.pending > 0))
  r.get('/props/:id', { tier: t('props'), cache: C(15, 20, 60) }, (ctx) => {
    if (!parsePropId(ctx.params.id)) throw new ApiError(400, 'bad_prop', 'That prop id is not valid.')
    const out = views.prop(ctx.params.id)
    if (!out) throw new ApiError(404, 'not_found', 'That prop is not on the board right now.')
    return out
  })
  r.get('/games/:id/h2h', { tier: t('games'), cache: C(60, 60, 240) }, (ctx) => {
    if (!/^\d{6,12}$/.test(ctx.params.id)) throw new ApiError(400, 'bad_game', 'Bad game id.')
    const out = views.h2h(ctx.params.id)
    if (!out) throw new ApiError(404, 'not_found', `That game is not on the ${engine.sport?.calendar === 'day' ? 'current' : 'this week’s'} slate.`)
    return out
  })
  r.get('/games/:id', { tier: t('games'), cache: C(10, 10, 30) }, (ctx) => {
    if (!/^\d{6,12}$/.test(ctx.params.id)) throw new ApiError(400, 'bad_game', 'Bad game id.')
    const out = views.game(ctx.params.id)
    if (!out) throw new ApiError(404, 'not_found', `That game is not on the ${engine.sport?.calendar === 'day' ? 'current' : 'this week’s'} slate.`)
    if (out.game.status.state === 'in') ctx.cache = { ...(ctx.cache || {}), maxAge: 4, sMaxAge: 4, swr: 10 }
    return out
  })
  r.get('/players/:id', { tier: t('players'), cache: C(30, 60, 180) }, (ctx) => {
    if (!/^\d{3,12}$/.test(ctx.params.id)) throw new ApiError(400, 'bad_player', 'Bad player id.')
    const out = views.player(ctx.params.id)
    if (!out) throw new ApiError(404, 'not_found', 'No player with that id on this slate.')
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
    const client = hub.stream(req, res, {
      list,
      owner: clientIp(req),
      initial: (topic) => {
        if (topic === 'scoreboard') return views.strip()
        if (topic.startsWith('game:')) {
          const g = views.liveGame(topic.slice(5))
          return g && g.status.state !== 'pre' ? g : null
        }
        return null
      },
      // a stream ends a little before the platform would cut it (Vercel: 300 s), and the
      // browser reconnects on its own
      maxDurationMs: envInt('APEX_STREAM_MAX_SECONDS', process.env.VERCEL ? 280 : 1800, { min: 30, max: 7200 }) * 1000,
    })
    if (!client) throw new ApiError(429, 'streams', 'Too many live connections right now. Updates will keep coming every few seconds instead.', { retryAfter: 60 })
    engine.onSubscribersChanged?.(hub.stats().clients)
    req.on('close', () => engine.onSubscribersChanged?.(hub.stats().clients))
    return RAW
  })

  // Parlay simulator: 10,000-100,000 runs of the slip on the APEX distributions. Pro.
  const simLimiter = createLimiter({ burst: 12, perSec: 1 / 3 })
  r.post('/sim', { tier: t('sim') }, (ctx) => {
    ctx.cache = null
    const who = ctx.user?.uid || clientIp(ctx.req)
    const lim = simLimiter.take(who)
    if (!lim.ok) throw new ApiError(429, 'rate', 'A few seconds between simulations, please.', { retryAfter: lim.retryAfter })
    const body = ctx.req.body || {}
    const ids = Array.isArray(body.legs) ? [...new Set(body.legs.map(String))] : []
    if (!ids.length || ids.length > 12) throw new ApiError(400, 'bad_legs', 'Simulate 1 to 12 legs.')
    const { rows, missing } = legRows(ids)
    if (missing.length) throw new ApiError(404, 'no_prop', `${missing.length === 1 ? 'One leg isn’t' : `${missing.length} legs aren’t`} on the board anymore. Remove ${missing.length === 1 ? 'it' : 'them'} and try again.`, { legs: missing })
    const iterations = [10_000, 25_000, 50_000, 100_000].includes(Number(body.iterations)) ? Number(body.iterations) : 10_000
    const price = Number.isFinite(Number(body.price)) && Math.abs(Number(body.price)) >= 100 ? Math.round(Number(body.price)) : null
    const bets = Math.min(1000, Math.max(10, Math.round(Number(body.bets) || 100)))
    const seed = Math.floor(Math.random() * 2 ** 31)
    return { ...simulateSlip(rows, { iterations, price, bets, seed }), at: Date.now() }
  })

  /**
   * Who may spend an AI read: Pro and Elite with the paywall on, an invited user while it's off
   * (open in local dev without Firebase). Takes one read off today's allowance; `refund()` gives
   * it back when nothing was produced.
   */
  async function aiGate(req, res, { what = 'AI reads', limiterFor = insightLimiter, charge = true } = {}) {
    let user
    let ent
    if (paywallOn()) {
      const a = await access.resolve(req)
      if (!a.user) throw new ApiError(401, 'signin', `Sign in to use ${what}.`, { need: 'pro' })
      if (!atLeast(a.tier, 'pro')) throw new ApiError(402, 'upgrade', `${what[0].toUpperCase()}${what.slice(1)} are part of Pro and Elite.`, { need: 'pro', plan: a.tier, status: a.ent.status })
      user = a.user
      ent = a.ent
    } else if (authMode() === 'optional') {
      // local `npm run dev` without Firebase: the AI is open, like the analyzer
      user = (await auth.identify(req).catch(() => null)) || { uid: `dev:${clientIp(req)}` }
    } else {
      user = await auth.authenticate(req)
      if (!(await auth.inviteVerified(user))) throw new ApiError(403, 'invite', `Redeem an invite code to use ${what}.`)
    }
    if (!charge) return { user, refund: async () => {} }
    const lim = limiterFor.take(user.uid)
    if (!lim.ok) throw new ApiError(429, 'slow_down', 'One at a time. Try again in a few seconds.', { retryAfter: lim.retryAfter })
    let usage = null
    if (paywallOn()) {
      usage = await billing.useQuota(user, ent, 'aiReads')
      if (usage.limit != null) res.setHeader('X-Apex-Usage', `${usage.used}/${usage.limit}`)
    }
    return {
      user,
      refund: async () => {
        if (paywallOn() && usage) await billing.refundQuota(user, 'aiReads').catch(() => {})
      },
    }
  }
  const key = () => (typeof anthropicKey === 'function' ? anthropicKey() : anthropicKey)
  const intel = createIntel({ engine, apiKey: key })

  /**
   * Game intel: official injuries plus this week's reputable public reporting, tied to the props
   * it moves. One shared scan per game (cached); a fresh scan uses one AI read.
   */
  r.post('/intel', { selfAuth: true }, async (ctx) => {
    const { req, res } = ctx
    ctx.cache = null
    const gameId = String(req.body?.gameId || '')
    if (!/^\d{6,12}$/.test(gameId)) throw new ApiError(400, 'bad_game', 'That game id is not valid.')
    if (!views.game(gameId)) throw new ApiError(404, 'not_found', 'That game is not on the schedule.')
    const hit = intel.cachedFor(gameId)
    const wantFresh = req.body?.fresh === true && (!hit || Date.now() - hit.at > 15 * 60e3)
    if (hit && !wantFresh) {
      await aiGate(req, res, { what: 'game intel', charge: false })
      return { ...hit.data, at: hit.at, cached: true }
    }
    if (!key()) throw new ApiError(503, 'ai_off', 'AI is not configured on this server (ANTHROPIC_API_KEY).')
    const gate = await aiGate(req, res, { what: 'game intel', limiterFor: intelLimiter })
    try {
      const e = await intel.get(gameId, { fresh: wantFresh })
      if (e?.cached) await gate.refund()
      return { ...e.data, at: e.at, cached: Boolean(e.cached) }
    } catch {
      await gate.refund()
      throw new ApiError(502, 'intel_failed', 'The intel scan failed. Your allowance was not used; try again in a minute.')
    }
  })

  /** Line shopping for a slip: every book's price per leg and for the parlay, with links. Free. */
  r.post('/shop', { tier: t('shop') }, (ctx) => {
    ctx.cache = null
    const body = ctx.req.body || {}
    const ids = Array.isArray(body.legs) ? [...new Set(body.legs.map(String))] : []
    if (!ids.length || ids.length > 12) throw new ApiError(400, 'bad_legs', 'Shop 1 to 12 legs.')
    const { raw, missing } = legRows(ids)
    if (missing.length) throw new ApiError(404, 'no_prop', 'One of those legs isn’t on the board anymore.', { legs: missing })
    // "oddsFeed": the many-book feed is on for every league on the slip (without it, the prices
    // are the one book ESPN carries)
    const keys = [...new Set(ids.map((x) => (String(x).includes(':') ? String(x).split(':')[0] : home)))]
    const feed = keys.every((k) => Boolean(engineFor(k)?.status().odds?.enabled))
    return { ...shop(raw), oddsFeed: feed, at: engine.wh.at.odds || null }
  })

  // ---- the 3-Leg Lock ---------------------------------------------------------------------------
  const ledger = createLedger({ engine, store: engine.store, now: engine.now })
  const tickLedger = () => ledger.maybeTick().catch(() => {})

  /** This week's lock under the APEX rules (or a Pass, with the reason). Pro. */
  r.get('/lock', { tier: t('lock'), cache: C(30, 30, 120) }, async () => {
    const out = views.lock()
    await ledger.record(out).catch(() => {})
    tickLedger()
    return out
  })

  /**
   * The season ledger. Free: the record is public. This week's lock stays hidden from free
   * plans until its first leg kicks off.
   */
  r.get('/lock/ledger', { tier: 'free', cache: C(30, 30, 120) }, async (ctx) => {
    // this week's entry exists even before anyone with Pro opens the lock
    await ledger.record(views.lock()).catch(() => {})
    await tickLedger()
    const out = await ledger.season()
    const a = await accessFor(ctx.req).catch(() => ({ tier: 'free' }))
    const full = atLeast(a.tier, 'pro')
    if (paywallOn()) ctx.cache = { ...C(30, 30, 120), priv: true }
    return {
      ...out,
      weeks: out.weeks.map((w) => (full || w.frozen || !w.lock ? w : { ...w, lock: { hidden: true, legs: w.lock.legs.length } })),
      full,
    }
  })

  /** AI read of one prop. Pro and Elite (or the invite rule while the paywall is off). */
  r.post('/insight', { selfAuth: true }, async (ctx) => {
    const { req, res } = ctx
    ctx.cache = null
    const propId = String(req.body?.propId || '')
    if (!parsePropId(propId)) throw new ApiError(400, 'bad_prop', 'That prop id is not valid.')
    const gate = await aiGate(req, res)
    const out = await streamPropInsight({ propId, views, res, apiKey: key(), sport: engine.sport })
    if (!out.produced) await gate.refund()
    return RAW
  })

  /**
   * Parlay check: legs from the board, typed out, or a betslip screenshot. Reads the slip,
   * matches it to the board, simulates it, then the AI keeps or cuts each leg. One AI read.
   */
  r.post('/check', { selfAuth: true }, async (ctx) => {
    const { req, res } = ctx
    ctx.cache = null
    const body = req.body || {}
    const ids = Array.isArray(body.legs) ? [...new Set(body.legs.map(String))].slice(0, 12) : []
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
    const image = body.image ? cleanImage(body.image) : null
    if (body.image && !image) throw new ApiError(400, 'bad_image', 'Upload a JPEG, PNG or WebP screenshot under 1.2 MB.')
    if (!ids.length && !text && !image) throw new ApiError(400, 'empty', 'Add legs from the board, paste your slip, or upload a screenshot.')
    // slip legs can come from several leagues ("nba:<id>"); each is read on its own league's board
    const refs = ids.map((ref) => {
      const i = ref.indexOf(':')
      const k = i > 0 ? ref.slice(0, i) : home
      return { ref, key: k, id: i > 0 ? ref.slice(i + 1) : ref, eng: engineFor(k) }
    })
    if (refs.some((x) => !x.eng || !parsePropId(x.id))) throw new ApiError(400, 'bad_legs', 'One of those legs is not a valid prop.')
    const apiKey = key()
    if (!apiKey) throw new ApiError(503, 'ai_off', 'AI is not configured on this server (ANTHROPIC_API_KEY).')
    const gate = await aiGate(req, res, { what: 'parlay checks', limiterFor: checkLimiter })
    let matched = refs.map((x) => ({ id: x.id, key: x.key, eng: x.eng, ref: x.ref, odds: null }))
    let unmatched = []
    let notes = ''
    let parlayOdds = Number.isFinite(Number(body.price)) && Math.abs(Number(body.price)) >= 100 ? Math.round(Number(body.price)) : null
    const prices = body.prices && typeof body.prices === 'object' ? body.prices : {}
    const priceOf = (m) => Number(prices[m.ref ?? m.id] ?? prices[m.id])
    matched = matched.map((m) => ({ ...m, odds: Number.isFinite(priceOf(m)) && Math.abs(priceOf(m)) >= 100 ? Math.round(priceOf(m)) : null }))
    try {
      if (text || image) {
        const ex = await extractLegs({ apiKey, text, image, sport: engine.sport })
        const found = matchLegs(ex.legs, engine)
        const seen = new Set(matched.map((m) => `${m.key}:${m.id}`))
        matched = [...matched, ...found.matched.filter((m) => !seen.has(`${home}:${m.id}`)).map((m) => ({ ...m, key: home, eng: engine }))].slice(0, 12)
        unmatched = found.unmatched
        notes = ex.notes
        if (parlayOdds == null) parlayOdds = ex.parlayOdds
      }
      matched = matched.filter((m) => (m.eng || engine).views.findProp(m.id))
    } catch (e) {
      await gate.refund()
      throw e instanceof ApiError ? e : new ApiError(502, 'read_failed', 'Could not read that slip. Try again, or paste it as text.')
    }
    if (!matched.length) {
      await gate.refund()
      throw new ApiError(422, 'no_legs', unmatched.length ? 'None of those legs are on the board right now.' : `No ${engine.sport?.name || 'NFL'} player props found on that slip.`, { unmatched, notes })
    }
    const out = await streamParlayCheck({ engine, matched, unmatched, parlayOdds, notes, res, apiKey })
    if (!out.produced) await gate.refund()
    return RAW
  })

  return r
}

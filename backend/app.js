// The APEX API as one Express app, shared by backend/server.js (always-on daemon) and
// functions/index.js (Cloud Functions, lazy engine).
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import { createHttp } from './src/lib/http.js'
import { createAi, chatWebSearch, scrubKeys } from './src/ai/llm.js'
import { createStore } from './src/lib/store.js'
import { createHub } from './src/lib/hub.js'
import { log, errText } from './src/lib/log.js'
import { ApiError, clientIp } from './src/lib/router.js'
import { createEngine, oddsLeagues } from './src/nfl/engine.js'
import { createNflRouter } from './src/nfl/routes.js'
import { SPORTS, SPORT_KEYS } from './src/sports/index.js'
import { createBilling, atLeast } from './src/billing/service.js'
import { billingConfig } from './src/billing/config.js'
import { billingRoutes } from './src/billing/routes.js'
import { createPicks } from './src/picks/service.js'
import { picksRoutes } from './src/picks/routes.js'
import { createAccess } from './src/security/access.js'
import { defaultAuthInstance, authMode } from './src/security/auth.js'
import { createLimiter } from './src/security/rateLimit.js'
import { parseChatBody, handleChatStream, setGameContextProvider } from './streamChat.js'
import { registerAdminSportsRoutes } from './adminSportsRoutes.js'
import { getDisabledSportKeys } from './sportsConfig.js'
import {
  handleMlbPlayerPropsShowcaseRequest,
  handleMlbPlayerPropsBoardRequest,
  handleMlbPropLadderRequest,
  handleOddsEventsRequest,
  handleOddsUpcomingRequest,
  setOddsBudget,
} from './oddsEvents.js'
import { takeOddsCredits } from './src/lib/oddsBudget.js'
import { oddsKeys, splitKeys } from './src/providers/oddsapi/keys.js'
import { nameKey, envInt } from './src/lib/util.js'
import { renderUserHead } from './src/picks/og.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The built site's index.html, when it ships next to the API (Cloud Functions: copied to
// functions/apex/web/ at deploy) so shared /u/handle links get their own preview card.
const WEB_INDEX = process.env.APEX_WEB_INDEX || path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'index.html')
let webIndex
function indexHtml() {
  if (webIndex === undefined) {
    try {
      webIndex = fs.readFileSync(WEB_INDEX, 'utf8')
    } catch {
      webIndex = null
    }
  }
  return webIndex
}

async function lookupUidByEmail(email) {
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    if (!getApps().length) initializeApp()
    const u = await getAuth().getUserByEmail(email)
    return u?.uid || null
  } catch {
    return null
  }
}

function corsOptions() {
  const extra = String(process.env.APEX_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const dev = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/]
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true) // same-origin (Hosting rewrites) and server-to-server
      if (dev.some((re) => re.test(origin)) || extra.includes(origin) || /\.web\.app$|\.firebaseapp\.com$/.test(new URL(origin).hostname)) return cb(null, true)
      cb(null, false)
    },
    exposedHeaders: ['ETag', 'Retry-After', 'X-Apex-Usage'],
    maxAge: 600,
  }
}

/** Plain-text APEX data for the AI game analyzer (NFL only). */
/** APEX_SPORTS=nfl,nba,... picks the leagues (all of them by default). */
function enabledSports() {
  const raw = String(process.env.APEX_SPORTS || '').trim()
  const list = raw ? raw.split(',').map((x) => x.trim().toLowerCase()).filter((x) => SPORT_KEYS.includes(x)) : SPORT_KEYS
  return [...new Set(['nfl', ...list])]
}

function gameContextFrom(engine) {
  return (game) => {
    const wh = engine.wh
    const want = [nameKey(game.homeTeam), nameKey(game.awayTeam)]
    const g = [...wh.games.values()].find((x) => want.includes(nameKey(x.home?.name)) && want.includes(nameKey(x.away?.name)))
    if (!g) return ''
    const view = engine.views.game(g.id)
    if (!view) return ''
    const lines = []
    if (view.odds) lines.push(`Market: ${view.odds.details || ''} | total ${view.odds.total ?? '?'} | ML ${view.odds.homeMl ?? '?'} / ${view.odds.awayMl ?? '?'}`)
    for (const side of [view.away, view.home]) {
      lines.push(`${side.team.abbr} ${side.form?.record || ''} (${side.form?.ppg ?? '?'} pts for, ${side.form?.papg ?? '?'} against per game). Last 5: ${(side.form?.last5 || []).map((x) => x.result).join('')}`)
      const inj = side.injuries.filter((i) => i.severity === 'out' || i.severity === 'doubtful').slice(0, 8)
      if (inj.length) lines.push(`  Out/doubtful: ${inj.map((i) => `${i.name} (${i.pos}, ${i.status})`).join(', ')}`)
      for (const t of side.trends.slice(0, 3)) lines.push(`  Trend: ${t.text}`)
    }
    lines.push('Top APEX props (probability, fair odds, recent hit rates):')
    for (const p of view.props.slice(0, 18)) lines.push(`  ${p.name} (${p.pos} ${p.teamAbbr}) ${p.label}: ${(p.prob * 100).toFixed(0)}%, fair ${p.fair}, L5 ${p.l5 ? `${p.l5.hits}/${p.l5.n}` : '-'}, L10 ${p.l10 ? `${p.l10.hits}/${p.l10.n}` : '-'}, score ${p.score}`)
    return lines.join('\n')
  }
}

export function createApexApp({
  engineMode = 'daemon',
  getFirestore,
  store: storeIn,
  auth = defaultAuthInstance,
  billing: billingIn,
  http: httpIn,
  // the AI: OpenAI when its key is set, else Anthropic (see src/ai/llm.js)
  openaiKey = () => process.env.OPENAI_API_KEY,
  anthropicKey = () => process.env.ANTHROPIC_API_KEY,
  ai: aiIn,
  adminKey = () => process.env.ADMIN_SPORTS_KEY,
  // THE_ODDS_API_KEY, then THE_ODDS_API_KEY_BACKUP for when the first is refused or out of credits
  oddsKey = () => oddsKeys().join(','),
  now,
} = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(cors(corsOptions()))
  app.use(express.json({ limit: '2mb' }))
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    next()
  })

  const http = httpIn || createHttp({})
  const ai = aiIn || createAi({ openaiKey, anthropicKey })
  const engineStore = storeIn || createStore({ getFirestore })
  // streams per instance: room left for ordinary requests on Cloud Functions (250 slots) and
  // under Vercel's 1,024 open files per instance
  const hub = createHub({ maxClients: envInt('APEX_MAX_STREAMS', process.env.K_SERVICE ? 180 : process.env.VERCEL ? 400 : 2000, { min: 1, max: 100_000 }), maxPerOwner: envInt('APEX_MAX_STREAMS_PER_IP', 6, { min: 1, max: 1000 }) })
  let oddsApiKey = null
  try {
    oddsApiKey = oddsKey() || null
  } catch {
    oddsApiKey = null
  }
  const engine = createEngine({ mode: engineMode, http, store: engineStore, hub, oddsApiKey, ...(now ? { now } : {}) })
  // the other leagues: same engine and analytics, their own live hub, started on first use
  const engines = { nfl: engine }
  for (const key of enabledSports()) {
    if (key === 'nfl') continue
    const h = createHub({ maxClients: envInt('APEX_MAX_STREAMS_OTHER', process.env.K_SERVICE ? 60 : process.env.VERCEL ? 120 : 600, { min: 1, max: 100_000 }), maxPerOwner: envInt('APEX_MAX_STREAMS_PER_IP', 6, { min: 1, max: 1000 }) })
    engines[key] = createEngine({ mode: engineMode === 'daemon' ? 'lazy' : engineMode, http, store: engineStore, hub: h, sport: key, oddsApiKey, ...(now ? { now } : {}) })
  }
  const billing = billingIn || createBilling({ getFirestore, store: engineStore, lookupUid: lookupUidByEmail, ...(now ? { now } : {}) })
  const access = createAccess({ auth, billing })
  const picks = createPicks({ docs: billing.docs, engine, engines, billing, ...(now ? { now } : {}) })
  billing.onChange((uid) => {
    picks.syncPlan(uid).catch((e) => log.warn('plan sync failed', { uid, err: errText(e) }))
  })
  setGameContextProvider(gameContextFrom(engine))

  for (const [key, eng] of Object.entries(engines)) {
    const router = createNflRouter(eng, { ai, auth, access, billing, engines })
    app.use(`/api/${key}`, (req, res, next) => {
      router.handle(req, res, next).catch(next)
    })
  }
  app.get('/api/sports', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60, s-maxage=120').json({ sports: Object.keys(engines).map((k) => ({ key: k, name: SPORTS[k].name, title: SPORTS[k].title, calendar: SPORTS[k].calendar, offseason: SPORTS[k].offseason })) })
  })
  app.use('/api/billing', billingRoutes({ billing, access, getDb: () => (typeof getFirestore === 'function' ? getFirestore() || null : null), now: now || Date.now }))
  app.use('/api/picks', picksRoutes({ picks, access }))

  // ---- the AI analyzer (chat) ---------------------------------------------------------------
  const chatHourly = createLimiter({ burst: envInt('APEX_CHAT_PER_HOUR', 12, { min: 1, max: 1000 }), perSec: envInt('APEX_CHAT_PER_HOUR', 12, { min: 1, max: 1000 }) / 3600 })
  const adminHourly = createLimiter({ burst: envInt('APEX_CHAT_PER_HOUR', 12, { min: 1, max: 1000 }) * 10, perSec: (envInt('APEX_CHAT_PER_HOUR', 12, { min: 1, max: 1000 }) * 10) / 3600 })

  // A follow-up has to continue an analysis this user actually ran: the server built that
  // first message, so its fingerprint is remembered for two days and each analysis allows a
  // limited number of follow-ups. A made-up history can't spend the follow-up allowance.
  const THREAD_MS = 48 * 3600_000
  const followupsPerThread = () => envInt('APEX_FOLLOWUPS_PER_ANALYSIS', 10, { min: 1, max: 100 })
  const fingerprint = (text) => crypto.createHash('sha256').update(String(text)).digest('base64url').slice(0, 22)
  // mode: 'start' (an analysis registers its prompt), 'use' (a follow-up spends one of its
  // follow-ups), 'drop' / 'undo' (the call failed: take it back)
  async function thread(uid, first, mode) {
    const fp = fingerprint(first)
    let verdict = 'ok'
    await engineStore.update('chatThreads', uid, (cur) => {
      verdict = 'ok'
      const t = Date.now()
      const list = (cur?.list || []).filter((x) => t - x.at < THREAD_MS)
      const hit = list.find((x) => x.fp === fp)
      if (mode === 'start') {
        if (hit) return undefined
        list.push({ fp, at: t, n: 0 })
      } else if (mode === 'drop') {
        if (!hit) return undefined
        list.splice(list.indexOf(hit), 1)
      } else if (mode === 'undo') {
        if (!hit || !hit.n) return undefined
        hit.n--
      } else if (!hit) {
        verdict = 'unknown'
        return undefined
      } else if (hit.n >= followupsPerThread()) {
        verdict = 'full'
        return undefined
      } else hit.n++
      return { list: list.slice(-40) }
    })
    return verdict
  }
  // what a real conversation looks like: the analysis prompt, answers the model wrote (16k
  // tokens tops), and questions a person typed
  function followupShapeOk(messages) {
    if (!Array.isArray(messages) || messages.length < 3 || messages.length > 41) return false
    let total = 0
    for (let i = 0; i < messages.length; i++) {
      const c = typeof messages[i]?.content === 'string' ? messages[i].content : ''
      total += c.length
      const cap = i === 0 ? 100_000 : messages[i].role === 'assistant' ? 120_000 : 4_000
      if (c.length > cap) return false
    }
    return total <= 600_000
  }

  async function chatGate(req, res, next) {
    try {
      // What kind of call this is comes from how the prompt was built, never from the body: an
      // analysis prompt is written by the server from a few short game fields; anything else is
      // a follow-up and has to look like one.
      const parsed = parseChatBody(req)
      if (!parsed.ok) throw new ApiError(parsed.status, 'bad_request', parsed.error)
      req.apexParsed = parsed
      const kind = parsed.kind === 'analysis' ? 'analyses' : 'followups'
      const first = parsed.messagesForApi[0].content
      if (kind === 'followups' && !followupShapeOk(req.body?.messages)) throw new ApiError(400, 'bad_followup', 'Start with a game analysis, then ask follow-ups. Keep each question under 4,000 characters.')
      let user = null
      let ent = null
      if (billingConfig().paywall) {
        const a = await access.resolve(req)
        if (!a.user) throw new ApiError(401, 'signin', 'Sign in to use the AI analyzer.', { need: 'pro' })
        if (!atLeast(a.tier, 'pro')) throw new ApiError(402, 'upgrade', 'The AI analyzer is part of Pro and Elite.', { need: 'pro', plan: a.tier, status: a.ent.status })
        user = a.user
        ent = a.ent
      } else if (authMode() !== 'optional') {
        user = await auth.authenticate(req)
        if (!(await auth.inviteVerified(user))) throw new ApiError(403, 'invite', 'Redeem an invite code to use the AI analyzer.')
      }
      if (user) {
        const lim = (user.admin ? adminHourly : chatHourly).take(user.uid)
        if (!lim.ok) throw new ApiError(429, 'slow_down', 'That is a lot of analyses this hour. Take a breather and try again soon.', { retryAfter: lim.retryAfter })
      }
      if (ent) {
        if (kind === 'followups') {
          const v = await thread(user.uid, first, 'use')
          if (v === 'unknown') throw new ApiError(400, 'bad_followup', 'Follow-ups continue an analysis you ran in the last two days. Start a new analysis first.')
          if (v === 'full') throw new ApiError(429, 'thread_full', `That analysis has had its ${followupsPerThread()} follow-ups. Start a new one to keep going.`)
        }
        let u
        try {
          u = await billing.useQuota(user, ent, kind)
        } catch (e) {
          if (kind === 'followups') await thread(user.uid, first, 'undo').catch(() => {})
          throw e
        }
        if (u.limit != null) res.setHeader('X-Apex-Usage', `${u.used}/${u.limit}`)
        req.apexQuota = { kind, user }
        req.apexThread = { uid: user.uid, first, kind }
        if (kind === 'analyses') await thread(user.uid, first, 'start')
      }
      next()
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500
      if (e instanceof ApiError && e.extra?.retryAfter) res.setHeader('Retry-After', String(e.extra.retryAfter))
      res.status(status).set('Cache-Control', 'no-store').json({ error: e.message || 'Error', code: e.code || 'internal', ...(e.extra || {}) })
    }
  }

  /** A call that produced nothing gives its allowance back, and a failed analysis can't be continued. */
  async function refundIfEmpty(req, out) {
    if (out?.produced) return
    if (req.apexQuota) await billing.refundQuota(req.apexQuota.user, req.apexQuota.kind).catch(() => {})
    if (req.apexThread) await thread(req.apexThread.uid, req.apexThread.first, req.apexThread.kind === 'analyses' ? 'drop' : 'undo').catch(() => {})
  }

  app.post('/api/chat/stream', chatGate, async (req, res) => {
    const out = await handleChatStream(req, res, ai)
    await refundIfEmpty(req, out)
  })

  async function chatOnce(req, res) {
    if (!ai.ready()) {
      await refundIfEmpty(req, null)
      return res.status(503).json({ error: 'AI is not configured on this server (OPENAI_API_KEY).' })
    }
    const parsed = req.apexParsed || parseChatBody(req)
    if (!parsed.ok) {
      await refundIfEmpty(req, null)
      return res.status(parsed.status).json({ error: parsed.error })
    }
    const disabled = await getDisabledSportKeys()
    if (parsed.resolvedSportKey && disabled.includes(parsed.resolvedSportKey)) {
      await refundIfEmpty(req, null)
      return res.status(403).json({ error: 'This sport is temporarily unavailable.' })
    }
    const { messagesForApi, maxTokens, system } = parsed
    try {
      const out = await ai.complete({ feature: 'chat', system, messages: messagesForApi, maxTokens, webSearch: chatWebSearch() })
      const text = out.text
      await refundIfEmpty(req, { produced: text.trim().length > 0 })
      return res.json({ text, messages: [...messagesForApi, { role: 'assistant', content: text }], model: out.model, id: out.id, usage: out.usage })
    } catch (e) {
      await refundIfEmpty(req, null)
      const status = e?.status >= 400 && e?.status < 600 ? e.status : 502
      return res.status(status).json({ error: scrubKeys(e?.message || String(e)) })
    }
  }
  app.post('/api/chat', chatGate, chatOnce)
  // Older Cloud Functions builds were mounted at the function root.
  app.post('/', chatGate, chatOnce)

  // ---- multi-sport odds endpoints from the original app ----------------------------------------
  // Paid upstream calls come out of their own daily credit pool (APEX_ODDS_ANALYZER_DAILY_CREDITS),
  // separate from the NFL board's, and each address gets a modest request rate.
  // Each caller also gets a share: a few games a day whose odds nobody had opened yet (opened
  // ones are cached for everyone). Signed-in callers count by account, others by address.
  const callerKey = async (req) => {
    if (!req) return null
    if (req.apexOddsCaller !== undefined) return req.apexOddsCaller
    const user = req.headers?.authorization ? await auth.identify(req).catch(() => null) : null
    const ip = crypto.createHash('sha256').update(String(clientIp(req))).digest('base64url').slice(0, 16)
    req.apexOddsCaller = user?.uid ? `u_${user.uid}` : `ip_${ip}`
    return req.apexOddsCaller
  }
  setOddsBudget(async (cost, { req } = {}) => {
    const daily = envInt('APEX_ODDS_ANALYZER_DAILY_CREDITS', 500, { min: 0, max: 1_000_000 })
    const who = await callerKey(req)
    const share = who?.startsWith('u_') ? envInt('APEX_ODDS_NEW_GAMES_PER_USER', 6, { min: 0, max: 1000 }) : envInt('APEX_ODDS_NEW_GAMES_PER_IP', 2, { min: 0, max: 1000 })
    const mine = (n) => (who ? takeOddsCredits(engineStore, n, { pool: `analyzer_${who}`, daily: share }) : { ok: true })
    if (cost < 0) {
      await mine(-1)
      return (await takeOddsCredits(engineStore, cost, { pool: 'analyzer', daily })).ok
    }
    if (!(await mine(1)).ok) return { ok: false, reason: 'caller' }
    if ((await takeOddsCredits(engineStore, cost, { pool: 'analyzer', daily })).ok) return { ok: true }
    await mine(-1)
    return { ok: false, reason: 'pool' }
  })
  const oddsLimit = createLimiter({ burst: 40, perSec: 0.5 })
  app.use('/api/odds', (req, res, next) => {
    const t = oddsLimit.take(clientIp(req))
    if (t.ok) return next()
    res.set('Retry-After', String(t.retryAfter)).set('Cache-Control', 'no-store').status(429).json({ error: 'Too many requests. Slow down a moment.', code: 'rate' })
  })
  const odds = () => oddsKey()
  app.get('/api/odds/events', (req, res) => void handleOddsEventsRequest(req, res, odds()))
  app.get('/api/odds/upcoming', (req, res) => void handleOddsUpcomingRequest(req, res, odds()))
  app.get('/api/odds/mlb-player-props-showcase', (req, res) => void handleMlbPlayerPropsShowcaseRequest(req, res, odds()))
  app.get('/api/odds/mlb-prop-ladder', (req, res) => void handleMlbPropLadderRequest(req, res, odds()))
  app.get('/api/odds/mlb-player-props-board', (req, res) => void handleMlbPlayerPropsBoardRequest(req, res, odds()))

  registerAdminSportsRoutes(app, { getAdminKey: adminKey, getFirestore })

  // Picks pages with a preview card of their own (see src/picks/og.js).
  // The public address for preview cards: APEX_PUBLIC_SITE_URL, else the Hosting domain the
  // request came through when it's one of ours (this project's web.app / firebaseapp.com, or an
  // APEX_ALLOWED_ORIGINS entry), else this project's web.app. A forged header can't point a
  // card at someone else's site.
  function publicSite(req) {
    if (process.env.APEX_PUBLIC_SITE_URL) return process.env.APEX_PUBLIC_SITE_URL.replace(/\/$/, '')
    // Vercel only routes a host here if it's one of this project's domains
    if (process.env.VERCEL) {
      const h = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase()
      if (/^[a-z0-9.-]+(:\d+)?$/.test(h)) return `https://${h}`
      if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    }
    const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
    const known = new Set(String(process.env.APEX_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()).filter(Boolean))
    if (project) {
      known.add(`${project}.web.app`)
      known.add(`${project}.firebaseapp.com`)
    }
    const host = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase()
    if (host && known.has(host)) return `https://${host}`
    return project ? `https://${project}.web.app` : ''
  }
  // Without a bundled copy (a functions-only deploy that skipped the build), borrow the live
  // site's index.html from Hosting, which serves it as a plain file.
  let remoteIndex = { at: 0, html: null }
  async function siteIndex(req) {
    const local = indexHtml()
    if (local) return local
    if (remoteIndex.html && Date.now() - remoteIndex.at < 10 * 60_000) return remoteIndex.html
    const site = publicSite(req)
    if (!site) return null
    try {
      const r = await fetch(`${site}/index.html`, { signal: AbortSignal.timeout(5000) })
      const html = r.ok ? await r.text() : null
      if (html && /<html/i.test(html)) remoteIndex = { at: Date.now(), html }
    } catch {
      /* keep whatever we had */
    }
    return remoteIndex.html
  }
  const previewLimit = createLimiter({ burst: 60, perSec: 2 })
  app.get('/u/:handle', async (req, res, next) => {
    const html = await siteIndex(req)
    // no copy of the site to hand out: send the browser to the app, which opens the page itself
    if (!html) {
      const h = String(req.params.handle || '').toLowerCase()
      return /^[a-z0-9_]{3,20}$/.test(h) ? res.redirect(302, `/?to=${encodeURIComponent(`/u/${h}`)}`) : next()
    }
    let out = html
    // past the limit the page still loads, just without its own card (no database reads)
    if (previewLimit.take(clientIp(req)).ok) {
      try {
        const view = await picks.page(req.params.handle)
        const site = publicSite(req)
        if (site) out = renderUserHead(html, view, site)
      } catch {
        /* unknown handle: the app shows its own not-found */
      }
    }
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300').type('html').send(out)
  })

  // whether a key is set, never the key
  const isSet = (get) => {
    try {
      return get() || ''
    } catch {
      return ''
    }
  }
  app.get('/api/health', (req, res) => {
    const s = engine.status()
    const cfg = billingConfig()
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      // the address rate limits see for you: after deploying it should be your own public IP,
      // through the site and through the function URL alike (see APEX_TRUSTED_PROXIES)
      you: clientIp(req),
      database: process.env.APEX_EPHEMERAL !== '1',
      engine: { mode: s.mode, week: s.week, games: s.games, live: s.live, props: s.props, logs: s.logs, at: s.at },
      sports: Object.keys(engines),
      billing: { paywall: cfg.paywall, network: cfg.network, treasury: Boolean(cfg.treasury), docs: billing.docsKind },
      auth: authMode(),
      ai: ai.ready(),
      aiProvider: ai.provider(),
      odds: { keys: splitKeys(isSet(oddsKey)).length, leagues: oddsLeagues() },
    })
  })

  app.use('/api', (req, res) => res.status(404).set('Cache-Control', 'no-store').json({ error: 'Not found', code: 'not_found' }))
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON body.', code: 'bad_json' })
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.', code: 'too_large' })
    log.error('unhandled', { path: req.path, err: errText(err) })
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our side.', code: 'internal' })
  })

  if (engineMode === 'daemon') {
    const t = setInterval(() => picks.maybeGrade(), 3 * 60_000)
    t.unref?.()
  }
  return { app, engine, engines, billing, picks, hub, access }
}

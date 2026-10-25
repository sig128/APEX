// The APEX API as one Express app, shared by backend/server.js (always-on daemon) and
// functions/index.js (Cloud Functions, lazy engine).
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { createHttp } from './src/lib/http.js'
import { createStore } from './src/lib/store.js'
import { createHub } from './src/lib/hub.js'
import { log, errText } from './src/lib/log.js'
import { ApiError, clientIp } from './src/lib/router.js'
import { createEngine } from './src/nfl/engine.js'
import { createNflRouter } from './src/nfl/routes.js'
import { createBilling, atLeast } from './src/billing/service.js'
import { billingConfig } from './src/billing/config.js'
import { billingRoutes } from './src/billing/routes.js'
import { createPicks } from './src/picks/service.js'
import { picksRoutes } from './src/picks/routes.js'
import { createAccess } from './src/security/access.js'
import { defaultAuthInstance, authMode } from './src/security/auth.js'
import { createLimiter } from './src/security/rateLimit.js'
import { parseChatBody, handleChatStream, extractTextFromMessage, setGameContextProvider } from './streamChat.js'
import { getAnthropicWebSearchTools } from './anthropicWebTools.js'
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
  anthropicKey = () => process.env.ANTHROPIC_API_KEY,
  adminKey = () => process.env.ADMIN_SPORTS_KEY,
  oddsKey = () => process.env.THE_ODDS_API_KEY,
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
  const engineStore = storeIn || createStore({ getFirestore })
  const hub = createHub({ maxClients: envInt('APEX_MAX_STREAMS', process.env.K_SERVICE ? 180 : 2000, { min: 1, max: 100_000 }), maxPerOwner: envInt('APEX_MAX_STREAMS_PER_IP', 6, { min: 1, max: 1000 }) })
  let oddsApiKey = null
  try {
    oddsApiKey = oddsKey() || null
  } catch {
    oddsApiKey = null
  }
  const engine = createEngine({ mode: engineMode, http, store: engineStore, hub, oddsApiKey, ...(now ? { now } : {}) })
  const billing = billingIn || createBilling({ getFirestore, store: engineStore, lookupUid: lookupUidByEmail, ...(now ? { now } : {}) })
  const access = createAccess({ auth, billing })
  const picks = createPicks({ docs: billing.docs, engine, billing, ...(now ? { now } : {}) })
  billing.onChange((uid) => {
    picks.syncPlan(uid).catch((e) => log.warn('plan sync failed', { uid, err: errText(e) }))
  })
  setGameContextProvider(gameContextFrom(engine))

  const nfl = createNflRouter(engine, { anthropicKey, auth, access, billing })
  app.use('/api/nfl', (req, res, next) => {
    nfl.handle(req, res, next).catch(next)
  })
  app.use('/api/billing', billingRoutes({ billing, access }))
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
  async function thread(uid, first, start) {
    const fp = fingerprint(first)
    let verdict = 'ok'
    await engineStore.update('chatThreads', uid, (cur) => {
      verdict = 'ok'
      const t = Date.now()
      const list = (cur?.list || []).filter((x) => t - x.at < THREAD_MS)
      const hit = list.find((x) => x.fp === fp)
      if (start) {
        if (hit) return undefined
        list.push({ fp, at: t, n: 0 })
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
      let user = null
      if (billingConfig().paywall) {
        const a = await access.resolve(req)
        if (!a.user) throw new ApiError(401, 'signin', 'Sign in to use the AI analyzer.', { need: 'pro' })
        if (!atLeast(a.tier, 'pro')) throw new ApiError(402, 'upgrade', 'The AI analyzer is part of Pro and Elite.', { need: 'pro', plan: a.tier, status: a.ent.status })
        user = a.user
        const kind = req.body?.game ? 'analyses' : 'followups'
        const parsed = parseChatBody(req)
        if (!parsed.ok) throw new ApiError(parsed.status, 'bad_request', parsed.error)
        req.apexParsed = parsed
        if (kind === 'followups') {
          if (!followupShapeOk(req.body?.messages)) throw new ApiError(400, 'bad_followup', 'Start with a game analysis, then ask follow-ups. Keep each question under 4,000 characters.')
          const v = await thread(user.uid, parsed.messagesForApi[0].content, false)
          if (v === 'unknown') throw new ApiError(400, 'bad_followup', 'Follow-ups continue an analysis you ran in the last two days. Start a new analysis first.')
          if (v === 'full') throw new ApiError(429, 'thread_full', `That analysis has had its ${followupsPerThread()} follow-ups. Start a new one to keep going.`)
        }
        const u = await billing.useQuota(user, a.ent, kind)
        if (u.limit != null) res.setHeader('X-Apex-Usage', `${u.used}/${u.limit}`)
        req.apexQuota = { kind, user }
        if (kind === 'analyses') await thread(user.uid, parsed.messagesForApi[0].content, true)
      } else if (authMode() !== 'optional') {
        user = await auth.authenticate(req)
        if (!(await auth.inviteVerified(user))) throw new ApiError(403, 'invite', 'Redeem an invite code to use the AI analyzer.')
      }
      if (user) {
        const lim = (user.admin ? adminHourly : chatHourly).take(user.uid)
        if (!lim.ok) {
          if (req.apexQuota) await billing.refundQuota(req.apexQuota.user, req.apexQuota.kind).catch(() => {})
          throw new ApiError(429, 'slow_down', 'That is a lot of analyses this hour. Take a breather and try again soon.', { retryAfter: lim.retryAfter })
        }
      }
      next()
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500
      if (e instanceof ApiError && e.extra?.retryAfter) res.setHeader('Retry-After', String(e.extra.retryAfter))
      res.status(status).set('Cache-Control', 'no-store').json({ error: e.message || 'Error', code: e.code || 'internal', ...(e.extra || {}) })
    }
  }

  async function refundIfEmpty(req, out) {
    if (req.apexQuota && !out?.produced) await billing.refundQuota(req.apexQuota.user, req.apexQuota.kind).catch(() => {})
  }

  app.post('/api/chat/stream', chatGate, async (req, res) => {
    const out = await handleChatStream(req, res, anthropicKey())
    await refundIfEmpty(req, out)
  })

  async function chatOnce(req, res) {
    const apiKey = anthropicKey()
    if (!apiKey) {
      await refundIfEmpty(req, null)
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' })
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
    const { messagesForApi, model, maxTokens, system } = parsed
    try {
      const anthropic = new Anthropic({ apiKey })
      const tools = getAnthropicWebSearchTools()
      const msg = await anthropic.messages.create({ model, max_tokens: maxTokens, system, messages: messagesForApi, ...(tools ? { tools } : {}) })
      const text = extractTextFromMessage(msg)
      await refundIfEmpty(req, { produced: text.trim().length > 0 })
      return res.json({ text, messages: [...messagesForApi, { role: 'assistant', content: text }], model, id: msg.id, usage: msg.usage })
    } catch (e) {
      await refundIfEmpty(req, null)
      const status = e?.status >= 400 && e?.status < 600 ? e.status : 502
      return res.status(status).json({ error: e?.message || String(e) })
    }
  }
  app.post('/api/chat', chatGate, chatOnce)
  // Older Cloud Functions builds were mounted at the function root.
  app.post('/', chatGate, chatOnce)

  // ---- multi-sport odds endpoints from the original app ----------------------------------------
  // Paid upstream calls come out of their own daily credit pool (APEX_ODDS_ANALYZER_DAILY_CREDITS),
  // separate from the NFL board's, and each address gets a modest request rate.
  setOddsBudget(async (cost) => (await takeOddsCredits(engineStore, cost, { pool: 'analyzer', daily: envInt('APEX_ODDS_ANALYZER_DAILY_CREDITS', 500, { min: 0, max: 1_000_000 }) })).ok)
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
    if (!html) return next()
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

  app.get('/api/health', (req, res) => {
    const s = engine.status()
    const cfg = billingConfig()
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      // the address rate limits see for you: after deploying it should be your own public IP,
      // through the site and through the function URL alike (see APEX_TRUSTED_PROXIES)
      you: clientIp(req),
      engine: { mode: s.mode, week: s.week, games: s.games, live: s.live, props: s.props, logs: s.logs, at: s.at },
      billing: { paywall: cfg.paywall, network: cfg.network, treasury: Boolean(cfg.treasury), docs: billing.docsKind },
      auth: authMode(),
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
  return { app, engine, billing, picks, hub, access }
}

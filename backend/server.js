import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import admin from 'firebase-admin'
import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicWebSearchTools } from './anthropicWebTools.js'
import { parseChatBody, extractTextFromMessage, handleChatStream } from './streamChat.js'
import {
  handleMlbPlayerPropsShowcaseRequest,
  handleMlbPlayerPropsBoardRequest,
  handleMlbPropLadderRequest,
  handleOddsEventsRequest,
  handleOddsUpcomingRequest,
} from './oddsEvents.js'
import { getDisabledSportKeys } from './sportsConfig.js'
import { registerAdminSportsRoutes } from './adminSportsRoutes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Always load backend/.env next to this file (not CWD-dependent). */
dotenv.config({ path: path.join(__dirname, '.env') })

const app = express()
app.use(cors({ origin: [/localhost:\d+$/, /127\.0\.0\.1:\d+$/] }))
app.use(express.json({ limit: '2mb' }))

let firestoreDb = null
try {
  if (!admin.apps.length) {
    admin.initializeApp()
  }
  firestoreDb = admin.firestore()
} catch {
  firestoreDb = null
}

registerAdminSportsRoutes(app, {
  getAdminKey: () => process.env.ADMIN_SPORTS_KEY,
  getFirestore: () => firestoreDb,
})

/**
 * POST /api/chat/stream — NDJSON live activity + text deltas (see streamChat.js).
 */
app.post('/api/chat/stream', (req, res) => {
  void handleChatStream(req, res, process.env.ANTHROPIC_API_KEY)
})

/**
 * GET /api/odds/events?q=…&sport=all|nfl|nba|mlb|nhl
 * Proxies The Odds API events (quota-free); API key stays on the server.
 */
app.get('/api/odds/events', (req, res) => {
  void handleOddsEventsRequest(req, res, process.env.THE_ODDS_API_KEY)
})

/** GET /api/odds/upcoming — all upcoming big-4 games (merged), for homepage carousel */
app.get('/api/odds/upcoming', (req, res) => {
  void handleOddsUpcomingRequest(req, res, process.env.THE_ODDS_API_KEY)
})

/** MLB player props ticker — The Odds API event odds + server-side cache */
app.get('/api/odds/mlb-player-props-showcase', (req, res) => {
  void handleMlbPlayerPropsShowcaseRequest(req, res, process.env.THE_ODDS_API_KEY)
})

/** MLB single-player O/U ladder (analyze results panel) */
app.get('/api/odds/mlb-prop-ladder', (req, res) => {
  void handleMlbPropLadderRequest(req, res, process.env.THE_ODDS_API_KEY)
})

/** MLB full player prop board — all O/U + Yes/No markets (main + alt merged) for suggested players */
app.get('/api/odds/mlb-player-props-board', (req, res) => {
  void handleMlbPlayerPropsBoardRequest(req, res, process.env.THE_ODDS_API_KEY)
})

/**
 * POST /api/chat
 * - New analysis: { game: { homeTeam, awayTeam, date, ... } }
 * - Follow-up: { messages: [ {role,user},{role,assistant},...,{role,user} ] }
 */
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(503).json({
      error:
        'ANTHROPIC_API_KEY is not set in backend/.env (the file the server loads).',
    })
  }

  const parsed = parseChatBody(req)
  if (!parsed.ok) {
    return res.status(parsed.status).json({ error: parsed.error })
  }

  const disabled = await getDisabledSportKeys()
  if (parsed.resolvedSportKey && disabled.includes(parsed.resolvedSportKey)) {
    return res.status(403).json({ error: 'This sport is temporarily unavailable.' })
  }

  const { messagesForApi, model, maxTokens, system } = parsed

  const started = Date.now()
  console.log('[api/chat] Anthropic request start', {
    model,
    maxTokens,
    webSearch: Boolean(getAnthropicWebSearchTools()),
  })

  try {
    const anthropic = new Anthropic({ apiKey })
    const tools = getAnthropicWebSearchTools()
    const msg = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: messagesForApi,
      ...(tools ? { tools } : {}),
    })

    const ms = Date.now() - started
    console.log('[api/chat] Anthropic response', {
      ms,
      sec: (ms / 1000).toFixed(1),
      stop_reason: msg?.stop_reason,
      id: msg?.id,
    })

    const assistantText = extractTextFromMessage(msg)
    const fullThread = [
      ...messagesForApi,
      { role: 'assistant', content: assistantText },
    ]

    return res.json({
      text: assistantText,
      messages: fullThread,
      model,
      id: msg.id,
      usage: msg.usage,
    })
  } catch (e) {
    const errMsg = e?.message || String(e)
    const status = e?.status >= 400 && e?.status < 600 ? e.status : 502
    console.error('Anthropic API error:', errMsg, { afterMs: Date.now() - started })
    return res.status(status).json({ error: errMsg })
  }
})

const PORT = parseInt(process.env.PORT || '8787', 10)
const server = app.listen(PORT, () => {
  console.log(`APEX API listening on http://localhost:${PORT}`)
})
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use (another APEX API still running?).\n` +
        `  Fix:  lsof -ti :${PORT} | xargs kill -9\n` +
        `  Or:   set PORT=8788 in backend/.env and the same port in frontend/vite.config.js proxy target.\n`,
    )
    process.exit(1)
  }
  throw err
})

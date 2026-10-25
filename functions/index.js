/**
 * Deploy (first time):
 * 1. Enable billing (Blaze) on the Firebase project.
 * 2. Enable Google Cloud "Secret Manager API" for the project (Console → APIs, or deploy will suggest a link).
 * 3. firebase functions:secrets:set ANTHROPIC_API_KEY   (paste key, same as backend/.env)
 *    firebase functions:secrets:set THE_ODDS_API_KEY     (The Odds API — schedule search)
 *    firebase functions:secrets:set ADMIN_SPORTS_KEY      (random string — /adminn sport toggles POST)
 * 4. If deploy fails with "missing permission on the build service account", run
 *    ./scripts/fix-cloud-functions-build-iam.sh (after gcloud auth login). See:
 *    https://cloud.google.com/functions/docs/troubleshooting#build-service-account
 * 5. npm run build --prefix frontend && firebase deploy
 *
 * Non-secret env for the `chat` worker (`ANTHROPIC_MAX_TOKENS`, `APEX_SYSTEM_PROMPT_MODE`):
 * set defaults in `defineString` below, override via `functions/.env` (see `functions/.env.example`).
 *
 * Web search: enabled by default (Anthropic server tool). Org must allow web search in
 * Claude Console → Privacy. Set ANTHROPIC_WEB_SEARCH=0 on the function to disable.
 *
 * Hosting rewrites POST /api/chat → this function, but Hosting has ~60s max wait; for long
 * Claude runs set frontend VITE_API_BASE to this function URL (see frontend/.env.example).
 * The function `timeoutSeconds` must exceed the longest ANALYZE (e.g. 1800s) or streams die
 * without a final NDJSON `complete` line.
 */
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret, defineString } from 'firebase-functions/params'
import express from 'express'
import cors from 'cors'
import { handleChat, handleChatStream } from './chatHandler.js'
import { redeemInvite } from './inviteRedeem.js'
import {
  handleMlbPlayerPropsShowcaseRequest,
  handleMlbPlayerPropsBoardRequest,
  handleMlbPropLadderRequest,
  handleOddsEventsRequest,
  handleOddsUpcomingRequest,
} from './oddsEvents.js'
import { registerAdminSportsRoutes } from './adminSportsRoutes.js'
import admin from 'firebase-admin'

export { redeemInvite }

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '2mb' }))

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY')
const theOddsApiKey = defineSecret('THE_ODDS_API_KEY')
const adminSportsKey = defineSecret('ADMIN_SPORTS_KEY')

/** Same semantics as `backend/.env` + `functions/.env` — available as `process.env.*` in `streamChat.js`. */
const anthropicMaxTokens = defineString('ANTHROPIC_MAX_TOKENS', { default: '16384' })
const apexSystemPromptMode = defineString('APEX_SYSTEM_PROMPT_MODE', { default: 'mid' })

function getFirestoreOrNull() {
  try {
    if (!admin.apps.length) {
      admin.initializeApp()
    }
    return admin.firestore()
  } catch (e) {
    console.error('firebase-admin init:', e)
    return null
  }
}

registerAdminSportsRoutes(app, {
  getAdminKey: () => {
    try {
      return adminSportsKey.value()
    } catch {
      return ''
    }
  },
  getFirestore: getFirestoreOrNull,
})

async function runChat(req, res) {
  let key
  try {
    key = anthropicApiKey.value()
  } catch (e) {
    console.error('ANTHROPIC_API_KEY secret access:', e)
    res.status(500).json({
      error:
        'Server misconfiguration: ANTHROPIC_API_KEY is not available. Run: firebase functions:secrets:set ANTHROPIC_API_KEY',
    })
    return
  }
  try {
    await handleChat(req, res, key)
  } catch (e) {
    console.error('handleChat:', e)
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  }
}

async function runChatStream(req, res) {
  let key
  try {
    key = anthropicApiKey.value()
  } catch (e) {
    console.error('ANTHROPIC_API_KEY secret access:', e)
    res.status(500).json({
      error:
        'Server misconfiguration: ANTHROPIC_API_KEY is not available. Run: firebase functions:secrets:set ANTHROPIC_API_KEY',
    })
    return
  }
  try {
    await handleChatStream(req, res, key)
  } catch (e) {
    console.error('handleChatStream:', e)
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  }
}

async function runOddsEvents(req, res) {
  let key
  try {
    key = theOddsApiKey.value()
  } catch (e) {
    console.error('THE_ODDS_API_KEY secret access:', e)
    res.status(503).json({
      error:
        'THE_ODDS_API_KEY is not available. Run: firebase functions:secrets:set THE_ODDS_API_KEY',
    })
    return
  }
  try {
    await handleOddsEventsRequest(req, res, key)
  } catch (e) {
    console.error('odds events:', e)
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  }
}

async function runOddsUpcoming(req, res) {
  let key
  try {
    key = theOddsApiKey.value()
  } catch (e) {
    console.error('THE_ODDS_API_KEY secret access:', e)
    res.status(503).json({
      error:
        'THE_ODDS_API_KEY is not available. Run: firebase functions:secrets:set THE_ODDS_API_KEY',
    })
    return
  }
  try {
    await handleOddsUpcomingRequest(req, res, key)
  } catch (e) {
    console.error('odds upcoming:', e)
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  }
}

async function runMlbPlayerPropsShowcase(req, res) {
  let key
  try {
    key = theOddsApiKey.value()
  } catch (e) {
    console.error('THE_ODDS_API_KEY secret access:', e)
    res.status(503).json({
      error:
        'THE_ODDS_API_KEY is not available. Run: firebase functions:secrets:set THE_ODDS_API_KEY',
    })
    return
  }
  try {
    await handleMlbPlayerPropsShowcaseRequest(req, res, key)
  } catch (e) {
    console.error('mlb player props showcase:', e)
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  }
}

app.get('/api/odds/events', (req, res) => {
  void runOddsEvents(req, res)
})

app.get('/api/odds/upcoming', (req, res) => {
  void runOddsUpcoming(req, res)
})

app.get('/api/odds/mlb-player-props-showcase', (req, res) => {
  void runMlbPlayerPropsShowcase(req, res)
})

async function runMlbPropLadder(req, res) {
  let key
  try {
    key = theOddsApiKey.value()
  } catch (e) {
    console.error('THE_ODDS_API_KEY secret access:', e)
    res.status(503).json({
      error:
        'THE_ODDS_API_KEY is not available. Run: firebase functions:secrets:set THE_ODDS_API_KEY',
    })
    return
  }
  try {
    await handleMlbPropLadderRequest(req, res, key)
  } catch (e) {
    console.error('mlb prop ladder:', e)
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  }
}

app.get('/api/odds/mlb-prop-ladder', (req, res) => {
  void runMlbPropLadder(req, res)
})

async function runMlbPlayerPropsBoard(req, res) {
  let key
  try {
    key = theOddsApiKey.value()
  } catch (e) {
    console.error('THE_ODDS_API_KEY secret access:', e)
    res.status(503).json({
      error:
        'THE_ODDS_API_KEY is not available. Run: firebase functions:secrets:set THE_ODDS_API_KEY',
    })
    return
  }
  try {
    await handleMlbPlayerPropsBoardRequest(req, res, key)
  } catch (e) {
    console.error('mlb player props board:', e)
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  }
}

app.get('/api/odds/mlb-player-props-board', (req, res) => {
  void runMlbPlayerPropsBoard(req, res)
})

app.post('/api/chat/stream', (req, res) => {
  void runChatStream(req, res)
})
app.post('/api/chat', (req, res) => {
  void runChat(req, res)
})
app.post('/', (req, res) => {
  void runChat(req, res)
})

app.options('/api/chat/stream', (_req, res) => res.status(204).send())
app.options('/api/chat', (_req, res) => res.status(204).send())
app.options('/api/odds/events', (_req, res) => res.status(204).send())
app.options('/api/odds/upcoming', (_req, res) => res.status(204).send())
app.options('/api/odds/mlb-player-props-showcase', (_req, res) => res.status(204).send())
app.options('/api/odds/mlb-prop-ladder', (_req, res) => res.status(204).send())
app.options('/api/odds/mlb-player-props-board', (_req, res) => res.status(204).send())
app.options('/api/config/sports', (_req, res) => res.status(204).send())
app.options('/api/admin/sports', (_req, res) => res.status(204).send())
app.options('/', (_req, res) => res.status(204).send())

/** Optional health check (direct function URL or debugging). */
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'apex-chat' })
})

/**
 * HTTP Cloud Function — Firebase Hosting rewrites `/api/chat` here.
 * Secret: firebase functions:secrets:set ANTHROPIC_API_KEY
 */
export const chat = onRequest(
  {
    region: 'us-central1',
    /** Gen2 runs on Cloud Run; without this, unauthenticated browser requests get 403. */
    invoker: 'public',
    secrets: [anthropicApiKey, theOddsApiKey, adminSportsKey],
    memory: '1GiB',
    /** Long ANALYZE + web search often exceeds 5 min; stream dies without `{complete}` if the worker hits this limit. */
    timeoutSeconds: 1800,
    maxInstances: 20,
  },
  app,
)

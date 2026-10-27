// Local / always-on server: the daemon engine refreshes live data on its own schedule.
//   npm run dev   (from the repo root, with the frontend)   or   npm start --prefix backend
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Load backend/.env next to this file (not CWD-dependent) before anything reads process.env.
dotenv.config({ path: path.join(__dirname, '.env') })

const { createApexApp } = await import('./app.js')
const { log, errText } = await import('./src/lib/log.js')

let db = null
async function initFirestore() {
  // Only when credentials exist; otherwise everything runs on the local disk store.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) return
  try {
    const { getApps, initializeApp } = await import('firebase-admin/app')
    const { getFirestore } = await import('firebase-admin/firestore')
    if (!getApps().length) initializeApp()
    db = getFirestore()
  } catch (e) {
    log.warn('firestore unavailable', { err: errText(e) })
  }
}
await initFirestore()

const { app, engine } = createApexApp({ engineMode: 'daemon', getFirestore: () => db })
engine.ensureStarted().catch((e) => log.error('engine failed to start', { err: errText(e) }))

const PORT = Number.parseInt(process.env.PORT || '8787', 10)
const server = app.listen(PORT, () => {
  log.info(`Propify API listening on http://localhost:${PORT}`)
})
// Live streams stay open for up to 30 minutes; don't let Node cut them.
server.requestTimeout = 0
server.headersTimeout = 65_000
server.keepAliveTimeout = 65_000

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use (another Propify API still running?).\n  Fix:  lsof -ti :${PORT} | xargs kill -9\n  Or:   set PORT=8788 in backend/.env and the same port in frontend/vite.config.js proxy target.\n`)
    process.exit(1)
  }
  throw err
})

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log.info('shutting down', { signal })
  engine.stop()
  try {
    await Promise.race([engine.persist(true), new Promise((r) => setTimeout(r, 4000))])
  } catch {
    /* best effort */
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

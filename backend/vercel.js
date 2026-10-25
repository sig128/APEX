// APEX on Vercel: the whole API as one function. api/index.js (repo root) and
// frontend/api/index.js (when the project's Root Directory is frontend/) both re-export this.
// It's the same Express app the Firebase function and the local server run, with the lazy
// engine. Firebase only provides sign-in and the database:
//   FIREBASE_SERVICE_ACCOUNT   the service account JSON (or that JSON base64-encoded). Turns on
//                              the database: accounts, passes, picks, codes, shared snapshots.
//   VITE_FIREBASE_PROJECT_ID   already set for the site's sign-in; enough to check sign-ins
//                              when there's no service account.
// Without the database, stats and live tracking work; passes and picks pages stay off.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log, errText } from './src/lib/log.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export function serviceAccountFromEnv(raw = process.env.FIREBASE_SERVICE_ACCOUNT) {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const json = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'))
    if (typeof json.private_key === 'string') json.private_key = json.private_key.replace(/\\n/g, '\n')
    return json.client_email && json.private_key ? json : null
  } catch {
    return null
  }
}

let ready = null
async function build() {
  const { getApps, initializeApp, cert } = await import('firebase-admin/app')
  const sa = serviceAccountFromEnv()
  if (process.env.FIREBASE_SERVICE_ACCOUNT && !sa) log.error('FIREBASE_SERVICE_ACCOUNT is set but is not a service account JSON; running without the database')
  const projectId = sa?.project_id || process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || undefined
  if (!getApps().length) initializeApp(sa ? { credential: cert(sa), projectId } : projectId ? { projectId } : undefined)
  let db = null
  if (sa) {
    const { getFirestore } = await import('firebase-admin/firestore')
    db = getFirestore()
  }
  process.env.APEX_STORE ||= db ? 'firestore' : 'memory'
  if (db) process.env.APEX_BILLING_STORE ||= 'firestore'
  else process.env.APEX_EPHEMERAL = '1'
  // the built index.html rides along for /u/handle link previews
  for (const p of [path.join(here, '..', 'frontend', 'build', 'index.html'), path.join(process.cwd(), 'frontend', 'build', 'index.html'), path.join(process.cwd(), 'build', 'index.html')]) {
    if (!process.env.APEX_WEB_INDEX && fs.existsSync(p)) process.env.APEX_WEB_INDEX = p
  }
  const { createApexApp } = await import('./app.js')
  const made = createApexApp({ engineMode: 'lazy', getFirestore: () => db })
  _state.made = made
  log.info('apex api ready on vercel', { database: Boolean(db), projectId: projectId || null })
  return made.app
}

/** For tests: the app this instance built. */
export const _state = { made: null }

export default async function handler(req, res) {
  ready ||= build().catch((e) => {
    ready = null
    throw e
  })
  let app
  try {
    app = await ready
  } catch (e) {
    log.error('apex api failed to start', { err: errText(e) })
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    return res.end(JSON.stringify({ error: 'The API could not start. Check the function logs.', code: 'startup' }))
  }
  return app(req, res)
}

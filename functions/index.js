/**
 * APEX on Firebase: one HTTP function (`chat`, the name Hosting rewrites already point at) runs
 * the whole API from backend/ (copied to functions/apex/ by scripts/sync-functions.mjs before
 * every deploy), plus the `redeemInvite` callable.
 *
 * First deploy:
 * 1. Blaze plan on the Firebase project; enable the Secret Manager API.
 * 2. firebase functions:secrets:set ANTHROPIC_API_KEY
 *    firebase functions:secrets:set ADMIN_SPORTS_KEY   (random string, 12+ characters)
 *    firebase functions:secrets:set THE_ODDS_API_KEY   (optional: sportsbook prices)
 * 3. cp functions/.env.example functions/.env and set APEX_TREASURY_ADDRESS (your Base wallet)
 *    and APEX_ADMIN_EMAILS. Without a treasury the paywall stays off.
 * 4. npm run deploy   (builds the frontend, syncs the API, deploys hosting, functions, rules
 *    and indexes). If the build service account is missing permissions, run
 *    scripts/fix-cloud-functions-build-iam.sh.
 */
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { redeemInvite } from './inviteRedeem.js'

export { redeemInvite }

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY')
const theOddsApiKey = defineSecret('THE_ODDS_API_KEY')
const adminSportsKey = defineSecret('ADMIN_SPORTS_KEY')

const read = (secret) => {
  try {
    return secret.value() || ''
  } catch {
    return ''
  }
}

// One app per instance, built on the first request (deploy-time analysis never builds it).
let appPromise = null
function apexApp() {
  if (!appPromise) {
    appPromise = (async () => {
      if (!getApps().length) initializeApp()
      const db = getFirestore()
      process.env.APEX_STORE ||= 'firestore'
      // the admin key reaches the auth checks through the environment
      if (!process.env.ADMIN_SPORTS_KEY) process.env.ADMIN_SPORTS_KEY = read(adminSportsKey)
      const { createApexApp } = await import('./apex/app.js')
      const { app } = createApexApp({
        engineMode: 'lazy',
        getFirestore: () => db,
        anthropicKey: () => read(anthropicApiKey),
        oddsKey: () => read(theOddsApiKey),
        adminKey: () => read(adminSportsKey),
      })
      return app
    })().catch((e) => {
      appPromise = null
      throw e
    })
  }
  return appPromise
}

export const chat = onRequest(
  {
    region: 'us-central1',
    invoker: 'public',
    secrets: [anthropicApiKey, theOddsApiKey, adminSportsKey],
    memory: '1GiB',
    cpu: 1,
    // Long AI analyses and 30-minute live streams.
    timeoutSeconds: 1800,
    // Live streams hold a request open, so one instance serves many readers.
    concurrency: 250,
    maxInstances: Number.parseInt(process.env.APEX_MAX_INSTANCES || '10', 10),
    minInstances: Number.parseInt(process.env.APEX_MIN_INSTANCES || '0', 10),
  },
  async (req, res) => {
    try {
      const app = await apexApp()
      app(req, res)
    } catch (e) {
      console.error('APEX failed to start', e)
      if (!res.headersSent) res.status(503).json({ error: 'APEX is starting up. Try again in a moment.', code: 'starting' })
    }
  },
)

/**
 * Creates invite code documents in Firestore (collection: inviteCodes).
 *
 * Requires a Firebase service account JSON with Firestore write access (not committed to git).
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccount.json node seed-invite-codes.mjs
 *
 * Or pass the path as the first argument (resolved from current working directory):
 *
 *   node seed-invite-codes.mjs ../../path/to-service-account.json
 *
 * Optional: INVITE_CODE_COUNT=5 (default 5)
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { randomBytes } from 'crypto'
import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

function credentialPath() {
  const arg = process.argv[2]
  if (arg) return resolve(process.cwd(), arg)
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (env) return resolve(env)
  return null
}

const credPath = credentialPath()
if (!credPath || !existsSync(credPath)) {
  console.error(
    'Missing service account JSON.\n' +
      '  Set GOOGLE_APPLICATION_CREDENTIALS to the file path, or run:\n' +
      '  node seed-invite-codes.mjs /path/to/your-service-account.json\n',
  )
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(credPath, 'utf8'))
if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount) })
}

const db = getFirestore()
const count = Math.min(50, Math.max(1, parseInt(process.env.INVITE_CODE_COUNT || '5', 10) || 5))

function makeCode() {
  return `APEX-${randomBytes(4).toString('hex').toUpperCase()}`
}

const codes = []
const seen = new Set()
while (codes.length < count) {
  const c = makeCode()
  if (seen.has(c)) continue
  seen.add(c)
  codes.push(c)
}

const batch = db.batch()
for (const code of codes) {
  batch.set(db.collection('inviteCodes').doc(code), {
    active: true,
    usesRemaining: 1,
  })
}

await batch.commit()
console.log(`Created ${count} documents in Firestore → collection "inviteCodes" (document ID = code):\n`)
for (const c of codes) console.log(`  ${c}`)
console.log('')

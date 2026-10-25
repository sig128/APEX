/**
 * Creates invite codes in Firestore (collection: inviteCodes, document id = the code).
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json node seed-invite-codes.mjs
 *   node seed-invite-codes.mjs /path/to/serviceAccount.json
 *
 * Options (environment):
 *   INVITE_CODE_COUNT=5      how many codes (1-50)
 *   INVITE_USES=1            redemptions per code (number, or "unlimited")
 *   INVITE_PLAN=elite        make them plan codes: pro or elite (leave unset for plain invites)
 *   INVITE_DAYS=30           length of the pass for plan codes (1-3650, or "lifetime")
 *   INVITE_EXPIRES_DAYS=14   the code itself stops working after this many days (optional)
 *   INVITE_PREFIX=APEX       code prefix
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { randomBytes } from 'crypto'
import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

function credentialPath() {
  const arg = process.argv[2]
  if (arg) return resolve(process.cwd(), arg)
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (env) return resolve(env)
  return null
}

const credPath = credentialPath()
if (!credPath || !existsSync(credPath)) {
  console.error('Missing service account JSON.\n  Set GOOGLE_APPLICATION_CREDENTIALS to the file path, or run:\n  node seed-invite-codes.mjs /path/to/your-service-account.json\n')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(credPath, 'utf8'))
if (!getApps().length) initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

const count = Math.min(50, Math.max(1, parseInt(process.env.INVITE_CODE_COUNT || '5', 10) || 5))
const usesRaw = String(process.env.INVITE_USES || '1').toLowerCase()
const uses = usesRaw === 'unlimited' ? null : Math.max(1, parseInt(usesRaw, 10) || 1)
const plan = ['pro', 'elite'].includes(String(process.env.INVITE_PLAN || '').toLowerCase()) ? process.env.INVITE_PLAN.toLowerCase() : null
const daysRaw = String(process.env.INVITE_DAYS || '30').toLowerCase()
const days = daysRaw === 'lifetime' ? 'lifetime' : Math.min(3650, Math.max(1, parseInt(daysRaw, 10) || 30))
const expiresDays = parseInt(process.env.INVITE_EXPIRES_DAYS || '', 10)
const prefix = String(process.env.INVITE_PREFIX || 'APEX').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'APEX'

const codes = new Set()
while (codes.size < count) codes.add(`${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`)

const batch = db.batch()
for (const code of codes) {
  batch.set(db.collection('inviteCodes').doc(code), {
    active: true,
    ...(uses == null ? {} : { usesRemaining: uses }),
    ...(plan ? { plan, days } : {}),
    ...(expiresDays > 0 ? { expiresAt: Timestamp.fromMillis(Date.now() + expiresDays * 86_400_000) } : {}),
    createdAt: Timestamp.now(),
  })
}
await batch.commit()
const what = plan ? `${plan} pass, ${days === 'lifetime' ? 'lifetime' : `${days} days`}` : 'plain invite'
console.log(`Created ${count} codes (${what}; ${uses == null ? 'unlimited uses' : `${uses} use${uses === 1 ? '' : 's'} each`}${expiresDays > 0 ? `; expire in ${expiresDays} days` : ''}):\n`)
for (const c of codes) console.log(`  ${c}`)
console.log('')

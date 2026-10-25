// Who is calling: Firebase ID token (Google sign-in), the admin key, or nobody.
import crypto from 'node:crypto'
import { checkAdminKey } from './adminKey.js'
import { ApiError } from '../lib/router.js'
import { log, errText } from '../lib/log.js'

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

/** Local `npm run dev` may run without Firebase credentials; everywhere else sign-in is real. */
export function authMode() {
  if (process.env.APEX_AUTH === 'optional' && process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE) return 'optional'
  if (process.env.npm_lifecycle_event === 'dev' && process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE) return 'optional'
  return 'required'
}

async function defaultVerify(token) {
  const { getAuth } = await import('firebase-admin/auth')
  const { getApps, initializeApp } = await import('firebase-admin/app')
  if (!getApps().length) initializeApp()
  return getAuth().verifyIdToken(token)
}

async function defaultInvite(uid) {
  const { getFirestore } = await import('firebase-admin/firestore')
  const { getApps, initializeApp } = await import('firebase-admin/app')
  if (!getApps().length) initializeApp()
  const snap = await getFirestore().collection('users').doc(uid).get()
  return Boolean(snap.exists && snap.data()?.inviteVerifiedAt)
}

export function createAuth({ verifyIdToken = defaultVerify, lookupInvite = defaultInvite } = {}) {
  const tokens = new Map() // sha256(token) -> { user, until }
  const invites = new Map() // uid -> { ok, until }

  function adminUser() {
    return { uid: 'admin', admin: true, email: null, emailVerified: false, name: 'Admin', picture: null, viaKey: true }
  }

  /** User or null. Throws 401/429 for a bad token or a bad admin key (never silently anonymous). */
  async function identify(req) {
    if (req.apexUser !== undefined) return req.apexUser
    const key = checkAdminKey(req)
    if (key === 'ok') return (req.apexUser = adminUser())
    if (key === 'blocked') throw new ApiError(429, 'locked', 'Too many bad admin keys from this address. Try again later.', { retryAfter: 900 })
    if (key === 'bad') throw new ApiError(401, 'bad_admin_key', 'That admin key is wrong.')
    const h = String(req.headers?.authorization || '')
    const m = /^Bearer\s+(.+)$/i.exec(h)
    if (!m) return (req.apexUser = null)
    const token = m[1].trim()
    if (token.length < 20 || token.length > 4096) throw new ApiError(401, 'bad_token', 'Sign in again.')
    const k = crypto.createHash('sha256').update(token).digest('hex')
    const hit = tokens.get(k)
    if (hit && hit.until > Date.now()) return (req.apexUser = hit.user)
    let d
    try {
      d = await verifyIdToken(token)
    } catch (e) {
      log.debug('token rejected', { err: errText(e) })
      throw new ApiError(401, 'bad_token', 'Your sign-in expired. Sign in again.')
    }
    const email = typeof d.email === 'string' ? d.email.toLowerCase() : null
    const verified = Boolean(d.email_verified)
    const admin = d.admin === true || list(process.env.APEX_ADMIN_UIDS).includes(String(d.uid).toLowerCase()) || Boolean(email && verified && list(process.env.APEX_ADMIN_EMAILS).includes(email))
    const user = { uid: String(d.uid), email, emailVerified: verified, name: d.name || null, picture: d.picture || null, admin }
    const until = Math.min(Date.now() + 5 * 60_000, (Number(d.exp) || 0) * 1000 || Infinity)
    tokens.set(k, { user, until })
    if (tokens.size > 5000) tokens.delete(tokens.keys().next().value)
    return (req.apexUser = user)
  }

  async function authenticate(req) {
    const u = await identify(req)
    if (!u) throw new ApiError(401, 'signin', 'Sign in to use this.')
    return u
  }

  /** The original invite gate (used while the paywall is off). */
  async function inviteVerified(user) {
    if (!user) return false
    if (user.admin) return true
    const hit = invites.get(user.uid)
    if (hit && hit.until > Date.now()) return hit.ok
    let ok = false
    try {
      ok = await lookupInvite(user.uid)
    } catch (e) {
      log.warn('invite lookup failed', { err: errText(e) })
    }
    invites.set(user.uid, { ok, until: Date.now() + (ok ? 10 * 60_000 : 20_000) })
    return ok
  }

  /** Express middleware for the legacy rule: signed in AND redeemed an invite code. */
  function requireApexUser(req, res, next) {
    ;(async () => {
      if (authMode() === 'optional') return next()
      const u = await authenticate(req)
      if (!(await inviteVerified(u))) throw new ApiError(403, 'invite', 'Redeem an invite code to use this.')
      next()
    })().catch((e) => {
      const status = e instanceof ApiError ? e.status : 500
      res.status(status).set('Cache-Control', 'no-store').json({ error: e.message || 'Error', code: e.code || 'internal' })
    })
  }

  return { identify, authenticate, inviteVerified, requireApexUser, _tokens: tokens }
}

export const defaultAuthInstance = createAuth()
export const identify = (req) => defaultAuthInstance.identify(req)
export const authenticate = (req) => defaultAuthInstance.authenticate(req)
export const requireApexUser = (req, res, next) => defaultAuthInstance.requireApexUser(req, res, next)

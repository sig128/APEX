// The admin page's lock: one password, checked on the server and never shipped to the browser.
// The password is the admin key (ADMIN_SPORTS_KEY, 24+ characters), the same one the league
// switches page takes, so there is one password for everything admin.
//
// A right password gets a signed cookie (HttpOnly, so page scripts can't read it; SameSite=Strict;
// Path=/api/admin, so no other request carries it) that lasts 7 days, or until the key changes:
// the signature is keyed off the password itself. Wrong passwords are counted per address and
// overall in the store, so guessing stays slow across every server instance.
import crypto from 'node:crypto'
import { keyMatches, MIN_ADMIN_KEY } from '../security/adminKey.js'
import { clientIp, ApiError } from '../lib/router.js'
import { log, errText } from '../lib/log.js'

export const COOKIE = 'propify_admin'
export const SESSION_MS = 7 * 86_400_000
const WINDOW_MS = 15 * 60_000
const MAX_PER_IP = 8
const MAX_ALL = 100
const NS = 'admin-lock'

/** What the session acts as when it calls the billing and picks services. */
export const ADMIN = Object.freeze({ uid: 'admin', admin: true, email: null, name: 'Admin', viaKey: true })

/** The admin password, or null when none (or one too short to trust) is set. */
export function adminPassword() {
  const k = typeof process.env.ADMIN_SPORTS_KEY === 'string' ? process.env.ADMIN_SPORTS_KEY.trim() : ''
  return k.length >= MIN_ADMIN_KEY ? k : null
}

const signKey = (pw) => crypto.createHmac('sha256', pw).update('propify-admin-session-v1').digest()
const sign = (pw, body) => crypto.createHmac('sha256', signKey(pw)).update(body).digest()

export function makeToken(pw, t) {
  const body = Buffer.from(JSON.stringify({ v: 1, iat: t, exp: t + SESSION_MS })).toString('base64url')
  return `${body}.${sign(pw, body).toString('base64url')}`
}

/** The session's payload when the token is genuine and unexpired, otherwise null. */
export function readToken(token, pw, t) {
  if (typeof token !== 'string' || token.length > 512 || !pw) return null
  const [body, sig, extra] = token.split('.')
  if (!body || !sig || extra !== undefined) return null
  const got = Buffer.from(sig, 'base64url')
  const want = sign(pw, body)
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null
  let p
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  return p && p.v === 1 && Number(p.exp) > t ? p : null
}

export function cookieOf(req, name = COOKIE) {
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim())
      } catch {
        return null
      }
    }
  }
  return null
}

const isHttps = (req) => Boolean(process.env.VERCEL) || req.secure || String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'

function setCookie(req, res, value, maxAgeMs) {
  const parts = [`${COOKIE}=${value}`, 'Path=/api/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`]
  if (isHttps(req)) parts.push('Secure')
  res.append('Set-Cookie', parts.join('; '))
}

export function createAdminLock({ store = null, now = () => Date.now() } = {}) {
  const mem = new Map() // used when the store can't be reached
  const ipKey = (req) => `ip-${crypto.createHash('sha256').update(`propify-admin:${clientIp(req)}`).digest('hex').slice(0, 32)}`

  async function read(key) {
    if (store) {
      try {
        return (await store.get(NS, key)) || null
      } catch (e) {
        log.warn('admin lock: store read failed', { err: errText(e) })
      }
    }
    return mem.get(key) || null
  }
  async function bump(key, t, max) {
    const next = (prev) => {
      const r = prev && prev.start > t - WINDOW_MS ? { ...prev } : { n: 0, start: t, until: 0 }
      r.n++
      if (r.n >= max) r.until = t + WINDOW_MS
      return r
    }
    mem.set(key, next(mem.get(key)))
    if (mem.size > 5000) mem.delete(mem.keys().next().value)
    if (store) await store.update(NS, key, next).catch((e) => log.warn('admin lock: store write failed', { err: errText(e) }))
  }
  const blockedUntil = (r, t) => (r && r.until > t ? r.until : 0)

  /** The admin when the request carries a live session (or the key itself, for scripts); else throws. */
  function require(req) {
    const pw = adminPassword()
    if (!pw) throw new ApiError(503, 'admin_unset', 'The admin password isn’t set up on the server yet.')
    if (readToken(cookieOf(req), pw, now())) return ADMIN
    const header = typeof req.headers?.['x-apex-admin-key'] === 'string' ? req.headers['x-apex-admin-key'].trim() : ''
    if (header && keyMatches(header, pw)) return ADMIN
    throw new ApiError(401, 'admin_password', 'Enter the admin password.')
  }

  function status(req) {
    const pw = adminPassword()
    const s = pw ? readToken(cookieOf(req), pw, now()) : null
    return { configured: Boolean(pw), open: Boolean(s), until: s ? s.exp : null }
  }

  async function login(req, res) {
    const pw = adminPassword()
    if (!pw) throw new ApiError(503, 'admin_unset', 'The admin password isn’t set up on the server yet.')
    const t = now()
    const key = ipKey(req)
    const [mine, all] = await Promise.all([read(key), read('all')])
    const wait = Math.max(blockedUntil(mine, t), blockedUntil(all, t))
    if (wait) throw new ApiError(429, 'admin_locked', 'Too many wrong passwords. Try again in 15 minutes.', { retryAfter: Math.ceil((wait - t) / 1000) })
    const got = typeof req.body?.password === 'string' ? req.body.password.trim() : ''
    if (!got || got.length > 512 || !keyMatches(got, pw)) {
      await Promise.all([bump(key, t, MAX_PER_IP), bump('all', t, MAX_ALL)])
      log.warn('admin password wrong', { ip: key })
      throw new ApiError(401, 'admin_password_wrong', 'That password isn’t right.')
    }
    mem.delete(key)
    if (store) await store.del(NS, key).catch(() => {})
    setCookie(req, res, makeToken(pw, t), SESSION_MS)
    return { ok: true, until: t + SESSION_MS }
  }

  function logout(req, res) {
    setCookie(req, res, '', 0)
    return { ok: true }
  }

  return { require, status, login, logout }
}

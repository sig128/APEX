// The X-Apex-Admin-Key header (ADMIN_SPORTS_KEY). Constant-time compare, and an IP that keeps
// guessing gets locked out for a while.
import crypto from 'node:crypto'
import { clientIp } from '../lib/router.js'

const fails = new Map() // ip -> { n, until }
const WINDOW_MS = 15 * 60_000
const MAX_BAD = 10
// Backstop for guesses spread across many addresses: past this many wrong keys in a window the
// key stops working for everyone for a while. Admins signed in with Google are unaffected.
const MAX_BAD_ALL = 200
const all = { n: 0, windowStart: 0, until: 0 }
export const MIN_ADMIN_KEY = 24

export function keyMatches(got, expected) {
  if (typeof got !== 'string' || typeof expected !== 'string' || !expected) return false
  const a = crypto.createHash('sha256').update(got).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

/** 'none' (no header) | 'ok' | 'bad' | 'blocked'. */
export function checkAdminKey(req, expected = process.env.ADMIN_SPORTS_KEY) {
  const header = req.headers?.['x-apex-admin-key']
  const got = typeof header === 'string' ? header.trim() : ''
  if (!got) return 'none'
  const ip = clientIp(req)
  const f = fails.get(ip)
  const now = Date.now()
  if ((f && f.until > now) || all.until > now) return 'blocked'
  if (expected && expected.length >= MIN_ADMIN_KEY && keyMatches(got, expected)) {
    fails.delete(ip)
    return 'ok'
  }
  const rec = f && f.windowStart > now - WINDOW_MS ? f : { n: 0, windowStart: now, until: 0 }
  rec.n++
  if (rec.n >= MAX_BAD) rec.until = now + WINDOW_MS
  fails.set(ip, rec)
  if (fails.size > 5000) fails.delete(fails.keys().next().value)
  if (all.windowStart <= now - WINDOW_MS) {
    all.n = 0
    all.windowStart = now
  }
  if (++all.n >= MAX_BAD_ALL) all.until = now + WINDOW_MS
  return 'bad'
}

export function _resetAdminKeyFails() {
  fails.clear()
  all.n = 0
  all.windowStart = 0
  all.until = 0
}

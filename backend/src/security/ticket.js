// Short-lived signed tickets for the event stream. EventSource can't send an Authorization
// header, so a signed-in client first asks /api/nfl/ticket and passes the ticket in the URL.
import crypto from 'node:crypto'

function secret() {
  const s = process.env.APEX_STREAM_SECRET
  if (s && s.length >= 16) return s
  const admin = process.env.ADMIN_SPORTS_KEY
  if (admin && admin.length >= 12) return crypto.createHash('sha256').update(`apex-stream:${admin}`).digest('hex')
  // No configured secret: a per-process key (tickets then only work on the instance that issued them).
  if (!secret.local) secret.local = crypto.randomBytes(32).toString('hex')
  return secret.local
}

const b64 = (buf) => Buffer.from(buf).toString('base64url')

export function signTicket(payload, ttlMs = 10 * 60_000) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }))
  const sig = b64(crypto.createHmac('sha256', secret()).update(body).digest())
  return `${body}.${sig}`
}

export function verifyTicket(t) {
  if (typeof t !== 'string' || t.length > 2048) return null
  const [body, sig] = t.split('.')
  if (!body || !sig) return null
  const want = b64(crypto.createHmac('sha256', secret()).update(body).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(want)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!data.exp || data.exp < Date.now()) return null
    return data
  } catch {
    return null
  }
}

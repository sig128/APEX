// Alerts to the iPhone app go through Apple's push service (APNs) over HTTP/2, signed with the
// team's push key. Needs APNS_KEY (the text of the .p8 file Apple gives once), APNS_KEY_ID,
// APNS_TEAM_ID and APNS_TOPIC (the app's bundle id, com.proppickz.app unless set). Without them
// the app's devices are simply skipped and alerts reach browsers only.
import http2 from 'node:http2'
import crypto from 'node:crypto'

export function apnsConfig(env = process.env) {
  const key = String(env.APNS_KEY || '')
    .replace(/\\n/g, '\n')
    .trim()
  const keyId = String(env.APNS_KEY_ID || '').trim()
  const teamId = String(env.APNS_TEAM_ID || env.APPLE_TEAM_ID || '').trim()
  const topic = String(env.APNS_TOPIC || 'com.proppickz.app').trim()
  return { enabled: Boolean(key && keyId && teamId), key, keyId, teamId, topic }
}

export const APNS_HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' }
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** Apple's provider token: ES256 over { iss: team, iat }. Good for an hour; renewed well before. */
export function providerToken({ key, keyId, teamId }, nowMs = Date.now()) {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) }))
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: crypto.createPrivateKey(key), dsaEncoding: 'ieee-p1363' })
  return `${head}.${claims}.${b64url(sig)}`
}

/** A device token as the app reports it: 32 bytes or more, in hex. */
export const cleanToken = (t) => {
  const s = String(t || '').trim()
  return /^[0-9a-fA-F]{64,200}$/.test(s) ? s.toLowerCase() : null
}

// A token Apple no longer delivers to, or never knew: the device goes from the list
const GONE = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic', 'ExpiredToken'])

export function createApns({ config = apnsConfig, now = () => Date.now(), connect = (origin) => http2.connect(origin) } = {}) {
  let token = null
  const sessions = new Map()

  function bearer(cfg, fresh = false) {
    const t = now()
    if (fresh || !token || token.keyId !== cfg.keyId || t - token.at > 40 * 60_000) token = { at: t, keyId: cfg.keyId, value: providerToken(cfg, t) }
    return token.value
  }
  function session(env) {
    const origin = APNS_HOSTS[env] || APNS_HOSTS.production
    let s = sessions.get(origin)
    if (!s || s.closed || s.destroyed) {
      s = connect(origin)
      const drop = () => sessions.get(origin) === s && sessions.delete(origin)
      s.on?.('error', drop)
      s.on?.('close', drop)
      s.on?.('goaway', drop)
      s.unref?.()
      sessions.set(origin, s)
    }
    return s
  }

  function post(env, deviceToken, body, headers) {
    return new Promise((resolve) => {
      let status = 0
      let data = ''
      let req
      const timer = setTimeout(() => {
        try {
          req?.close?.()
        } catch {
          /* closed */
        }
        resolve({ status: 0, reason: 'timeout' })
      }, 10_000)
      try {
        req = session(env).request({ ':method': 'POST', ':path': `/3/device/${deviceToken}`, ...headers })
      } catch (e) {
        clearTimeout(timer)
        resolve({ status: 0, reason: e?.code || 'connect' })
        return
      }
      req.setEncoding?.('utf8')
      req.on('response', (h) => {
        status = Number(h[':status']) || 0
      })
      req.on('data', (c) => {
        data += c
      })
      req.on('end', () => {
        clearTimeout(timer)
        let reason = null
        try {
          reason = data ? JSON.parse(data).reason || null : null
        } catch {
          reason = null
        }
        resolve({ status, reason })
      })
      req.on('error', (e) => {
        clearTimeout(timer)
        resolve({ status: 0, reason: e?.code || 'error' })
      })
      req.end(body)
    })
  }

  /**
   * One alert to one device. Resolves { ok, status, reason, gone, env }: gone means drop the
   * token; env is where it was delivered (TestFlight and App Store builds use production, builds
   * run from Xcode use the sandbox, so a token production refuses gets one try there).
   */
  async function send(deviceToken, payload, { env = 'production', ttlSec = 6 * 3600 } = {}) {
    const cfg = config()
    if (!cfg.enabled) return { ok: false, status: 0, reason: 'off', gone: false, env }
    const body = JSON.stringify({
      aps: { alert: { title: String(payload.title || 'PropPickz'), body: String(payload.body || '') }, sound: 'default', 'thread-id': String(payload.tag || 'proppickz').slice(0, 64) },
      url: payload.url || '/',
    })
    const headers = (fresh) => ({
      authorization: `bearer ${bearer(cfg, fresh)}`,
      'apns-topic': cfg.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(now() / 1000) + ttlSec),
      ...(payload.tag ? { 'apns-collapse-id': String(payload.tag).slice(0, 64) } : {}),
      'content-type': 'application/json',
    })
    let r = await post(env, deviceToken, body, headers(false))
    if (r.status === 403 && (r.reason === 'ExpiredProviderToken' || r.reason === 'InvalidProviderToken')) r = await post(env, deviceToken, body, headers(true))
    if (env === 'production' && r.reason === 'BadDeviceToken') {
      const s = await post('sandbox', deviceToken, body, headers(false))
      if (s.status === 200) return { ok: true, status: 200, reason: null, gone: false, env: 'sandbox' }
    }
    return { ok: r.status === 200, status: r.status, reason: r.reason, gone: r.status === 410 || GONE.has(r.reason), env }
  }

  return { send, enabled: () => config().enabled }
}

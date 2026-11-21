// Push notifications (web push). Someone turns them on in their browser (the browser asks them;
// we never ask on page load), and the server keeps each device's subscription and sends only what
// they chose: their picks' results, injury news on their open picks, and live line moves past
// their threshold (members). A cap per day and a gap per pick keep it from turning into noise.
// Needs VAPID keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT); without them it's off.
// The iPhone app's devices are on the same list, delivered through Apple's push service instead
// (see apns.js): the same choices, the same daily cap and gaps.
import webpush from 'web-push'
import { ApiError } from '../lib/router.js'
import { log, errText } from '../lib/log.js'
import { createApns, cleanToken } from './apns.js'

export function pushConfig(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY || null
  const privateKey = env.VAPID_PRIVATE_KEY || null
  return { enabled: Boolean(publicKey && privateKey), publicKey, privateKey, subject: env.VAPID_SUBJECT || 'mailto:support@proppickz.com' }
}

export const KINDS = ['results', 'injuries', 'ticker', 'test']
export const DEFAULT_PREFS = { results: true, injuries: true, ticker: 'big' }
const LEVELS = ['big', 'all', 'risk', 'off']
const MAX_DEVICES = 5
const MAX_PER_DAY = 12
const TAG_GAP_MS = 30 * 60_000
const NS = 'pushSubs'

/** The same bar the in-page alerts use: does a ticker change clear this person's threshold? */
export function tickerAlertable(level, item, ev) {
  if (level === 'off' || ev.kind === 'post' || ev.kind === 'book') return false
  if (level === 'all') return true
  const bad = item.status === 'risk' || item.status === 'void'
  if (level === 'risk') return bad
  if (ev.kind === 'line') return (ev.size ?? 1) >= 1 || bad
  if (ev.kind === 'price') return (ev.size ?? 0) >= 20 || bad
  return true
}

function cleanSub(s) {
  const endpoint = String(s?.endpoint || '')
  const p256dh = String(s?.keys?.p256dh || '')
  const auth = String(s?.keys?.auth || '')
  if (!/^https:\/\/[^\s]{10,800}$/.test(endpoint) || !/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,60}$/.test(auth)) return null
  return { endpoint, keys: { p256dh, auth } }
}
function cleanPrefs(p = {}, base = DEFAULT_PREFS) {
  return {
    results: typeof p.results === 'boolean' ? p.results : base.results,
    injuries: typeof p.injuries === 'boolean' ? p.injuries : base.injuries,
    ticker: LEVELS.includes(p.ticker) ? p.ticker : base.ticker,
  }
}

export function createPush({ docs, now = () => Date.now(), isMember = async () => false, sender = null, config = pushConfig, apns = createApns({ now }) }) {
  const send =
    sender ||
    ((sub, payload, cfg) =>
      webpush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey }, TTL: 6 * 3600, urgency: 'normal' }))
  const day = (t) => new Date(t).toISOString().slice(0, 10)
  // a device on the list: a browser by its endpoint, the app by its Apple token
  const keyOf = (s) => (s.apns ? `apns:${s.apns}` : s.endpoint)
  const anyOn = () => config().enabled || apns.enabled()

  async function indexAdd(uid) {
    await docs.tx(async (tx) => {
      const cur = (await tx.get('pushIndex', 'all')) || { uids: [] }
      if (cur.uids.includes(uid)) return
      tx.set('pushIndex', 'all', { uids: [...cur.uids, uid].slice(-20_000) })
    })
  }
  async function indexDrop(uid) {
    await docs.tx(async (tx) => {
      const cur = (await tx.get('pushIndex', 'all')) || { uids: [] }
      if (!cur.uids.includes(uid)) return
      tx.set('pushIndex', 'all', { uids: cur.uids.filter((x) => x !== uid) })
    })
  }

  async function status(user) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in to set up alerts.')
    const cfg = config()
    const d = await docs.get(NS, user.uid)
    return { enabled: cfg.enabled, native: apns.enabled(), publicKey: cfg.publicKey, devices: d?.subs?.length || 0, prefs: cleanPrefs(d?.prefs) }
  }

  /** The iPhone app turned alerts on: its Apple device token joins this person's devices. */
  async function subscribeNative(user, { token, prefs, device } = {}) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in to set up alerts.')
    if (!apns.enabled()) throw new ApiError(503, 'push_off', 'Alerts in the app aren’t set up on the server yet.')
    const tok = cleanToken(token)
    if (!tok) throw new ApiError(400, 'bad_token', 'That device token isn’t valid.')
    const t = now()
    await docs.tx(async (tx) => {
      const cur = (await tx.get(NS, user.uid)) || { subs: [], prefs: DEFAULT_PREFS }
      const subs = [{ apns: tok, env: 'production', device: String(device || 'iPhone app').slice(0, 80), at: t }, ...(cur.subs || []).filter((s) => s.apns !== tok)].slice(0, MAX_DEVICES)
      tx.set(NS, user.uid, { ...cur, subs, prefs: cleanPrefs(prefs, cleanPrefs(cur.prefs)), updatedAt: t })
    })
    await indexAdd(user.uid)
    return status(user)
  }

  async function unsubscribeNative(user, { token } = {}) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in first.')
    const tok = cleanToken(token)
    let left = 0
    await docs.tx(async (tx) => {
      const cur = await tx.get(NS, user.uid)
      if (!cur) return
      const subs = (cur.subs || []).filter((s) => s.apns !== tok)
      left = subs.length
      tx.set(NS, user.uid, { ...cur, subs, updatedAt: now() })
    })
    if (!left) await indexDrop(user.uid)
    return status(user)
  }

  /** Deleting an account: every device and choice goes. */
  async function eraseUser(uid) {
    await docs.del(NS, uid).catch(() => null)
    await indexDrop(uid).catch(() => null)
  }

  async function subscribe(user, { subscription, prefs, device } = {}) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in to set up alerts.')
    if (!config().enabled) throw new ApiError(503, 'push_off', 'Alerts on this device aren’t set up on the server yet.')
    const sub = cleanSub(subscription)
    if (!sub) throw new ApiError(400, 'bad_subscription', 'That browser subscription isn’t valid.')
    const t = now()
    await docs.tx(async (tx) => {
      const cur = (await tx.get(NS, user.uid)) || { subs: [], prefs: DEFAULT_PREFS }
      const subs = [{ ...sub, device: String(device || '').slice(0, 80), at: t }, ...(cur.subs || []).filter((s) => s.endpoint !== sub.endpoint)].slice(0, MAX_DEVICES)
      tx.set(NS, user.uid, { ...cur, subs, prefs: cleanPrefs(prefs, cleanPrefs(cur.prefs)), updatedAt: t })
    })
    await indexAdd(user.uid)
    return status(user)
  }

  async function unsubscribe(user, { endpoint, all = false } = {}) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in first.')
    let left = 0
    await docs.tx(async (tx) => {
      const cur = await tx.get(NS, user.uid)
      if (!cur) return
      const subs = all ? [] : (cur.subs || []).filter((s) => s.endpoint !== endpoint)
      left = subs.length
      tx.set(NS, user.uid, { ...cur, subs, updatedAt: now() })
    })
    if (!left) await indexDrop(user.uid)
    return status(user)
  }

  async function setPrefs(user, prefs) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in first.')
    await docs.tx(async (tx) => {
      const cur = (await tx.get(NS, user.uid)) || { subs: [] }
      tx.set(NS, user.uid, { ...cur, prefs: cleanPrefs(prefs, cleanPrefs(cur.prefs)), updatedAt: now() })
    })
    return status(user)
  }

  /**
   * Send one alert to every device of one person, if they want this kind, within the daily cap
   * and the gap per tag. Dead subscriptions (the browser dropped them) are removed.
   */
  async function notify(uid, kind, payload) {
    const cfg = config()
    if (!anyOn() || !KINDS.includes(kind)) return 0
    const t = now()
    const d = await docs.get(NS, uid)
    if (!d?.subs?.length) return 0
    const prefs = cleanPrefs(d.prefs)
    if (kind === 'results' && !prefs.results) return 0
    if (kind === 'injuries' && !prefs.injuries) return 0
    if (kind === 'ticker' && prefs.ticker === 'off') return 0
    const sent = d.sent?.day === day(t) ? d.sent : { day: day(t), n: 0, tags: {} }
    if (kind !== 'test' && sent.n >= MAX_PER_DAY) return 0
    if (payload.tag && sent.tags[payload.tag] && t - sent.tags[payload.tag] < TAG_GAP_MS) return 0
    const dead = []
    const moved = new Map() // app tokens that turned out to be the sandbox's (builds run from Xcode)
    let ok = 0
    const msg = { title: payload.title, body: payload.body, url: payload.url || '/', tag: payload.tag || kind }
    for (const s of d.subs) {
      if (s.apns) {
        if (!apns.enabled()) continue
        const r = await apns.send(s.apns, msg, { env: s.env || 'production' })
        if (r.ok) {
          ok++
          if (r.env !== (s.env || 'production')) moved.set(s.apns, r.env)
        } else if (r.gone) dead.push(keyOf(s))
        else log.warn('app push failed', { uid, status: r.status, reason: r.reason })
        continue
      }
      if (!cfg.enabled) continue
      try {
        await send({ endpoint: s.endpoint, keys: s.keys }, msg, cfg)
        ok++
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(keyOf(s))
        else log.warn('push failed', { uid, err: errText(e), status: e?.statusCode })
      }
    }
    await docs.tx(async (tx) => {
      const cur = await tx.get(NS, uid)
      if (!cur) return
      const s2 = cur.sent?.day === day(t) ? cur.sent : { day: day(t), n: 0, tags: {} }
      const subs = (cur.subs || []).filter((x) => !dead.includes(keyOf(x))).map((x) => (x.apns && moved.has(x.apns) ? { ...x, env: moved.get(x.apns) } : x))
      tx.set(NS, uid, { ...cur, subs, sent: { ...s2, n: s2.n + (ok ? 1 : 0), tags: payload.tag ? { ...s2.tags, [payload.tag]: t } : s2.tags } })
    })
    return ok
  }

  const test = (user) => notify(user.uid, 'test', { title: 'PropPickz alerts are on', body: 'You’ll get the alerts you chose on this device.', url: '/account', tag: `test-${now()}` })

  /** New ticker changes: to every member who wants them, at their threshold (a few at most). */
  async function tickerEvents(sport, events) {
    if (!anyOn() || !events.length) return 0
    const idx = (await docs.get('pushIndex', 'all'))?.uids || []
    let n = 0
    for (const uid of idx) {
      const d = await docs.get(NS, uid)
      const level = cleanPrefs(d?.prefs).ticker
      if (level === 'off' || !d?.subs?.length) continue
      const mine = events.filter(({ item, ev }) => tickerAlertable(level, item, ev)).slice(0, 2)
      if (!mine.length || !(await isMember(uid))) continue
      for (const { item, ev } of mine) n += await notify(uid, 'ticker', { title: `${item.short} ${item.shortLabel}`, body: ev.text, url: `/${sport}/prop/${encodeURIComponent(item.id)}`, tag: `tick-${item.key}` })
    }
    return n
  }

  return { status, subscribe, unsubscribe, subscribeNative, unsubscribeNative, setPrefs, notify, test, tickerEvents, eraseUser }
}

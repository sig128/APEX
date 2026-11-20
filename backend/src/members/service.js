// What a visitor tells PropPickz outside billing and picks: the consent screen (each acceptance
// kept with the text's version and the app's), the onboarding tour (how far people get), and
// feedback (kept here, and emailed to the team when a mail service is set up).
import crypto from 'node:crypto'
import { ApiError } from '../lib/router.js'
import { log, errText } from '../lib/log.js'

/** Bump with any change to the consent text: everyone is asked again. Keep in step with the app. */
export const CONSENT_VERSION = '2026-11-20'
export const FEEDBACK_KINDS = ['bug', 'feature', 'pick', 'general']
export const TOUR_STEPS = 6
const NS = 'members'
const KEEP_FEEDBACK = 500

const dayOf = (t) => new Date(t).toISOString().slice(0, 10)
const newId = () => crypto.randomBytes(9).toString('base64url')
/** Text from a visitor: no control characters, trimmed, capped. */
export const clip = (s, n) =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, n)
const okDevice = (d) => typeof d === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(d)

export function createMembers({ store, mail = null, now = () => Date.now() }) {
  if (!store) throw new Error('members: a store is required')

  /** The consent screen was accepted on this device (and, signed in, by this account). */
  async function consent({ device, version, app, uid = null }) {
    if (version !== CONSENT_VERSION) throw new ApiError(409, 'consent_changed', 'The terms changed since this page loaded. Reload to read the new ones.')
    if (!okDevice(device)) throw new ApiError(400, 'bad_device', 'This browser didn’t send its id. Reload and try again.')
    const t = now()
    const entry = { at: t, app: clip(app, 40) || null }
    await store.update(NS, `consent-d-${device}`, (cur) => {
      const doc = cur || { device, accepted: {} }
      if (doc.accepted[version] && (!uid || doc.uid === uid)) return undefined
      doc.accepted[version] = doc.accepted[version] || entry
      if (uid) doc.uid = uid
      return doc
    })
    if (uid) {
      await store.update(NS, `consent-u-${uid}`, (cur) => {
        const doc = cur || { uid, accepted: {} }
        if (doc.accepted[version]) return undefined
        doc.accepted[version] = { ...entry, device }
        return doc
      })
    }
    return { ok: true, version, at: t }
  }

  /** Whether this account has accepted the current text (from any device). */
  async function consentOf(uid) {
    const doc = uid ? await store.get(NS, `consent-u-${uid}`) : null
    return { version: CONSENT_VERSION, accepted: Boolean(doc?.accepted?.[CONSENT_VERSION]) }
  }

  /** The tour, counted by day: started, finished, and the step people skip at. */
  async function tour({ action, step }) {
    if (!['start', 'step', 'skip', 'done', 'replay'].includes(action)) throw new ApiError(400, 'bad_event', 'Unknown tour event.')
    const s = Number.isInteger(step) && step >= 0 && step < TOUR_STEPS ? step : null
    const day = dayOf(now())
    await store.update(NS, `tour-${day}`, (cur) => {
      const doc = cur || { day, start: 0, done: 0, replay: 0, skip: {}, reached: {} }
      if (action === 'start' || action === 'done' || action === 'replay') doc[action]++
      if (action === 'skip' && s != null) doc.skip[s] = (doc.skip[s] || 0) + 1
      if (action === 'step' && s != null) doc.reached[s] = (doc.reached[s] || 0) + 1
      return doc
    })
    return { ok: true }
  }

  async function tourStats(days = 30) {
    const out = []
    for (let i = 0; i < days; i++) {
      const d = await store.get(NS, `tour-${dayOf(now() - i * 86_400_000)}`)
      if (d) out.push(d)
    }
    return out
  }

  /**
   * Feedback from the form or a "Was this helpful?" tap. Kept first, so nothing is lost when the
   * mail service is down; then emailed to the team if one is set up.
   */
  async function feedback({ kind, message, rating = null, helpful = null, page, app, device, include = false, user = null, about = null }) {
    const k = FEEDBACK_KINDS.includes(kind) ? kind : 'general'
    const text = clip(message, 4000)
    const isTap = helpful === true || helpful === false
    if (!isTap && text.length < 3) throw new ApiError(400, 'empty', 'Write a few words first.')
    const t = now()
    const item = {
      id: `${t.toString(36)}-${newId()}`,
      at: t,
      kind: k,
      message: text,
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
      helpful: isTap ? helpful : null,
      about: about ? clip(about, 120) : null,
      page: clip(page, 200) || null,
      app: clip(app, 40) || null,
      device: clip(device, 160) || null,
      // the account only when they ticked "include my account details"
      user: include && user ? { uid: user.uid, email: user.email || null, name: user.name || null } : null,
      mailed: false,
    }
    await store.set(NS, `fb-${item.id}`, item)
    await store.update(NS, 'fb-index', (cur) => {
      const ids = [item.id, ...((cur && cur.ids) || [])].slice(0, KEEP_FEEDBACK)
      return { ids }
    })
    if (mail && !isTap) {
      try {
        const sent = await mail(item)
        if (sent) await store.set(NS, `fb-${item.id}`, { ...item, mailed: true })
      } catch (e) {
        log.warn('feedback mail failed', { err: errText(e) })
      }
    }
    return { ok: true, id: item.id }
  }

  async function feedbackList({ limit = 100 } = {}) {
    const idx = await store.get(NS, 'fb-index')
    const ids = ((idx && idx.ids) || []).slice(0, Math.min(500, Math.max(1, limit)))
    const items = await Promise.all(ids.map((id) => store.get(NS, `fb-${id}`)))
    return items.filter(Boolean)
  }

  return { consent, consentOf, tour, tourStats, feedback, feedbackList }
}

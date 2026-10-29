// One AI game analysis per game: written once, stored, and served to every member as many times
// as they like. The first member to analyze a game pays for it (one analysis off their
// allowance); everyone after gets the stored one at once, free. Two members asking at the same
// moment don't pay twice: the second waits for the first to finish.
//
// A game is its league, its two teams and its day, so the same game picked from the schedule or
// typed in gives the same analysis.
import crypto from 'node:crypto'
import { dayET } from '../nfl/proplog.js'

const NS = 'ai-analyses'
const CLAIMS = 'ai-analyses-claim'
const CLAIM_MS = 5 * 60_000 // a writer that hasn't finished by then is taken to have failed
const WAIT_MS = 4 * 60_000
const POLL_MS = 2_500

const norm = (s) =>
  String(s || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

/** The game's day (Eastern): from its start time when the schedule gave one, else its date. */
export function gameDay(game) {
  const iso = Date.parse(game?.commenceTimeIso || '')
  if (Number.isFinite(iso)) return dayET(iso)
  const t = Date.parse(game?.date || '')
  if (Number.isFinite(t)) return new Date(t + 12 * 3600_000).toISOString().slice(0, 10)
  return norm(game?.date)
}

export function gameKey(game, sportKey) {
  return [norm(sportKey || game?.sportKey) || 'unknown', norm(game?.homeTeam), norm(game?.awayTeam), gameDay(game)].join('|')
}

const docId = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 40)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Write-once values shared by every member and every server instance: `claim` says whether this
 * caller writes it, another caller is writing it right now, or it's already there.
 */
export function createShared({ store, ns, ready = (v) => Boolean(v), waitMs = WAIT_MS, pollMs = POLL_MS, claimMs = CLAIM_MS } = {}) {
  // real time on purpose: waits and claims must run out even under a test's frozen clock
  const now = () => Date.now()
  const claims = `${ns}-claim`
  const ok = (v) => (ready(v) ? v : null)

  async function get(key) {
    if (!store) return null
    return ok(await store.get(ns, docId(key)).catch(() => null))
  }

  /**
   * { stored } when it's already written, { mine: token } when this caller should write it, or
   * { wait: true } when another member is writing it right now.
   */
  async function claim(key) {
    const stored = await get(key)
    if (stored) return { stored }
    if (!store) return { mine: 'local' }
    const t = now()
    const token = `${t}-${crypto.randomBytes(6).toString('hex')}`
    const after = await store.update(claims, docId(key), (prev) => (prev?.at && t - prev.at < claimMs ? undefined : { at: t, token }))
    if (after?.token === token) {
      // it may have been finished between the first look and the claim
      const late = await get(key)
      if (late) {
        await release(key, token)
        return { stored: late }
      }
      return { mine: token }
    }
    return { wait: true }
  }

  /** The stored value once the caller writing it finishes, or null if they gave up. */
  async function waitFor(key, { signal } = {}) {
    const end = now() + waitMs
    while (now() < end) {
      await sleep(pollMs)
      if (signal?.aborted) return null
      const v = await get(key)
      if (v) return v
      const c = store ? await store.get(claims, docId(key)).catch(() => null) : null
      if (!c?.at || now() - c.at >= claimMs) return null
    }
    return null
  }

  async function save(key, value) {
    if (!store || !ready(value)) return
    await store.set(ns, docId(key), value)
  }

  /** Lets the next caller write it (after a failed or cut-off attempt). */
  async function release(key, token) {
    if (!store || !token || token === 'local') return
    await store.update(claims, docId(key), (prev) => (prev?.token === token ? { at: 0, token: null } : undefined)).catch(() => {})
  }

  return { get, claim, waitFor, save, release }
}

/** The game analyzer's shared analyses: { prompt, text, model, stop, at } per game. */
export function createSharedAnalyses(opts = {}) {
  const shared = createShared({ ...opts, ns: 'ai-analyses', ready: (v) => typeof v?.text === 'string' && Boolean(v.text.trim()) })
  return {
    ...shared,
    save: (key, { prompt, text, model = null, stop = null, sport = null }) => (typeof prompt === 'string' ? shared.save(key, { v: 1, key, sport, prompt, text, model, stop, at: Date.now() }) : undefined),
  }
}

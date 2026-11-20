// Credits: a monthly allotment for members, spent on the heavy features (a full simulation, a
// bet breakdown, a parlay build), plus top-up packs. Monthly credits reset on the 1st (UTC) and
// don't roll over; top-up credits don't expire. Monthly credits are spent first.
//
// Every spend has a key, so a retry, a double tap or a second tab never charges twice; a use
// that fails gives its credits back. The admin isn't charged. What each action costs in compute
// is logged per day, so the allotment and pack prices can be set from real numbers.
import { ApiError } from '../lib/router.js'
import { envInt } from '../lib/util.js'

export const DEFAULT_COSTS = { sim: 3, simLarge: 5, breakdown: 3, build: 1 }
export const ACTION_LABEL = { sim: 'Simulation', simLarge: 'Large simulation', breakdown: 'Bet breakdown', build: 'Parlay build', grant: 'Credits added', topup: 'Top-up', refund: 'Refund' }
// placeholders until real costs are measured; a pack's price per credit stays above both plans'
// (Pro $29 / 120 = $0.24, Elite $79 / 300 = $0.26), so upgrading beats buying packs
export const PACKS = [
  { id: 'c50', credits: 50, priceUsd: 15 },
  { id: 'c150', credits: 150, priceUsd: 42 },
  { id: 'c500', credits: 500, priceUsd: 135 },
]
const NS = 'credits'
const KEEP_KEYS = 300
const KEEP_LOG = 60
const KEY_RE = /^[A-Za-z0-9:._-]{3,160}$/

export const packOf = (id) => PACKS.find((p) => p.id === id) || null

/** What each action costs (APEX_CREDIT_COSTS can override, e.g. {"sim":4}). */
export function creditCosts(env = process.env) {
  let over = {}
  try {
    over = JSON.parse(env.APEX_CREDIT_COSTS || '{}') || {}
  } catch {
    over = {}
  }
  const out = { ...DEFAULT_COSTS }
  for (const k of Object.keys(DEFAULT_COSTS)) if (Number.isInteger(over[k]) && over[k] >= 0 && over[k] <= 100) out[k] = over[k]
  return out
}

/** Credits a month by plan (APEX_CREDITS_PRO, APEX_CREDITS_ELITE). */
export function allotments() {
  return { free: 0, pro: envInt('APEX_CREDITS_PRO', 120, { min: 0, max: 100_000 }), elite: envInt('APEX_CREDITS_ELITE', 300, { min: 0, max: 100_000 }) }
}

export const periodOf = (t) => new Date(t).toISOString().slice(0, 7)
/** When this month's credits reset: the 1st of next month, midnight UTC. */
export function resetsAt(t) {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/** The document rolled into the current month, with the allotment of the plan held now. */
export function rolled(doc, plan, t, allot = allotments()) {
  const d = doc ? { ...doc, spent: { ...(doc.spent || {}) }, log: [...(doc.log || [])] } : { topup: 0, used: 0, spent: {}, log: [] }
  if (d.period !== periodOf(t)) {
    d.period = periodOf(t)
    d.used = 0
  }
  d.allot = allot[plan] ?? 0
  d.topup = d.topup || 0
  d.used = d.used || 0
  return d
}
export const monthLeft = (d) => Math.max(0, (d.allot || 0) - (d.used || 0))
export const leftOf = (d) => monthLeft(d) + (d.topup || 0)
/** 'out' at nothing left, 'low' once 80% of the month is used (and no top-up to fall back on). */
export function warnOf(d) {
  if (leftOf(d) <= 0) return 'out'
  if (d.allot > 0 && d.used / d.allot >= 0.8 && !(d.topup > 0)) return 'low'
  return null
}
const trimKeys = (spent) => {
  const keys = Object.keys(spent)
  if (keys.length <= KEEP_KEYS) return spent
  const keep = keys.sort((a, b) => (spent[b].at || 0) - (spent[a].at || 0)).slice(0, KEEP_KEYS)
  return Object.fromEntries(keep.map((k) => [k, spent[k]]))
}
const logged = (d, entry) => [{ ...entry, left: leftOf(d) }, ...(d.log || [])].slice(0, KEEP_LOG)

/** Inside the payment's transaction: a paid pack adds its credits (once per invoice). */
export function applyTopup(cur, inv, t) {
  const d = cur ? { ...cur, spent: { ...(cur.spent || {}) }, log: [...(cur.log || [])] } : { topup: 0, used: 0, spent: {}, log: [] }
  const key = `topup:${inv.id}`
  if (d.spent[key]) return d
  d.topup = (d.topup || 0) + inv.credits
  d.spent[key] = { at: t, cost: -inv.credits, action: 'topup' }
  d.log = logged(d, { at: t, kind: 'topup', action: 'topup', credits: inv.credits, ref: inv.id })
  d.updatedAt = t
  return d
}

export function createCredits({ docs, billing, now = () => Date.now(), open = () => false }) {
  // the plan someone actually holds (paid, given by the admin, or a plan code), passes on sale or not
  async function planOf(user) {
    if (!user?.uid) return 'free'
    if (user.admin) return 'admin'
    const g = billing?.aiAccess ? await billing.aiAccess(user) : null
    return g?.allowed ? g.ent?.plan || 'pro' : 'free'
  }

  const view = (d, plan, t) => ({
    plan,
    unlimited: plan === 'admin' || open(),
    period: d.period,
    allot: d.allot,
    used: d.used,
    monthLeft: monthLeft(d),
    topup: d.topup,
    left: leftOf(d),
    warn: plan === 'admin' || open() ? null : warnOf(d),
    resetsAt: resetsAt(t),
    costs: creditCosts(),
    packs: PACKS,
    log: (d.log || []).slice(0, 20).map((e) => ({ ...e, label: ACTION_LABEL[e.action] || e.action })),
  })

  async function status(user) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in to see your credits.')
    const t = now()
    const plan = await planOf(user)
    const d = rolled(await docs.get(NS, user.uid), plan === 'admin' ? 'elite' : plan, t)
    return view(d, plan, t)
  }

  /**
   * Take `cost` credits for an action, once per key. Returns the balance after, or throws 402
   * when there aren't enough. The admin (and local dev) aren't charged.
   */
  async function spend(user, action, { key, cost = creditCosts()[action] } = {}) {
    if (open()) return { ok: true, free: true, cost: 0, left: null, warn: null }
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in to use this.')
    if (!KEY_RE.test(String(key || ''))) throw new ApiError(500, 'credits_key', 'Bad credits key.')
    if (!Number.isInteger(cost) || cost < 0) throw new ApiError(500, 'credits_cost', 'Bad credits cost.')
    const t = now()
    const plan = await planOf(user)
    if (plan === 'admin' || open()) return { ok: true, free: true, cost: 0, left: null, warn: null }
    if (plan === 'free') throw new ApiError(402, 'upgrade', 'This is for members with a Pro or Elite pass.', { need: 'pro' })
    const out = await docs.tx(async (tx) => {
      const d = rolled(await tx.get(NS, user.uid), plan, t)
      if (d.spent[key]) return { already: true, d }
      if (leftOf(d) < cost) return { short: true, d }
      const fromMonth = Math.min(cost, monthLeft(d))
      const fromTop = cost - fromMonth
      d.used += fromMonth
      d.topup -= fromTop
      d.spent = trimKeys({ ...d.spent, [key]: { at: t, cost, fromMonth, fromTop, action } })
      d.log = logged(d, { at: t, kind: 'spend', action, credits: -cost })
      d.updatedAt = t
      tx.set(NS, user.uid, d)
      return { d }
    })
    if (out.short) {
      const v = view(out.d, plan, t)
      throw new ApiError(402, 'credits_out', `This takes ${cost} credits and you have ${v.left} left. Monthly credits reset on the 1st${PACKS.length ? ', or add a top-up' : ''}.`, { need: 'credits', cost, left: v.left, resetsAt: v.resetsAt })
    }
    const v = view(out.d, plan, t)
    return { ok: true, already: Boolean(out.already), cost: out.already ? 0 : cost, left: v.left, warn: v.warn }
  }

  /** Give back what a key took (a failed use). Safe to call twice. */
  async function refund(user, key) {
    if (!user?.uid || !KEY_RE.test(String(key || ''))) return { ok: false }
    const t = now()
    const plan = await planOf(user)
    if (plan === 'admin' || open()) return { ok: true, free: true }
    return docs.tx(async (tx) => {
      const d = rolled(await tx.get(NS, user.uid), plan === 'free' ? 'free' : plan, t)
      const s = d.spent[key]
      if (!s || s.refunded || s.cost <= 0) return { ok: true, none: true }
      // credits from a month that has rolled over go back to top-up, so nothing is lost
      const sameMonth = periodOf(s.at) === d.period
      if (sameMonth) d.used = Math.max(0, d.used - s.fromMonth)
      d.topup += s.fromTop + (sameMonth ? 0 : s.fromMonth)
      d.spent = { ...d.spent, [key]: { ...s, refunded: t } }
      d.log = logged(d, { at: t, kind: 'refund', action: 'refund', credits: s.cost, of: s.action })
      d.updatedAt = t
      tx.set(NS, user.uid, d)
      return { ok: true, credits: s.cost }
    })
  }

  /** Whether a key was already paid for (a repeat view is free). */
  async function paid(user, key) {
    if (!user?.uid) return false
    const d = await docs.get(NS, user.uid)
    const s = d?.spent?.[key]
    return Boolean(s && !s.refunded)
  }

  /** The admin adds credits (top-up balance, which doesn't expire). */
  async function grant(admin, { uid, credits, note }) {
    if (!admin?.admin) throw new ApiError(403, 'admin', 'Admins only.')
    const n = Number(credits)
    if (!uid || !Number.isInteger(n) || n <= 0 || n > 100_000) throw new ApiError(400, 'bad_grant', 'Give 1 to 100,000 credits to a user id.')
    const t = now()
    return docs.tx(async (tx) => {
      const d = rolled(await tx.get(NS, uid), 'free', t)
      d.topup += n
      d.log = logged(d, { at: t, kind: 'grant', action: 'grant', credits: n, note: note ? String(note).slice(0, 140) : null, by: admin.email || admin.uid })
      d.updatedAt = t
      // the allotment is re-read from the plan on every use; only the balance is stored
      tx.set(NS, uid, d)
      return { ok: true, uid, topup: d.topup }
    })
  }

  // ---- what things really cost (brief: measure before setting prices) ------------------------
  const costLog = new Map()
  /** Note one use: how long it took on the server and what it was charged. */
  function measure(action, { ms = 0, credits = 0, tokens = 0 } = {}) {
    const day = new Date(now()).toISOString().slice(0, 10)
    const k = `${day}:${action}`
    const cur = costLog.get(k) || { day, action, n: 0, ms: 0, credits: 0, tokens: 0 }
    cur.n++
    cur.ms += Math.round(ms)
    cur.credits += credits
    cur.tokens += tokens
    costLog.set(k, cur)
    if (costLog.size > 400) costLog.delete(costLog.keys().next().value)
    // kept in the store too, a day per document, so every instance adds up
    docs.tx(async (tx) => {
      const id = `cost-${day}`
      const doc = (await tx.get(NS, id)) || { day, actions: {} }
      const a = doc.actions[action] || { n: 0, ms: 0, credits: 0, tokens: 0 }
      doc.actions[action] = { n: a.n + 1, ms: a.ms + Math.round(ms), credits: a.credits + credits, tokens: a.tokens + tokens }
      tx.set(NS, id, doc)
    }).catch(() => {})
  }
  async function costs(days = 14) {
    const out = []
    const t = now()
    for (let i = 0; i < days; i++) {
      const day = new Date(t - i * 86_400_000).toISOString().slice(0, 10)
      const doc = await docs.get(NS, `cost-${day}`).catch(() => null)
      if (doc?.actions) for (const [action, a] of Object.entries(doc.actions)) out.push({ day, action, ...a, avgMs: a.n ? Math.round(a.ms / a.n) : 0 })
    }
    return out
  }

  return { status, spend, refund, paid, grant, measure, costs, planOf }
}

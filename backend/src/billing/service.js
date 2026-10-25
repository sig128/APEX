// Passes: invoices with a unique USDC amount, on-chain confirmation, 30-day periods, a 7-day
// grace period, then lockout. Admin comps, plan codes and daily AI allowances live here too.
import crypto from 'node:crypto'
import { billingConfig, PLAN_RANK, DAY_MS, NETWORKS, usdToUnits, formatUnits, publicBillingConfig } from './config.js'
import { createChain } from './chain.js'
import { createDocs } from './docs.js'
import { ApiError } from '../lib/router.js'
import { log, errText } from '../lib/log.js'

export const LIFETIME = Date.UTC(2100, 0, 1)
const SKEW_MS = 5 * 60_000 // a transfer mined slightly before the invoice (clock skew) still counts
const LATE_MS = 60 * 60_000 // ...and up to an hour after it expired
const RESERVE_MS = 48 * 3600_000 // a unique amount stays reserved this long
const MAX_INVOICES_PER_DAY = 20
const TX_RE = /^0x[0-9a-fA-F]{64}$/

export const atLeast = (plan, need) => (PLAN_RANK[plan] ?? 0) >= (PLAN_RANK[need] ?? 0)

/**
 * New period end after buying `planId` at time `at`:
 * lapsed or new -> now + period; same plan -> extend; switching -> now + period + the unused
 * time of the old plan converted at the price ratio. periodMs 'lifetime' = never expires.
 */
export function applyPurchase(sub, planId, at, cfg, periodMs = cfg.periodDays * DAY_MS) {
  if (periodMs === 'lifetime') return { plan: planId, paidUntil: LIFETIME, lifetime: true }
  // a revoked pass gives no credit toward the next one
  const active = sub && sub.plan && !sub.revoked && sub.paidUntil > at ? sub : null
  if (active?.lifetime) return { plan: atLeast(active.plan, planId) ? active.plan : planId, paidUntil: LIFETIME, lifetime: true }
  if (!active) return { plan: planId, paidUntil: at + periodMs, lifetime: false }
  if (active.plan === planId) return { plan: planId, paidUntil: active.paidUntil + periodMs, lifetime: false }
  const oldPrice = cfg.plans[active.plan]?.priceUsd || 0
  const newPrice = cfg.plans[planId]?.priceUsd || 1
  const credit = Math.round(((active.paidUntil - at) * oldPrice) / newPrice)
  return { plan: planId, paidUntil: at + periodMs + Math.max(0, credit), lifetime: false }
}

/** What a subscription document grants right now. */
export function entitlementOf(sub, at, cfg) {
  if (!sub || !sub.plan || !cfg.plans[sub.plan]) return { plan: 'free', status: 'none', paidPlan: null, paidUntil: null, graceUntil: null, source: null, lifetime: false, daysLeft: 0 }
  const lifetime = Boolean(sub.lifetime) || sub.paidUntil >= LIFETIME
  const graceUntil = lifetime ? LIFETIME : sub.paidUntil + cfg.graceDays * DAY_MS
  const base = { paidPlan: sub.plan, paidUntil: sub.paidUntil, graceUntil, source: sub.source || null, lifetime }
  if (sub.revoked) return { ...base, plan: 'free', status: 'expired', daysLeft: 0 }
  if (lifetime || at < sub.paidUntil) return { ...base, plan: sub.plan, status: 'active', daysLeft: lifetime ? null : Math.ceil((sub.paidUntil - at) / DAY_MS) }
  if (at < graceUntil) return { ...base, plan: sub.plan, status: 'grace', daysLeft: Math.ceil((graceUntil - at) / DAY_MS) }
  return { ...base, plan: 'free', status: 'expired', daysLeft: 0 }
}

/** YYYY-MM-DD in the usage time zone (allowances reset at local midnight). */
export function dayKey(at, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  return f.format(new Date(at))
}

/** First minute of the next local day, found by bisection (handles DST without a tz library). */
export function nextReset(at, tz) {
  const today = dayKey(at, tz)
  let lo = at
  let hi = at + 26 * 3600_000
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2)
    if (dayKey(mid, tz) === today) lo = mid
    else hi = mid
  }
  return Math.floor(hi / 60_000) * 60_000
}

const invId = () => `inv_${crypto.randomBytes(12).toString('hex')}`

export function createBilling({ docs, getFirestore, store, chainFor, now = () => Date.now(), lookupUid, onChange } = {}) {
  const d = docs || createDocs({ getFirestore, store })
  const chains = new Map()
  const subCache = new Map() // uid -> { sub, until }
  const listeners = new Set()
  if (typeof onChange === 'function') listeners.add(onChange)

  function chain(cfg) {
    if (chainFor) return chainFor(cfg.network, cfg)
    const k = `${cfg.network}|${cfg.rpcUrl}`
    if (!chains.has(k)) chains.set(k, createChain({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId }))
    return chains.get(k)
  }

  function changed(uid) {
    subCache.delete(uid)
    for (const fn of listeners) {
      try {
        fn(uid)
      } catch (e) {
        log.warn('billing listener failed', { err: errText(e) })
      }
    }
  }

  async function subscription(uid) {
    const hit = subCache.get(uid)
    if (hit && hit.until > now()) return hit.sub
    const sub = await d.get('subscriptions', uid)
    const cfg = billingConfig()
    const ent = entitlementOf(sub, now(), cfg)
    subCache.set(uid, { sub, until: now() + (ent.status === 'active' ? 60_000 : 5_000) })
    if (subCache.size > 20_000) subCache.delete(subCache.keys().next().value)
    return sub
  }

  /** What the user can use right now. With the paywall off that's everything ('open'). */
  async function entitlement(user, { ignorePaywall = false } = {}) {
    const cfg = billingConfig()
    if (!cfg.paywall && !ignorePaywall) return { plan: 'elite', status: 'open', paidPlan: null, paidUntil: null, graceUntil: null, source: null, lifetime: false, daysLeft: null }
    if (user?.admin) return { plan: 'elite', status: 'admin', paidPlan: null, paidUntil: null, graceUntil: null, source: 'admin', lifetime: true, daysLeft: null }
    if (!user?.uid) return { plan: 'free', status: 'anonymous', paidPlan: null, paidUntil: null, graceUntil: null, source: null, lifetime: false, daysLeft: 0 }
    return entitlementOf(await subscription(user.uid), now(), cfg)
  }

  /** The plan the user actually holds, paywall or not (what gets stored on their page). */
  const heldPlan = (user) => entitlement(user, { ignorePaywall: true })

  function invoiceView(inv, cfg = billingConfig()) {
    if (!inv) return null
    const net = NETWORKS[inv.network] || NETWORKS.base
    const t = now()
    const status = inv.status === 'open' && t > inv.expiresAt + LATE_MS ? 'expired' : inv.status
    return {
      id: inv.id,
      plan: inv.plan,
      planName: cfg.plans[inv.plan]?.name || inv.plan,
      status,
      usd: inv.usd,
      units: inv.units,
      amount: formatUnits(inv.units),
      token: inv.token,
      treasury: inv.treasury,
      network: inv.network,
      networkName: net.name,
      chainId: inv.chainId,
      explorer: net.explorer,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      // EIP-681: wallets that read QR codes fill in token, recipient and the exact amount
      payUri: `ethereum:${inv.token}@${inv.chainId}/transfer?address=${inv.treasury}&uint256=${inv.units}`,
      txHash: inv.txHash || null,
      paidAt: inv.paidAt || null,
      confirmations: cfg.confirmations,
    }
  }

  function requireUser(user) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in to buy a pass.')
    if (user.uid === 'admin') throw new ApiError(400, 'admin_key', 'The admin key has every plan already.')
  }

  async function createInvoice(user, planId) {
    requireUser(user)
    const cfg = billingConfig()
    if (!cfg.paywall || !cfg.treasury) throw new ApiError(409, 'billing_off', 'Passes are not on sale right now.')
    const plan = cfg.plans[planId]
    if (!plan) throw new ApiError(400, 'bad_plan', 'Pick Pro or Elite.')
    const sub = await d.get('subscriptions', user.uid)
    if (sub?.lifetime && atLeast(sub.plan, planId)) throw new ApiError(409, 'lifetime', 'You already have this plan for life.')
    let startBlock = null
    try {
      startBlock = await Promise.race([chain(cfg).blockNumber(), new Promise((_, rej) => setTimeout(() => rej(new Error('slow rpc')), 3000))])
    } catch (e) {
      log.warn('start block lookup failed', { err: errText(e) })
    }
    const t = now()
    const today = dayKey(t, cfg.usageTz)
    const base = BigInt(usdToUnits(plan.priceUsd))
    for (let attempt = 0; attempt < 16; attempt++) {
      // Unique cents-of-a-cent tag so one transfer can only ever match one invoice.
      const units = (base + 1n + BigInt(crypto.randomInt(9999))).toString()
      const reserveId = `${cfg.network}_${cfg.treasury}_${units}`
      const result = await d.tx(async (tx) => {
        const u = (await tx.get('billingUsers', user.uid)) || {}
        const openId = u.open?.[planId]
        const open = openId ? await tx.get('billingInvoices', openId) : null
        const reserved = await tx.get('billingAmounts', reserveId)
        if (open && open.status === 'open' && open.expiresAt - t > 2 * 3600_000 && open.treasury === cfg.treasury && open.network === cfg.network && open.usd === plan.priceUsd) return { reuse: open }
        if (reserved && reserved.until > t) return { taken: true }
        const count = u.day === today ? u.count || 0 : 0
        if (count >= MAX_INVOICES_PER_DAY) throw new ApiError(429, 'too_many_invoices', 'That is a lot of payment requests for one day. Try again tomorrow.')
        const inv = {
          id: invId(),
          uid: user.uid,
          email: user.email || null,
          plan: planId,
          usd: plan.priceUsd,
          units,
          token: cfg.token,
          treasury: cfg.treasury,
          network: cfg.network,
          chainId: cfg.chainId,
          createdAt: t,
          expiresAt: t + cfg.invoiceTtlMs,
          startBlock,
          status: 'open',
        }
        tx.set('billingAmounts', reserveId, { invoiceId: inv.id, until: t + RESERVE_MS })
        tx.set('billingInvoices', inv.id, inv)
        tx.merge('billingUsers', user.uid, { open: { [planId]: inv.id }, day: today, count: count + 1, email: user.email || null, updatedAt: t })
        return { inv }
      })
      if (result.reuse) return invoiceView(result.reuse, cfg)
      if (result.inv) return invoiceView(result.inv, cfg)
    }
    throw new ApiError(503, 'busy', 'Could not reserve a payment amount. Try again.')
  }

  async function ownedInvoice(user, id) {
    if (typeof id !== 'string' || !/^inv_[0-9a-f]{24}$/.test(id)) throw new ApiError(404, 'not_found', 'No such payment request.')
    const inv = await d.get('billingInvoices', id)
    if (!inv || (inv.uid !== user?.uid && !user?.admin)) throw new ApiError(404, 'not_found', 'No such payment request.')
    return inv
  }

  async function getInvoice(user, id) {
    requireUser(user)
    return invoiceView(await ownedInvoice(user, id))
  }

  async function confirm(user, id, txHash) {
    requireUser(user)
    if (typeof txHash !== 'string' || !TX_RE.test(txHash.trim())) throw new ApiError(400, 'bad_hash', 'That does not look like a transaction hash (0x followed by 64 characters).')
    const hash = txHash.trim().toLowerCase()
    const cfg = billingConfig()
    const inv = await ownedInvoice(user, id)
    if (inv.status === 'paid') {
      if (inv.txHash === hash) return { status: 'paid', invoice: invoiceView(inv, cfg), entitlement: await entitlement(user) }
      throw new ApiError(409, 'already_paid', 'This request is already paid.')
    }
    const v = await chain({ ...cfg, network: inv.network, chainId: inv.chainId, rpcUrl: inv.network === cfg.network ? cfg.rpcUrl : NETWORKS[inv.network].rpc }).verifyTransfer({ txHash: hash, token: inv.token, to: inv.treasury, amount: inv.units, minConfirmations: cfg.confirmations })
    if (v.status === 'pending' || v.status === 'confirming') return { status: v.status, confirmations: v.confirmations || 0, needed: cfg.confirmations, invoice: invoiceView(inv, cfg) }
    if (v.status === 'failed') throw new ApiError(400, 'tx_failed', 'That transaction failed on-chain, so nothing was sent.')
    if (v.status !== 'ok') throw new ApiError(400, 'tx_mismatch', `That transaction is not a transfer of exactly ${formatUnits(inv.units)} USDC to the APEX wallet on ${NETWORKS[inv.network].name}.`)
    if (v.timestamp && (v.timestamp < inv.createdAt - SKEW_MS || v.timestamp > inv.expiresAt + LATE_MS)) throw new ApiError(400, 'tx_window', 'That transfer was made outside this payment request’s window.')
    const t = now()
    const claimId = `${inv.network}_${hash}`
    const result = await d.tx(async (tx) => {
      const claim = await tx.get('billingTx', claimId)
      const cur = await tx.get('billingInvoices', inv.id)
      const sub = await tx.get('subscriptions', inv.uid)
      const u = (await tx.get('billingUsers', inv.uid)) || {}
      if (claim && claim.invoiceId !== inv.id) return { used: true }
      if (cur?.status === 'paid') return { already: cur }
      const next = applyPurchase(sub, inv.plan, t, cfg)
      tx.set('billingTx', claimId, { invoiceId: inv.id, uid: inv.uid, at: t })
      tx.set('billingInvoices', inv.id, { ...cur, status: 'paid', txHash: hash, paidAt: t, from: v.from, blockNumber: v.blockNumber })
      tx.set('billingPayments', inv.id, { invoiceId: inv.id, uid: inv.uid, email: inv.email, plan: inv.plan, usd: inv.usd, units: inv.units, txHash: hash, network: inv.network, from: v.from, createdAt: t })
      tx.set('subscriptions', inv.uid, { ...next, source: 'usdc', lastPayment: inv.id, wallet: v.from, updatedAt: t, email: inv.email || sub?.email || null })
      const payments = [inv.id, ...(u.payments || [])].slice(0, 30)
      tx.merge('billingUsers', inv.uid, { open: { [inv.plan]: null }, payments, updatedAt: t })
      return { paid: true }
    })
    if (result.used) return { status: 'used' }
    try {
      await d.merge('billingAmounts', `${inv.network}_${inv.treasury}_${inv.units}`, { until: 0 })
    } catch {
      /* reservation expires on its own */
    }
    changed(inv.uid)
    const fresh = await d.get('billingInvoices', inv.id)
    return { status: 'paid', invoice: invoiceView(fresh, cfg), entitlement: await entitlement({ uid: inv.uid }) }
  }

  /** Find the payment on-chain without a pasted hash. */
  async function scan(user, id) {
    requireUser(user)
    const cfg = billingConfig()
    const inv = await ownedInvoice(user, id)
    if (inv.status === 'paid') return { status: 'paid', invoice: invoiceView(inv, cfg) }
    const c = chain({ ...cfg, network: inv.network, chainId: inv.chainId, rpcUrl: inv.network === cfg.network ? cfg.rpcUrl : NETWORKS[inv.network].rpc })
    const head = await c.blockNumber()
    // Base makes a block about every 2 seconds. Start a little before the request was made (the
    // same clock-skew allowance confirm() gives), then pick up where the last scan stopped, with
    // a few blocks of overlap in case the newest ones were reorganized.
    const skewBlocks = Math.ceil(SKEW_MS / 2000)
    const createdBlock = inv.startBlock ?? head - Math.ceil((now() - inv.createdAt) / 2000)
    const first = Math.max(0, createdBlock - skewBlocks)
    const from = inv.scannedTo != null ? Math.max(first, inv.scannedTo - cfg.confirmations) : first
    const found = await c.findTransfer({ token: inv.token, to: inv.treasury, amount: inv.units, fromBlock: from, toBlock: head })
    if (found.txHash) return confirm(user, id, found.txHash)
    await d.merge('billingInvoices', inv.id, { scannedTo: found.scannedTo ?? head })
    return { status: 'not_found', invoice: invoiceView(inv, cfg) }
  }

  async function resolveUid({ uid, email }) {
    if (uid && typeof uid === 'string') return uid
    if (!email) throw new ApiError(400, 'bad_target', 'Give an email or a uid.')
    const e = String(email).trim().toLowerCase()
    if (lookupUid) {
      try {
        const found = await lookupUid(e)
        if (found) return found
      } catch (err) {
        log.warn('uid lookup failed', { err: errText(err) })
      }
    }
    const rows = await d.recent('billingUsers', { field: 'updatedAt', limit: 200, where: [['email', '==', e]] })
    if (rows[0]) return rows[0].id
    throw new ApiError(404, 'no_user', 'No user with that email has signed in yet.')
  }

  async function grant(admin, { uid, email, plan, days, note }) {
    if (!admin?.admin) throw new ApiError(403, 'admin', 'Admins only.')
    const cfg = billingConfig()
    if (!cfg.plans[plan]) throw new ApiError(400, 'bad_plan', 'Pick pro or elite.')
    const target = await resolveUid({ uid, email })
    const lifetime = days === 'lifetime'
    const n = lifetime ? null : Math.round(Number(days))
    if (!lifetime && !(n >= 1 && n <= 3650)) throw new ApiError(400, 'bad_days', 'Days must be 1 to 3650, or lifetime.')
    const t = now()
    const next = await d.tx(async (tx) => {
      const sub = await tx.get('subscriptions', target)
      const out = { ...applyPurchase(sub, plan, t, cfg, lifetime ? 'lifetime' : n * DAY_MS), source: 'comp', note: note ? String(note).slice(0, 140) : null, grantedBy: admin.email || admin.uid, updatedAt: t, email: email ? String(email).toLowerCase() : sub?.email || null }
      tx.set('subscriptions', target, out)
      return out
    })
    changed(target)
    return { uid: target, subscription: next, entitlement: entitlementOf(next, t, cfg) }
  }

  async function revoke(admin, { uid, email }) {
    if (!admin?.admin) throw new ApiError(403, 'admin', 'Admins only.')
    const target = await resolveUid({ uid, email })
    const t = now()
    await d.merge('subscriptions', target, { revoked: true, revokedAt: t, revokedBy: admin.email || admin.uid, updatedAt: t })
    changed(target)
    return { uid: target, revoked: true }
  }

  /** Re-enable after a revoke (a new purchase also clears it). */
  async function clearRevoke(uid) {
    await d.merge('subscriptions', uid, { revoked: false })
    changed(uid)
  }

  // Follow-up questions in the analyzer get three per analysis allowance.
  function limitFor(ent, kind, cfg) {
    if (ent.status === 'open') return Infinity
    const base = kind === 'followups' ? 'analyses' : kind
    const mult = kind === 'followups' ? 3 : 1
    const elite = (cfg.plans.elite.limits[base] || 0) * mult
    if (ent.status === 'admin') return Math.max(elite * 10, 100)
    if (!atLeast(ent.plan, 'pro')) return 0
    return (cfg.plans[ent.plan]?.limits?.[base] ?? 0) * mult
  }
  const KIND_NAME = { analyses: 'game analyses', aiReads: 'AI reads', followups: 'follow-up questions' }

  async function useQuota(user, ent, kind) {
    const cfg = billingConfig()
    const limit = limitFor(ent, kind, cfg)
    if (limit === Infinity) return { used: 0, limit: null }
    if (!limit) throw new ApiError(402, 'upgrade', kind === 'aiReads' ? 'AI picks are part of Pro and Elite.' : 'The AI analyzer is part of Pro and Elite.', { need: 'pro', plan: ent.plan, status: ent.status })
    const t = now()
    const day = dayKey(t, cfg.usageTz)
    const id = `${user.uid}_${day}`
    return d.tx(async (tx) => {
      const cur = (await tx.get('billingUsage', id)) || { uid: user.uid, day }
      const used = cur[kind] || 0
      if (used >= limit) throw new ApiError(429, 'quota', `You've used today's ${limit} ${KIND_NAME[kind] || kind}. They reset at midnight.`, { resetsAt: nextReset(t, cfg.usageTz), limit, retryAfter: Math.ceil((nextReset(t, cfg.usageTz) - t) / 1000) })
      tx.set('billingUsage', id, { ...cur, [kind]: used + 1, updatedAt: t })
      return { used: used + 1, limit, resetsAt: nextReset(t, cfg.usageTz) }
    })
  }

  async function refundQuota(user, kind) {
    if (!user?.uid) return
    const cfg = billingConfig()
    const t = now()
    const id = `${user.uid}_${dayKey(t, cfg.usageTz)}`
    await d.tx(async (tx) => {
      const cur = await tx.get('billingUsage', id)
      if (!cur || !(cur[kind] > 0)) return
      tx.set('billingUsage', id, { ...cur, [kind]: cur[kind] - 1, updatedAt: t })
    })
  }

  async function usage(user, ent) {
    const cfg = billingConfig()
    const t = now()
    const day = dayKey(t, cfg.usageTz)
    const cur = user?.uid ? (await d.get('billingUsage', `${user.uid}_${day}`)) || {} : {}
    const row = (kind) => {
      const limit = limitFor(ent, kind, cfg)
      return { used: cur[kind] || 0, limit: limit === Infinity ? null : limit }
    }
    return { day, analyses: row('analyses'), aiReads: row('aiReads'), followups: row('followups'), resetsAt: nextReset(t, cfg.usageTz) }
  }

  async function me(user) {
    if (!user) throw new ApiError(401, 'signin', 'Sign in first.')
    const cfg = billingConfig()
    const ent = await entitlement(user)
    const u = user.uid !== 'admin' ? (await d.get('billingUsers', user.uid)) || {} : {}
    const open = []
    for (const id of Object.values(u.open || {}).filter(Boolean)) {
      const inv = await d.get('billingInvoices', id)
      const v = invoiceView(inv, cfg)
      if (v && v.status === 'open') open.push(v)
    }
    const payments = []
    for (const id of (u.payments || []).slice(0, 12)) {
      const p = await d.get('billingPayments', id)
      if (p) payments.push({ id: p.invoiceId, plan: p.plan, usd: p.usd, amount: formatUnits(p.units), txHash: p.txHash, network: p.network, explorer: NETWORKS[p.network]?.explorer, at: p.createdAt })
    }
    return {
      user: { uid: user.uid, email: user.email, name: user.name, picture: user.picture, admin: Boolean(user.admin) },
      entitlement: ent,
      usage: await usage(user, ent),
      open,
      payments,
      config: publicBillingConfig(cfg),
    }
  }

  async function payments(admin, { limit = 50 } = {}) {
    if (!admin?.admin) throw new ApiError(403, 'admin', 'Admins only.')
    return (await d.recent('billingPayments', { field: 'createdAt', limit })).map((p) => ({ ...p, amount: formatUnits(p.units), explorer: NETWORKS[p.network]?.explorer }))
  }

  async function subscriptions(admin, { limit = 100 } = {}) {
    if (!admin?.admin) throw new ApiError(403, 'admin', 'Admins only.')
    const cfg = billingConfig()
    return (await d.recent('subscriptions', { field: 'updatedAt', limit })).map((s) => ({ uid: s.id, email: s.email || null, source: s.source, note: s.note || null, ...entitlementOf(s, now(), cfg) }))
  }

  return {
    docs: d,
    docsKind: d.kind,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    entitlement,
    heldPlan,
    subscription,
    createInvoice,
    getInvoice,
    confirm,
    scan,
    grant,
    revoke,
    clearRevoke,
    useQuota,
    refundQuota,
    usage,
    me,
    payments,
    subscriptions,
    forget: (uid) => subCache.delete(uid),
    invoiceView,
  }
}

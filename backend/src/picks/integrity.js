// Fair play on the leaderboard: one person, one record. Three checks, each with a reason the
// admin can read:
//   wallet   two accounts paid for passes from the same wallet
//   mirror   two accounts that share a network posted opposite sides of the same prop on the same
//            day (between them, one side always wins)
//   deletes  picks deleted before kickoff so often that the record keeps only the ones that went
//            well (selective posting)
// A shared network on its own is noted for the admin only, since households and campuses share
// one. Strong signals (wallet, mirror, deletes) hold the account off the public leaderboard until
// the admin clears them; the person still has their page, picks and private groups.
// Network addresses are never stored: only a keyed one-way fingerprint, kept 30 days.
import crypto from 'node:crypto'
import { log, errText } from '../lib/log.js'

const NS = 'integrity'
const DAY = 86_400_000
const WINDOW = 30 * DAY
const KEEP_FLAGS = 400
export const DELETE_RULE = { min: 8, share: 0.4 }
export const STRONG = new Set(['wallet', 'mirror', 'deletes'])

function fpKey(env = process.env) {
  const own = env.APEX_FINGERPRINT_SECRET
  if (own && own.length >= 16) return own
  const admin = env.ADMIN_SPORTS_KEY || env.APEX_STREAM_SECRET
  if (admin && admin.length >= 16) return crypto.createHash('sha256').update(`apex-fp:${admin}`).digest('hex')
  return 'proppickz-local-fingerprint'
}

/** A keyed one-way fingerprint of a network address (the address itself is never kept). */
export function fingerprint(ip, env = process.env) {
  const s = String(ip || '').trim()
  if (!s) return null
  return crypto.createHmac('sha256', fpKey(env)).update(s).digest('hex').slice(0, 24)
}

/** The opposite side of a two-sided leg, keyed by player (or team), market and line. */
export function legKey(l) {
  if (!l || l.oneSided || !l.market || !Number.isFinite(Number(l.line))) return null
  const who = l.playerId || (l.teamId ? `t${l.teamId}` : null)
  if (!who) return null
  return { key: `${l.sport || 'nfl'}:${who}:${l.market}:${Number(l.line)}`, side: l.side === 'u' ? 'u' : 'o' }
}
const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24)
const dayOf = (t) => new Date(t).toISOString().slice(0, 10)
const pairId = (kind, uids) => `flag-${kind}-${hashOf([...uids].sort().join('|'))}`

/** Deleted-before-kickoff share over the window: does it cross the line? */
export function deleteShare(posts = [], deletes = [], t = Date.now()) {
  const p = posts.filter((x) => t - x < WINDOW).length
  const d = deletes.filter((x) => t - x < WINDOW).length
  return { posted: p, deleted: d, share: p ? d / p : 0, over: d >= DELETE_RULE.min && p > 0 && d / p >= DELETE_RULE.share }
}

export function createIntegrity({ docs, now = () => Date.now(), env = process.env }) {
  let holdMemo = null
  let walletMemo = null

  // the open strong flags in one small document, so the leaderboard reads one thing
  const holdsWith = (doc, f) => {
    const list = (doc?.list || []).filter((x) => x.id !== f.id)
    return { list: STRONG.has(f.kind) && !f.cleared ? [{ id: f.id, kind: f.kind, uids: f.uids }, ...list].slice(0, 500) : list }
  }

  async function raise(kind, uids, detail) {
    const id = pairId(kind, uids)
    const t = now()
    try {
      await docs.tx(async (tx) => {
        const cur = await tx.get(NS, id)
        const idx = (await tx.get(NS, 'flags-index')) || { ids: [] }
        const held = await tx.get(NS, 'holds')
        const next = cur ? { ...cur, n: (cur.n || 1) + 1, last: t, detail } : { id, kind, uids: [...uids].sort(), detail, at: t, last: t, n: 1, cleared: null }
        // cleared earlier and seen again much later: it comes back for another look
        if (cur?.cleared && t - cur.cleared.at > 7 * DAY && kind !== 'network') next.cleared = null
        tx.set(NS, id, next)
        if (!idx.ids.includes(id)) tx.set(NS, 'flags-index', { ids: [id, ...idx.ids].slice(0, KEEP_FLAGS) })
        if (STRONG.has(kind)) tx.set(NS, 'holds', holdsWith(held, next))
      })
    } catch (e) {
      log.warn('integrity flag failed', { kind, err: errText(e) })
    }
    holdMemo = null
  }

  /**
   * A pick was posted: note the network fingerprint, look for another account on it, and for the
   * opposite side of these legs posted today by an account that shares a network or a wallet.
   */
  async function notePost(uid, { ip = null, legs = [] } = {}) {
    if (!uid) return
    const t = now()
    const fp = fingerprint(ip, env)
    try {
      // the person's own trail: when they posted, and the networks they posted from
      let others = []
      await docs.tx(async (tx) => {
        const who = (await tx.get(NS, `who-${uid}`)) || { posts: [], deletes: [], nets: [] }
        const net = fp ? (await tx.get(NS, `net-${fp}`)) || { seen: [] } : null
        const posts = [...who.posts.filter((x) => t - x < WINDOW), t].slice(-400)
        const nets = fp ? [{ fp, at: t }, ...who.nets.filter((x) => x.fp !== fp && t - x.at < WINDOW)].slice(0, 20) : who.nets
        tx.set(NS, `who-${uid}`, { ...who, posts, nets, updatedAt: t })
        if (net) {
          const seen = [{ uid, at: t }, ...net.seen.filter((x) => x.uid !== uid && t - x.at < WINDOW)].slice(0, 30)
          others = seen.filter((x) => x.uid !== uid).map((x) => x.uid)
          tx.set(NS, `net-${fp}`, { seen, updatedAt: t })
        }
      })
      for (const o of others) await raise('network', [uid, o], 'Posted picks from the same network in the last 30 days.')
      // opposite sides of the same prop, today
      const linked = new Set([...others, ...(await walletPeers(uid))])
      for (const l of legs) {
        const k = legKey(l)
        if (!k) continue
        const id = `side-${dayOf(t)}-${hashOf(k.key)}`
        let mirror = []
        await docs.tx(async (tx) => {
          const cur = (await tx.get(NS, id)) || { o: [], u: [] }
          const mine = [...new Set([...(cur[k.side] || []), uid])].slice(-50)
          mirror = (cur[k.side === 'o' ? 'u' : 'o'] || []).filter((x) => x !== uid)
          tx.set(NS, id, { ...cur, [k.side]: mine, at: t })
        })
        for (const o of mirror) if (linked.has(o)) await raise('mirror', [uid, o], `Posted opposite sides of ${l.name || 'the same player'} ${l.label || ''} on the same day, from a shared network or wallet.`.replace(/\s+,/, ','))
      }
    } catch (e) {
      log.warn('integrity post note failed', { err: errText(e) })
    }
  }

  /** A pick was deleted before kickoff: count it, and flag a habit of it. */
  async function noteDelete(uid) {
    if (!uid) return
    const t = now()
    let share = null
    try {
      await docs.tx(async (tx) => {
        const who = (await tx.get(NS, `who-${uid}`)) || { posts: [], deletes: [], nets: [] }
        const deletes = [...who.deletes.filter((x) => t - x < WINDOW), t].slice(-200)
        share = deleteShare(who.posts, deletes, t)
        tx.set(NS, `who-${uid}`, { ...who, deletes, updatedAt: t })
      })
      if (share?.over) await raise('deletes', [uid], `Deleted ${share.deleted} of ${share.posted} picks before kickoff in 30 days.`)
    } catch (e) {
      log.warn('integrity delete note failed', { err: errText(e) })
    }
  }

  /** Accounts that paid from the same wallet (from the payment records), kept for ten minutes. */
  async function walletLinks() {
    const t = now()
    if (walletMemo && walletMemo.until > t) return walletMemo.value
    const by = new Map()
    try {
      const pays = await docs.recent('billingPayments', { field: 'createdAt', limit: 1000 })
      for (const p of pays) {
        const w = String(p.from || '').toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(w) || !p.uid) continue
        if (!by.has(w)) by.set(w, new Set())
        by.get(w).add(p.uid)
      }
    } catch (e) {
      log.warn('integrity wallets failed', { err: errText(e) })
    }
    const groups = [...by.values()].filter((s) => s.size > 1).map((s) => [...s])
    walletMemo = { value: groups, until: t + 10 * 60_000 }
    return groups
  }
  async function walletPeers(uid) {
    return (await walletLinks()).filter((g) => g.includes(uid)).flatMap((g) => g.filter((x) => x !== uid))
  }

  /** Raise any wallet flags not raised yet (cheap; run with the admin view and the holds). */
  async function syncWallets() {
    for (const g of await walletLinks()) {
      const id = pairId('wallet', g)
      if (!(await docs.get(NS, id))) await raise('wallet', g, `${g.length} accounts paid for passes from the same wallet.`)
    }
  }

  /** Every flag, newest first (for the admin). */
  async function list({ limit = 200 } = {}) {
    await syncWallets()
    const idx = (await docs.get(NS, 'flags-index')) || { ids: [] }
    const out = []
    for (const id of idx.ids.slice(0, limit)) {
      const f = await docs.get(NS, id)
      if (f) out.push({ ...f, strong: STRONG.has(f.kind) })
    }
    return out.sort((a, b) => b.last - a.last)
  }

  /** Accounts held off the public leaderboard (uid -> why): an open strong flag. Kept a minute. */
  async function holds() {
    const t = now()
    if (holdMemo && holdMemo.until > t) return holdMemo.value
    const held = new Map()
    try {
      // new shared wallets are found every ten minutes at most (the payments read is cached)
      if (!walletMemo || walletMemo.until <= t) await syncWallets()
      const doc = await docs.get(NS, 'holds')
      for (const f of doc?.list || []) for (const u of f.uids) if (!held.has(u)) held.set(u, f.kind)
    } catch (e) {
      log.warn('integrity holds failed', { err: errText(e) })
    }
    holdMemo = { value: held, until: t + 60_000 }
    return held
  }

  /** The admin clears a flag after a look (or puts it back). */
  async function clear(admin, { id, undo = false } = {}) {
    if (!admin?.admin) return { ok: false }
    const key = String(id || '')
    if (!/^flag-[a-z]+-[0-9a-f]{24}$/.test(key)) return { ok: false, missing: true }
    let found = false
    await docs.tx(async (tx) => {
      const f = await tx.get(NS, key)
      const held = await tx.get(NS, 'holds')
      if (!f) return
      found = true
      const next = { ...f, cleared: undo ? null : { at: now(), by: admin.email || admin.uid } }
      tx.set(NS, key, next)
      if (STRONG.has(f.kind)) tx.set(NS, 'holds', holdsWith(held, next))
    })
    holdMemo = null
    return found ? { ok: true } : { ok: false, missing: true }
  }

  /** Someone's own numbers, for their page: picks posted and deleted before kickoff, 30 days. */
  async function statsFor(uid) {
    const who = await docs.get(NS, `who-${uid}`)
    const s = deleteShare(who?.posts || [], who?.deletes || [], now())
    return { posted: s.posted, deleted: s.deleted, days: 30 }
  }

  /**
   * Deleting an account: its trail goes (when it posted and deleted picks, and the fingerprints of
   * the networks it posted from), and it comes off those networks' lists. Flags already raised
   * stay for the admin until cleared, since they name the other account too.
   */
  async function eraseUser(uid) {
    if (!uid) return
    const who = await docs.get(NS, `who-${uid}`).catch(() => null)
    for (const n of who?.nets || []) {
      const fp = String(n?.fp || '')
      if (!/^[0-9a-f]{24}$/.test(fp)) continue
      await docs
        .tx(async (tx) => {
          const net = await tx.get(NS, `net-${fp}`)
          if (!net) return
          const seen = (net.seen || []).filter((x) => x.uid !== uid)
          if (seen.length) tx.set(NS, `net-${fp}`, { ...net, seen, updatedAt: now() })
          else tx.del(NS, `net-${fp}`)
        })
        .catch((e) => log.warn('integrity erase failed', { err: errText(e) }))
    }
    await docs.del(NS, `who-${uid}`).catch(() => null)
    holdMemo = null
  }

  return { notePost, noteDelete, walletLinks, list, holds, clear, statsFor, eraseUser, fingerprint: (ip) => fingerprint(ip, env) }
}

// The admin page's numbers: who joined, what came in, how the community's picks and the
// admin's own bets did, and above all how the board did against real prices, by day and by
// every way of slicing it (bet type, side, probability, edge, the read, matchup, price, book).
// Everything is read from what the site already keeps; nothing here changes data.
import { dayET, ACC, sumAcc } from '../nfl/proplog.js'
import { entitlementOf } from '../billing/service.js'
import { billingConfig } from '../billing/config.js'
import { recordFromStats } from '../picks/service.js'
import { log, errText } from '../lib/log.js'
import { FOOTBALL_MARKETS, TEAM_MARKETS } from '../nfl/markets.js'
import { MARKETS as BASKETBALL_MARKETS } from '../sports/basketball.js'
import { MARKETS as HOCKEY_MARKETS } from '../sports/hockey.js'
import { MARKETS as BASEBALL_MARKETS } from '../sports/baseball.js'

const FAMILIES = { football: FOOTBALL_MARKETS, basketball: BASKETBALL_MARKETS, hockey: HOCKEY_MARKETS, baseball: BASEBALL_MARKETS, team: TEAM_MARKETS }

/**
 * One name per market for the admin tables, never the same name twice: where two markets share
 * a short label, the long one if that tells them apart ("Pitcher Strikeouts"), otherwise the
 * sport ("Points (hockey)").
 */
export function marketLabels() {
  const all = Object.entries(FAMILIES).flatMap(([fam, ms]) => Object.entries(ms).map(([k, v]) => ({ k, fam, label: v.label, long: v.long || v.label })))
  const tally = (f) => all.reduce((m, x) => m.set(f(x), (m.get(f(x)) || 0) + 1), new Map())
  const shorts = tally((x) => x.label)
  const longs = tally((x) => x.long)
  return Object.fromEntries(all.map((x) => [x.k, shorts.get(x.label) === 1 ? x.label : longs.get(x.long) === 1 ? x.long : `${x.label} (${x.fam})`]))
}
const MARKET_LABELS = marketLabels()

const DAY = 86_400_000
const zero = () => ACC.map(() => 0)
const list = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)

/**
 * Whose picks are "your bets": the accounts on the admin list (APEX_ADMIN_EMAILS or
 * APEX_ADMIN_UIDS). The admin page opens with a password, not a Google account, so the list
 * says which picks pages are the admin's.
 */
export function adminUidsOf(users, admin) {
  const emails = new Set(list(process.env.APEX_ADMIN_EMAILS))
  const uids = new Set(list(process.env.APEX_ADMIN_UIDS))
  if (admin?.uid && !admin.viaKey) uids.add(String(admin.uid).toLowerCase())
  for (const m of users?.list || []) if (m.email && emails.has(String(m.email).toLowerCase())) uids.add(String(m.uid).toLowerCase())
  return uids
}
const r2 = (x) => Math.round(x * 100) / 100

/** Days between two YYYY-MM-DD keys, both ends included. */
export function daysBetween(from, to) {
  const out = []
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
const monthsOf = (days) => [...new Set(days.map((d) => d.slice(0, 7)))]

async function pageAll(docs, col, field, max) {
  const out = []
  let before
  while (out.length < max) {
    const page = await docs.recent(col, { field, limit: 200, before })
    out.push(...page)
    if (page.length < 200) break
    before = page[page.length - 1][field]
    if (before == null) break
  }
  return out
}

export function createAdminMetrics({ engines, store, billing, listUsers = async () => null, now = () => Date.now() }) {
  const docs = billing?.docs || null
  const cache = new Map()
  const sportsWithLog = () => Object.entries(engines).filter(([, e]) => e.proplog)

  async function members(t) {
    const [auth, profiles, subs] = await Promise.all([
      listUsers().catch((e) => {
        log.warn('admin: listing sign-ins failed', { err: errText(e) })
        return null
      }),
      docs ? pageAll(docs, 'profiles', 'createdAt', 2000).catch(() => []) : [],
      docs ? pageAll(docs, 'subscriptions', 'updatedAt', 2000).catch(() => []) : [],
    ])
    const cfg = billingConfig()
    const byUid = new Map()
    const get = (uid) => {
      if (!byUid.has(uid)) byUid.set(uid, { uid, name: null, email: null, photo: null, handle: null, joined: null, lastSeen: null, plan: 'free', status: 'none', until: null, source: null, record: null, hidden: false })
      return byUid.get(uid)
    }
    for (const u of auth || []) Object.assign(get(u.uid), { name: u.name, email: u.email, photo: u.photo, joined: u.created, lastSeen: u.lastSeen, disabled: Boolean(u.disabled) })
    for (const p of profiles) {
      const m = get(p.uid || p.id)
      m.handle = p.handle || null
      m.name ||= p.name || null
      m.photo ||= p.avatar || null
      m.joined ||= p.createdAt || null
      m.hidden = Boolean(p.hidden)
      const rec = recordFromStats(p.stats, t, cfg.usageTz)
      if (rec) m.record = { all: pick(rec.all), d30: pick(rec.d30) }
    }
    for (const s of subs) {
      const m = get(s.id)
      const e = entitlementOf(s, t, cfg)
      m.email ||= s.email || null
      Object.assign(m, { plan: e.plan, status: e.status, until: e.lifetime ? 'lifetime' : e.paidUntil, source: e.source })
    }
    const list = [...byUid.values()].sort((a, b) => (b.joined || 0) - (a.joined || 0))
    const joinedIn = (ms) => list.filter((m) => m.joined && t - m.joined < ms).length
    const signups = {}
    for (const m of list) if (m.joined && t - m.joined < 120 * DAY) signups[dayET(m.joined)] = (signups[dayET(m.joined)] || 0) + 1
    const plans = { free: 0, pro: 0, elite: 0 }
    for (const m of list) plans[m.plan] = (plans[m.plan] || 0) + 1
    return {
      source: auth ? 'auth' : 'profiles',
      total: list.length,
      new7: joinedIn(7 * DAY),
      new30: joinedIn(30 * DAY),
      active7: list.filter((m) => m.lastSeen && t - m.lastSeen < 7 * DAY).length,
      pages: profiles.length,
      plans,
      paid: list.filter((m) => m.plan !== 'free' && m.source === 'usdc').length,
      comps: list.filter((m) => m.plan !== 'free' && m.source && m.source !== 'usdc').length,
      signups,
      list: list.slice(0, 1000),
    }
  }
  const pick = (r) => (r ? { wins: r.wins, losses: r.losses, pushes: r.pushes, units: r.units, roi: r.roi ?? null, hitRate: r.hitRate ?? null, streak: r.streak ?? null } : null)

  async function money(admin) {
    if (!billing) return null
    const pays = await billing.payments(admin, { limit: 200 }).catch(() => [])
    const byMonth = {}
    let total = 0
    for (const p of pays) {
      const usd = Number(p.usd) || Number(p.amount) || 0
      total += usd
      const m = new Date(p.createdAt).toISOString().slice(0, 7)
      byMonth[m] = r2((byMonth[m] || 0) + usd)
    }
    const t = now()
    const month = new Date(t).toISOString().slice(0, 7)
    return {
      total: r2(total),
      month: byMonth[month] || 0,
      count: pays.length,
      byMonth,
      recent: pays.slice(0, 25).map((p) => ({ id: p.invoiceId || p.id, at: p.createdAt, email: p.email || null, uid: p.uid, plan: p.plan, usd: Number(p.usd) || null, amount: p.amount, txHash: p.txHash, explorer: p.explorer || null })),
    }
  }

  /** Every pick posted on the site (the admin's own among them), by game day. */
  async function picksBook(adminUids, t) {
    const isAdmin = (p) => adminUids.has(String(p.uid).toLowerCase())
    if (!docs) return null
    const all = await pageAll(docs, 'picks', 'createdAt', 1500).catch(() => [])
    const crowd = {}
    const mine = {}
    const add = (into, p) => {
      const d = dayET(p.lockAt || p.createdAt)
      const b = (into[d] ||= { n: 0, w: 0, l: 0, p: 0, u: 0, risked: 0 })
      b.n++
      if (p.status !== 'graded') return
      if (p.result === 'win') b.w++
      else if (p.result === 'loss') b.l++
      else b.p++
      if (p.result === 'win' || p.result === 'loss') b.risked += p.units || 0
      b.u = r2(b.u + (p.profit || 0))
    }
    let open = 0
    for (const p of all) {
      if (p.status === 'open') open++
      add(crowd, p)
      if (isAdmin(p)) add(mine, p)
    }
    const myPicks = all
      .filter(isAdmin)
      .slice(0, 60)
      .map((p) => ({ id: p.id, at: p.createdAt, lockAt: p.lockAt, status: p.status, result: p.result, units: p.units, profit: p.profit ?? null, price: p.price, legs: (p.legs || []).map((l) => ({ name: l.short || l.name, label: l.label, sport: l.sport || 'nfl', result: l.result || null, price: l.price ?? null })) }))
    return { posted: all.length, open, crowd, mine, myPicks }
  }

  /** The 3-Leg Lock in every league: graded entries, by the day the first leg played. */
  async function locks() {
    if (!store) return []
    const out = []
    await Promise.all(
      Object.keys(engines).map(async (sport) => {
        const NS = sport === 'nfl' ? 'locks' : `locks-${sport}`
        const keys = ((await store.get(NS, 'index').catch(() => null)) || []).slice(-60)
        const entries = await Promise.all(keys.map((k) => store.get(NS, k).catch(() => null)))
        for (const e of entries) {
          if (!e || (e.status !== 'graded' && e.status !== 'live')) continue
          const first = Math.min(...(e.lock?.legs || []).map((l) => l.kickoff || Infinity))
          out.push({
            sport,
            key: e.key,
            day: Number.isFinite(first) ? dayET(first) : e.gradedAt ? dayET(e.gradedAt) : null,
            status: e.status,
            result: e.result || null,
            profit: e.profit ?? null,
            units: e.units ?? null,
            price: e.lock?.price ?? null,
            legs: (e.lock?.legs || []).map((l) => ({ name: l.short || l.name, label: l.label, result: l.result || null, value: l.value ?? null })),
          })
        }
      }),
    )
    return out.sort((a, b) => String(b.day).localeCompare(String(a.day)))
  }

  /** The board's record over these days: totals per league and series, segments, and each day. */
  async function board(days, only) {
    const months = monthsOf(days)
    const inRange = new Set(days)
    const leagues = {}
    const seg = {}
    const byDay = {}
    const status = {}
    for (const [sport, e] of sportsWithLog()) {
      if (only && only !== sport) continue
      const sums = await e.proplog.summaries(months).catch(() => ({}))
      const idx = await e.proplog.index().catch(() => ({ all: [], open: [] }))
      status[sport] = { ...e.proplog.status(), open: idx.open.length, onFile: idx.all.length, first: idx.all[0] || null }
      const L = { all: zero(), top: zero(), edge: zero(), days: 0 }
      for (const [d, s] of Object.entries(sums)) {
        if (!inRange.has(d)) continue
        L.days++
        for (const k of ['all', 'top', 'edge']) L[k] = sumAcc(L[k], s[k])
        for (const [k, a] of Object.entries(s.seg || {})) seg[k] = sumAcc(seg[k] || zero(), a)
        seg[`lg:${sport}`] = sumAcc(seg[`lg:${sport}`] || zero(), s.all)
        const b = (byDay[d] ||= { all: zero(), top: zero(), edge: zero(), leagues: [] })
        for (const k of ['all', 'top', 'edge']) b[k] = sumAcc(b[k], s[k])
        b.leagues.push(sport)
      }
      if (L.days) leagues[sport] = L
    }
    return { leagues, seg, days: byDay, status }
  }

  async function overview({ admin, from, to, sport = null, parts = 'all' } = {}) {
    const t = now()
    const end = to || dayET(t)
    const start = from || dayET(t - 59 * DAY)
    const key = `${start}|${end}|${sport || ''}|${admin?.uid || ''}|${parts}`
    const hit = cache.get(key)
    if (hit && t - hit.at < 60_000) return hit.value
    const days = daysBetween(start, end).slice(-400)
    if (parts === 'board') {
      // the calendar paging back a month only needs the board's days
      const value = { at: t, range: { from: start, to: end, sport }, model: await board(days, sport), labels: { m: MARKET_LABELS } }
      cache.set(key, { at: t, value })
      if (cache.size > 30) cache.delete(cache.keys().next().value)
      return value
    }
    const usersP = members(t).catch((e) => (log.warn('admin members failed', { err: errText(e) }), null))
    const [users, cash, book, lockList, model] = await Promise.all([
      usersP,
      money(admin).catch(() => null),
      usersP.then((u) => picksBook(adminUidsOf(u, admin), t)).catch(() => null),
      locks().catch(() => []),
      board(days, sport),
    ])
    const value = {
      at: t,
      range: { from: start, to: end, sport },
      users,
      money: cash,
      picks: book,
      locks: lockList,
      model,
      labels: { m: MARKET_LABELS },
      system: Object.fromEntries(
        Object.entries(engines).map(([k, e]) => {
          const st = e.started?.() ? e.status() : null
          return [k, { started: Boolean(st), games: st?.games ?? null, props: st?.props ?? null, live: st?.live ?? null, odds: st?.odds?.enabled === false ? null : st?.odds || null }]
        }),
      ),
    }
    cache.set(key, { at: t, value })
    if (cache.size > 30) cache.delete(cache.keys().next().value)
    return value
  }

  async function day({ sport, day: d }) {
    const e = engines[sport]
    if (!e?.proplog) return null
    return e.proplog.day(d)
  }

  /** The daily run (Vercel cron): every league loads its board, saves the lines, grades the finished ones. */
  async function daily({ budgetMs = 240_000 } = {}) {
    const until = Date.now() + budgetMs
    const out = {}
    await Promise.allSettled(
      Object.entries(engines).map(async ([k, e]) => {
        // a league in its usual off months has nothing to log (its engine stays asleep)
        if (e.sport?.offseason?.includes(new Date(now()).getUTCMonth() + 1)) return
        try {
          await e.ensureStarted()
          if (e.catchUp) await e.catchUp(Math.max(5_000, Math.min(120_000, until - Date.now() - 30_000)))
          out[k] = await e.proplog?.maybeTick({ force: true })
        } catch (err) {
          out[k] = { error: errText(err) }
        }
      }),
    )
    return out
  }

  return { overview, day, daily }
}

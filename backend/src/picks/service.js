// User pages and the picks showcase. Anyone signed in gets a page and a graded record;
// Elite adds the public feed, the leaderboard, the badge and links to X and Instagram.
import crypto from 'node:crypto'
import { ApiError } from '../lib/router.js'
import { MARKETS, marketOf } from '../nfl/markets.js'
import { outcome, parsePropId } from '../nfl/analytics/core.js'
import { americanToDecimal, decimalToAmerican } from '../lib/odds.js'
import { dayKey, atLeast, LIFETIME } from '../billing/service.js'
import { billingConfig, DAY_MS } from '../billing/config.js'
import { log, errText } from '../lib/log.js'
import { round } from '../lib/util.js'

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/
const RESERVED = new Set(['admin', 'apex', 'api', 'me', 'nfl', 'pricing', 'account', 'login', 'support', 'help', 'settings', 'picks', 'feed', 'leaderboard', 'kelly', 'slip', 'null', 'undefined', 'root', 'staff', 'mod', 'moderator', 'official'])
const MAX_LEGS = 6
const PICKS_PER_DAY = 20
const DEFAULT_PRICE = -110
const MIN_GRADED_FOR_BOARD = 5
const VOID_AFTER_MS = 18 * 3600_000
const HANDLE_CHANGE_MS = 7 * DAY_MS

/** "@name", "name" or a profile URL -> a clean handle, or null. Throws on junk. */
export function socialHandle(v, kind) {
  if (v == null || v === '') return null
  let s = String(v).trim()
  if (!s) return null
  const hosts = kind === 'x' ? /^(https?:\/\/)?(www\.|mobile\.)?(x|twitter)\.com\//i : /^(https?:\/\/)?(www\.)?instagram\.com\//i
  s = s.replace(hosts, '').replace(/^@/, '').replace(/[/?#].*$/, '')
  const re = kind === 'x' ? /^[A-Za-z0-9_]{1,15}$/ : /^[A-Za-z0-9._]{1,30}$/
  if (!re.test(s) || (kind === 'ig' && (s.startsWith('.') || s.endsWith('.') || s.includes('..')))) throw new ApiError(400, 'bad_social', kind === 'x' ? 'That X handle does not look right.' : 'That Instagram handle does not look right.')
  return s
}

const avatarOk = (u) => typeof u === 'string' && /^https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_\-/=.]{10,400}$/.test(u)
const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export function decimalOf(price) {
  return americanToDecimal(Number.isFinite(price) ? price : DEFAULT_PRICE) || americanToDecimal(DEFAULT_PRICE)
}

/**
 * Grade one leg once its game is final. Box scores leave out players with no stats in a
 * category, so a missing line is checked against the player's game log: in the log means he
 * played (zeros count), absent 18 hours after the final means he didn't (void).
 * Returns { result, value } or null to try again later.
 */
export function gradeLeg(leg, summary, { finalAt, now, logRow } = {}) {
  if (!summary || summary.status?.state !== 'post') return null
  let v
  if (leg.teamId) {
    const t = summary.home?.id === leg.teamId ? summary.home : summary.away?.id === leg.teamId ? summary.away : null
    if (!t || t.score == null) return null
    v = t.score
  } else {
    const mk = MARKETS[leg.market]
    if (!mk) return { result: 'void', value: null }
    const box = summary.players?.[leg.playerId]?.stats
    const hasBox = box && (!mk.keys || mk.keys.some((k) => box[k] != null))
    if (hasBox) v = mk.stat(box)
    else if (logRow) v = mk.stat(logRow.s || {})
    else if (now - finalAt > VOID_AFTER_MS) return { result: 'void', value: null }
    else return null
  }
  const o = outcome(v, leg.line, leg.side)
  return { result: o === 'hit' ? 'win' : o === 'push' ? 'push' : 'loss', value: v }
}

const seasonOf = (ts) => {
  const dt = new Date(ts)
  return dt.getUTCFullYear() - (dt.getUTCMonth() < 2 ? 1 : 0)
}

/** Combine leg results into the pick result and profit in units. */
export function settle(pick, results) {
  const legs = pick.legs.map((l, i) => ({ ...l, ...(results[i] || {}) }))
  if (legs.some((l) => !l.result)) return null
  const live = legs.filter((l) => l.result !== 'void' && l.result !== 'push')
  let result
  if (legs.some((l) => l.result === 'loss')) result = 'loss'
  else if (!live.length) result = legs.every((l) => l.result === 'void') ? 'void' : 'push'
  else result = 'win'
  const dec = live.reduce((d, l) => d * decimalOf(l.price), 1)
  const profit = result === 'win' ? round(pick.units * (dec - 1), 2) : result === 'loss' ? -pick.units : 0
  return { legs, result, profit, decimal: round(dec, 4) }
}

export function recordOf(picks) {
  const graded = picks.filter((p) => p.status === 'graded').sort((a, b) => (b.gradedAt || 0) - (a.gradedAt || 0))
  const r = { wins: 0, losses: 0, pushes: 0, voids: 0, units: 0, risked: 0, graded: 0 }
  for (const p of graded) {
    if (p.result === 'win') r.wins++
    else if (p.result === 'loss') r.losses++
    else if (p.result === 'push') r.pushes++
    else r.voids++
    if (p.result === 'win' || p.result === 'loss') r.risked += p.units
    r.units += p.profit || 0
  }
  r.graded = r.wins + r.losses
  r.units = round(r.units, 2)
  r.roi = r.risked ? round(r.units / r.risked, 4) : null
  r.hitRate = r.graded ? round(r.wins / r.graded, 4) : null
  let streak = ''
  for (const p of graded) {
    if (p.result !== 'win' && p.result !== 'loss') continue
    const c = p.result === 'win' ? 'W' : 'L'
    if (!streak) streak = c
    else if (streak[0] === c) streak += c
    else break
  }
  r.streak = streak ? `${streak[0]}${streak.length}` : null
  r.last10 = graded.filter((p) => p.result === 'win' || p.result === 'loss').slice(0, 10).map((p) => (p.result === 'win' ? 'W' : 'L'))
  delete r.risked
  return r
}

// Running totals kept on the profile, updated in the same transaction that grades a pick, so
// a record never misses or double-counts a pick however many picks someone has posted.
const bucket = () => ({ wins: 0, losses: 0, pushes: 0, voids: 0, units: 0, risked: 0 })
const KEEP_DAYS = 40

function addPick(b, pick) {
  const x = { ...bucket(), ...(b || {}) }
  if (pick.result === 'win') x.wins++
  else if (pick.result === 'loss') x.losses++
  else if (pick.result === 'push') x.pushes++
  else x.voids++
  if (pick.result === 'win' || pick.result === 'loss') x.risked = round(x.risked + pick.units, 2)
  x.units = round(x.units + (pick.profit || 0), 2)
  return x
}

/** stats + one newly graded pick (graded on local day `day`, YYYY-MM-DD). */
export function applyGraded(stats, pick, day) {
  const cur = stats || { all: bucket(), days: {}, recent: [] }
  const days = { ...(cur.days || {}) }
  days[day] = addPick(days[day], pick)
  const keys = Object.keys(days).sort()
  while (keys.length > KEEP_DAYS) delete days[keys.shift()]
  const recent = pick.result === 'win' || pick.result === 'loss' ? [pick.result === 'win' ? 'W' : 'L', ...(cur.recent || [])].slice(0, 20) : cur.recent || []
  return { all: addPick(cur.all, pick), days, recent }
}

function recordView(b, recent) {
  const x = { ...bucket(), ...(b || {}) }
  const graded = x.wins + x.losses
  let streak = ''
  for (const c of recent) {
    if (!streak) streak = c
    else if (streak[0] === c) streak += c
    else break
  }
  return { wins: x.wins, losses: x.losses, pushes: x.pushes, voids: x.voids, units: round(x.units, 2), graded, roi: x.risked ? round(x.units / x.risked, 4) : null, hitRate: graded ? round(x.wins / graded, 4) : null, streak: streak ? `${streak[0]}${streak.length}` : null, last10: recent.slice(0, 10) }
}

/** The public record (all time and the last 30 days) from the running totals. */
export function recordFromStats(stats, t, tz) {
  if (!stats) return null
  const from = dayKey(t - 29 * DAY_MS, tz)
  let d30 = bucket()
  for (const [day, b] of Object.entries(stats.days || {})) {
    if (day < from) continue
    d30 = { wins: d30.wins + b.wins, losses: d30.losses + b.losses, pushes: d30.pushes + b.pushes, voids: d30.voids + b.voids, units: round(d30.units + b.units, 2), risked: round(d30.risked + b.risked, 2) }
  }
  const recent = stats.recent || []
  return { all: recordView(stats.all, recent), d30: recordView(d30, recent) }
}

export function createPicks({ docs, engine, billing, now = () => Date.now() }) {
  const d = docs
  let lastGrade = 0
  let grading = null
  const memo = new Map()
  const cached = async (key, ms, fn) => {
    const hit = memo.get(key)
    if (hit && hit.until > now()) return hit.value
    const value = await fn()
    memo.set(key, { value, until: now() + ms })
    if (memo.size > 500) memo.delete(memo.keys().next().value)
    return value
  }
  // Profiles read by public pages and the feed, kept briefly so a page of 120 picks by the
  // same handful of cappers costs a handful of reads.
  const profMemo = new Map()
  const bust = () => {
    memo.clear()
    profMemo.clear()
  }
  async function profileCached(uid) {
    const hit = profMemo.get(uid)
    if (hit && hit.until > now()) return hit.value
    const value = await profileOf(uid)
    profMemo.set(uid, { value, until: now() + 30_000 })
    if (profMemo.size > 3000) profMemo.delete(profMemo.keys().next().value)
    return value
  }
  /** A page cursor is the createdAt of the last pick on the previous page; junk starts at the top. */
  const cursor = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 1_600_000_000_000 && n <= now() + 60_000 ? Math.floor(n) : undefined
  }

  /** How long the plan the user actually holds keeps the showcase (stored on the page). */
  function eliteUntilFor(user, ent) {
    if (user?.admin || ent.status === 'admin') return LIFETIME
    if (ent.plan === 'elite' && (ent.status === 'active' || ent.status === 'grace')) return ent.lifetime ? LIFETIME : ent.graceUntil || 0
    return 0
  }

  // With the paywall off every page gets the showcase. That's decided when a page is read and
  // never stored, so switching payments on later doesn't leave free Elite pages behind.
  const showcaseForAll = () => !billingConfig().paywall
  const isElite = (p, t = now()) => Boolean(p) && (showcaseForAll() || (p.eliteUntil || 0) > t)

  /** Bring the stored showcase date in line with the plan the user holds. */
  async function refreshElite(user, p) {
    if (!p) return p
    const eliteUntil = eliteUntilFor(user, await billing.heldPlan(user))
    if (eliteUntil === (p.eliteUntil || 0)) return p
    await d.merge('profiles', user.uid, { eliteUntil, updatedAt: now() })
    bust()
    return { ...p, eliteUntil }
  }

  function publicProfile(p, t = now()) {
    if (!p) return null
    const elite = isElite(p, t)
    return {
      handle: p.handle,
      name: p.name || p.handle,
      bio: p.bio || '',
      avatar: avatarOk(p.avatar) ? p.avatar : null,
      x: elite ? p.x || null : null,
      ig: elite ? p.ig || null : null,
      elite,
      since: p.createdAt || null,
      record: p.stats ? recordFromStats(p.stats, t, billingConfig().usageTz) : null,
      hidden: Boolean(p.hidden),
    }
  }

  function publicPick(p) {
    return {
      id: p.id,
      handle: p.handle,
      createdAt: p.createdAt,
      lockAt: p.lockAt,
      locked: now() >= p.lockAt,
      status: p.status,
      result: p.result || null,
      units: p.units,
      price: p.price,
      profit: p.profit ?? null,
      note: p.note || '',
      tails: p.tails || 0,
      legs: p.legs.map((l) => ({ id: l.id, playerId: l.playerId || null, teamId: l.teamId || null, name: l.name, short: l.short, headshot: l.headshot || null, teamAbbr: l.teamAbbr, oppAbbr: l.oppAbbr, market: l.market, label: l.label, line: l.line, side: l.side, kickoff: l.kickoff, price: l.price, book: l.book || null, prob: l.prob, fair: l.fair, score: l.score, result: l.result || null, value: l.value ?? null, gameId: l.gameId })),
    }
  }

  async function profileOf(uid) {
    return d.get('profiles', uid)
  }

  async function syncPlan(uid) {
    const p = await refreshElite({ uid }, await profileOf(uid))
    return p ? p.eliteUntil || 0 : null
  }

  async function me(user) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in with Google to make your page.')
    const ent = await billing.entitlement(user)
    const p = await refreshElite(user, await profileOf(user.uid))
    return { profile: p ? { ...publicProfile(p), x: p.x || null, ig: p.ig || null, handleChangedAt: p.handleChangedAt || null } : null, entitlement: ent, suggested: p ? null : suggestHandle(user) }
  }

  function suggestHandle(user) {
    const base = String(user.name || user.email?.split('@')[0] || 'apex')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 16)
    return base.length >= 3 ? base : `${base}_picks`.slice(0, 16)
  }

  async function saveProfile(user, body = {}) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in with Google to make your page.')
    const handle = String(body.handle || '').trim().toLowerCase().replace(/^@/, '')
    if (!HANDLE_RE.test(handle)) throw new ApiError(400, 'bad_handle', 'Handles are 3-20 letters, numbers or underscores.')
    if (RESERVED.has(handle)) throw new ApiError(400, 'reserved', 'That handle is reserved.')
    const name = cleanText(body.name, 40) || handle
    const bio = cleanText(body.bio, 160)
    const x = socialHandle(body.x, 'x')
    const ig = socialHandle(body.ig, 'ig')
    const avatar = body.avatar === null ? null : avatarOk(body.avatar) ? body.avatar : avatarOk(user.picture) ? user.picture : null
    const held = await billing.heldPlan(user)
    const t = now()
    const out = await d.tx(async (tx) => {
      const cur = await tx.get('profiles', user.uid)
      const owner = await tx.get('profileHandles', handle)
      if (owner && owner.uid !== user.uid) throw new ApiError(409, 'taken', 'That handle is taken.')
      const changing = cur && cur.handle !== handle
      if (changing && cur.handleChangedAt && t - cur.handleChangedAt < HANDLE_CHANGE_MS) throw new ApiError(429, 'handle_cooldown', 'You can change your handle once a week.')
      const next = {
        uid: user.uid,
        handle,
        name,
        bio,
        avatar,
        x,
        ig,
        createdAt: cur?.createdAt || t,
        updatedAt: t,
        handleChangedAt: changing ? t : cur?.handleChangedAt || null,
        eliteUntil: eliteUntilFor(user, held),
        hidden: Boolean(cur?.hidden),
        stats: cur?.stats || null,
        recordAt: cur?.recordAt ?? null,
      }
      tx.set('profiles', user.uid, next)
      tx.set('profileHandles', handle, { uid: user.uid, at: t })
      if (changing) tx.del('profileHandles', cur.handle)
      return next
    })
    bust()
    return { profile: { ...publicProfile(out), x: out.x, ig: out.ig } }
  }

  /** One leg from a prop id, priced and frozen as it is right now. */
  function legFrom(id) {
    const parsed = parsePropId(id)
    if (!parsed) throw new ApiError(400, 'bad_leg', 'One of those props is not valid.')
    const mk = marketOf(parsed.market)
    if (mk?.oneSided && parsed.side !== 'o') throw new ApiError(400, 'bad_leg', `${mk.label} only has a yes side.`)
    const row = engine.views.findProp(parsed.id)
    if (!row) throw new ApiError(404, 'no_prop', 'That prop is not on this week’s board anymore.')
    const g = row.gameId ? engine.wh.games.get(row.gameId) : null
    if (!g) throw new ApiError(400, 'no_game', 'That prop is not tied to a game this week.')
    const kick = Date.parse(g.date)
    if (g.status.state !== 'pre' || !(kick - now() > 60_000)) throw new ApiError(400, 'started', `${g.shortName} has started, so picks on it are locked.`)
    const price = row.side === 'u' ? row.price?.under : row.oneSided ? row.price?.yes : row.price?.over
    // A record only means something on lines a sportsbook actually offered, at prices it
    // actually offered. Main lines without a price grade at -110 (books set them near even
    // money); alternates and anytime-TD style props swing too far from that to guess.
    const who = `${row.short || row.name} ${row.label}`
    if (row.posted == null) {
      throw new ApiError(400, 'not_posted', row.main != null ? `${who} isn’t a line a sportsbook posted, so it can’t go on a record. The posted line is ${row.main}.` : `${who}: no sportsbook has posted this one, so it can’t go on a record.`)
    }
    if (!Number.isFinite(price) && (row.posted === 'alt' || row.oneSided)) {
      throw new ApiError(400, 'no_price', row.oneSided ? `${who} has no sportsbook price yet, so it can’t be graded fairly. Try again closer to kickoff.` : `${who} is an alternate line with no sportsbook price, so it can’t be graded fairly. The main line is ${row.main}.`)
    }
    return {
      id: row.id,
      playerId: row.playerId || null,
      teamId: row.kind === 'team' ? row.teamId : null,
      name: row.name,
      short: row.short,
      headshot: row.headshot || null,
      teamAbbr: row.teamAbbr,
      oppAbbr: row.oppAbbr,
      market: row.market,
      label: row.label,
      line: row.line,
      side: row.side,
      gameId: g.id,
      kickoff: kick,
      price: Number.isFinite(price) ? price : null,
      book: Number.isFinite(price) ? row.price?.book || null : null,
      posted: row.posted,
      prob: row.prob,
      fair: row.fair,
      score: row.score,
    }
  }

  /** Every leg checked, so the slip can show all the problems at once. */
  function legsFrom(ids) {
    const legs = []
    const problems = []
    for (const id of ids) {
      try {
        legs.push(legFrom(id))
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        problems.push({ id, code: e.code, error: e.message, status: e.status })
      }
    }
    return { legs, problems }
  }

  /** Which of these legs could go on a record right now (the post dialog asks before posting). */
  function check(body = {}) {
    const ids = Array.isArray(body.legs) ? [...new Set(body.legs.map(String))].slice(0, MAX_LEGS) : []
    const { problems } = legsFrom(ids)
    return { ok: problems.length === 0, legs: problems.map(({ id, code, error }) => ({ id, code, error })) }
  }

  async function post(user, body = {}) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in to post picks.')
    const prof = await refreshElite(user, await profileOf(user.uid))
    if (!prof) throw new ApiError(409, 'no_profile', 'Make your page first.')
    const ids = Array.isArray(body.legs) ? body.legs.map(String) : []
    if (!ids.length || ids.length > MAX_LEGS) throw new ApiError(400, 'bad_legs', `Pick 1 to ${MAX_LEGS} props.`)
    if (new Set(ids).size !== ids.length) throw new ApiError(400, 'dup_legs', 'The same prop is in there twice.')
    const { legs, problems } = legsFrom(ids)
    if (problems.length) {
      const [first] = problems
      const msg = problems.length === 1 ? first.error : `${problems.length} of these legs can’t go on a record. ${first.error}`
      throw new ApiError(first.status, first.code, msg, { legs: problems.map(({ id, code, error }) => ({ id, code, error })) })
    }
    const players = legs.map((l) => `${l.playerId || l.teamId}:${l.market}`)
    if (new Set(players).size !== players.length) throw new ApiError(400, 'conflict', 'Two picks on the same player and stat cancel out. Keep one.')
    const separate = body.mode === 'separate' && legs.length > 1
    const units = Math.min(10, Math.max(0.1, Math.round((Number(body.units) || 1) * 10) / 10))
    const note = cleanText(body.note, 280)
    const t = now()
    const day = dayKey(t, billingConfig().usageTz)
    const groups = separate ? legs.map((l) => [l]) : [legs]
    const made = await d.tx(async (tx) => {
      const usage = (await tx.get('pickUsage', `${user.uid}_${day}`)) || { n: 0, keys: [] }
      if (usage.n + groups.length > PICKS_PER_DAY) throw new ApiError(429, 'pick_limit', `You can post ${PICKS_PER_DAY} picks a day.`)
      const keys = new Set(usage.keys || [])
      const out = []
      for (const g of groups) {
        const k = g.map((l) => l.id).sort().join('~')
        if (keys.has(k)) throw new ApiError(409, 'dup_pick', 'You already posted that pick today.')
        keys.add(k)
        const dec = g.reduce((x, l) => x * decimalOf(l.price), 1)
        const pick = {
          id: `pk_${crypto.randomBytes(10).toString('hex')}`,
          uid: user.uid,
          handle: prof.handle,
          createdAt: t,
          lockAt: Math.min(...g.map((l) => l.kickoff)),
          status: 'open',
          result: null,
          units,
          price: decimalToAmerican(dec),
          note,
          legs: g,
          elite: isElite(prof, t),
          hidden: Boolean(prof.hidden),
        }
        tx.set('picks', pick.id, pick)
        out.push(pick)
      }
      tx.set('pickUsage', `${user.uid}_${day}`, { n: usage.n + groups.length, keys: [...keys].slice(-200), updatedAt: t })
      return out
    })
    bust()
    return { picks: made.map(publicPick) }
  }

  async function remove(user, id) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in first.')
    if (typeof id !== 'string' || !/^pk_[0-9a-f]{20}$/.test(id)) throw new ApiError(404, 'not_found', 'No such pick.')
    const p = await d.get('picks', id)
    if (!p || (p.uid !== user.uid && !user.admin)) throw new ApiError(404, 'not_found', 'No such pick.')
    if (now() >= p.lockAt && !user.admin) throw new ApiError(409, 'locked', 'This pick locked at kickoff and is part of your record now.')
    await d.del('picks', id)
    bust()
    return { ok: true }
  }

  /**
   * Tail a pick: count it once per person (signed-in uid, or a hash of the address for guests)
   * while it's still open. The legs go onto the tailer's own slip in the browser.
   */
  async function tail(id, who) {
    if (typeof id !== 'string' || !/^pk_[0-9a-f]{20}$/.test(id)) throw new ApiError(404, 'not_found', 'No such pick.')
    const key = crypto.createHash('sha256').update(`${id}|${who}`).digest('hex').slice(0, 32)
    const out = await d.tx(async (tx) => {
      const p = await tx.get('picks', id)
      if (!p) throw new ApiError(404, 'not_found', 'No such pick.')
      if (now() >= p.lockAt) throw new ApiError(409, 'locked', 'This pick has kicked off, so it can’t be tailed now.')
      if (await tx.get('tails', key)) return { tails: p.tails || 0, already: true }
      tx.set('tails', key, { pick: id, at: now() })
      tx.merge('picks', id, { tails: (p.tails || 0) + 1 })
      return { tails: (p.tails || 0) + 1, already: false }
    })
    bust()
    return out
  }

  async function picksOf(uid, { limit = 30, before } = {}) {
    return d.recent('picks', { field: 'createdAt', limit, where: [['uid', '==', uid]], before })
  }

  async function page(handle, { before, viewer } = {}) {
    const h = String(handle || '').toLowerCase()
    if (!HANDLE_RE.test(h)) throw new ApiError(404, 'not_found', 'No page with that handle.')
    const b = cursor(before)
    // everyone but the owner (and admins) sees the same page: share it for a few seconds
    if (!viewer) return cached(`page:${h}:${b ?? ''}`, 15_000, () => loadPage(h, b, null))
    return loadPage(h, b, viewer)
  }

  async function loadPage(h, before, viewer) {
    const owner = await d.get('profileHandles', h)
    if (!owner) throw new ApiError(404, 'not_found', 'No page with that handle.')
    const prof = await profileOf(owner.uid)
    if (!prof) throw new ApiError(404, 'not_found', 'No page with that handle.')
    const isOwner = viewer?.uid === owner.uid
    if (prof.hidden && !isOwner && !viewer?.admin) throw new ApiError(404, 'not_found', 'No page with that handle.')
    const list = await picksOf(owner.uid, { limit: 30, before })
    const open = list.filter((p) => p.status === 'open')
    const history = list.filter((p) => p.status === 'graded')
    return { profile: publicProfile(prof), owner: isOwner, open: open.map(publicPick), history: history.map(publicPick), next: list.length === 30 ? list[list.length - 1].createdAt : null }
  }

  async function feed({ before } = {}) {
    const b = cursor(before)
    return cached(`feed:${b ?? ''}`, 20_000, async () => {
      const t = now()
      const rows = await d.recent('picks', { field: 'createdAt', limit: 120, before: b })
      const profiles = new Map()
      const out = []
      for (const p of rows) {
        if (!profiles.has(p.uid)) profiles.set(p.uid, await profileCached(p.uid))
        const prof = profiles.get(p.uid)
        if (!prof || prof.hidden || !isElite(prof, t)) continue
        out.push({ ...publicPick(p), profile: publicProfile(prof, t) })
        if (out.length >= 30) break
      }
      return { picks: out, next: rows.length === 120 ? rows[rows.length - 1].createdAt : null }
    })
  }

  async function leaderboard({ range = '30d' } = {}) {
    const key = range === 'all' ? 'all' : 'd30'
    return cached(`board:${key}`, 60_000, async () => {
      const t = now()
      // everyone with a recently graded pick (recordAt is stamped when a pick is graded)
      const profs = await d.recent('profiles', { field: 'recordAt', limit: 200, ...(key === 'd30' ? { where: [['recordAt', '>=', t - 30 * DAY_MS]] } : {}) })
      const rows = profs
        .filter((p) => !p.hidden && isElite(p, t))
        .map((p) => ({ p, rec: recordFromStats(p.stats, t, billingConfig().usageTz)?.[key] }))
        .filter((x) => x.rec && x.rec.graded >= MIN_GRADED_FOR_BOARD)
        .map((x) => ({ profile: publicProfile(x.p, t), record: x.rec }))
        .sort((a, b) => b.record.units - a.record.units || (b.record.roi ?? 0) - (a.record.roi ?? 0))
        .slice(0, 50)
      return { range: key === 'all' ? 'all' : '30d', rows, min: MIN_GRADED_FOR_BOARD }
    })
  }

  /** Recompute someone's totals from every graded pick (repairs; grading keeps them current). */
  async function rebuildRecord(uid) {
    const tz = billingConfig().usageTz
    const all = []
    let before
    for (let i = 0; i < 100; i++) {
      const page = await picksOf(uid, { limit: 200, before })
      all.push(...page)
      if (page.length < 200) break
      before = page[page.length - 1].createdAt
    }
    const graded = all.filter((p) => p.status === 'graded').sort((a, b) => (a.gradedAt || 0) - (b.gradedAt || 0))
    let stats = null
    for (const p of graded) stats = applyGraded(stats, p, dayKey(p.gradedAt || p.createdAt, tz))
    const t = now()
    await d.patch('profiles', uid, { stats, recordAt: graded.length ? graded[graded.length - 1].gradedAt || t : null })
    bust()
    return recordFromStats(stats, t, tz)
  }

  const summaryCache = new Map()
  async function finalSummary(gameId) {
    const s = engine.wh.summaries.get(gameId)?.data
    if (s?.status?.state === 'post') return s
    const hit = summaryCache.get(gameId)
    if (hit && now() - hit.at < 5 * 60_000) return hit.s
    try {
      const fresh = await engine.espn.summary(gameId, { priority: 'background' })
      summaryCache.set(gameId, { s: fresh, at: now() })
      if (summaryCache.size > 300) summaryCache.delete(summaryCache.keys().next().value)
      return fresh
    } catch (e) {
      log.warn('grading summary failed', { gameId, err: errText(e) })
      return null
    }
  }

  async function gradeOpen() {
    const t = now()
    // oldest first: a pick waiting on a late game can't hold up the ones before it
    const open = await d.recent('picks', { field: 'lockAt', limit: 150, dir: 'asc', where: [['status', '==', 'open'], ['lockAt', '<=', t]] })
    const tz = billingConfig().usageTz
    const touched = new Set()
    const logs = new Map()
    async function logRow(playerId, gameId, kickoff) {
      const season = seasonOf(kickoff)
      const k = `${playerId}:${season}`
      if (!logs.has(k)) {
        try {
          logs.set(k, await engine.espn.gamelog(playerId, season, { priority: 'background' }))
        } catch {
          logs.set(k, engine.wh.logs.get(playerId) || [])
        }
      }
      return logs.get(k).find((r) => r.eventId === gameId) || null
    }
    for (const p of open) {
      const results = []
      for (const leg of p.legs) {
        if (leg.result) {
          results.push({ result: leg.result, value: leg.value })
          continue
        }
        const s = await finalSummary(leg.gameId)
        const finalAt = leg.kickoff + 3.5 * 3600_000
        const mk = MARKETS[leg.market]
        const box = s?.players?.[leg.playerId]?.stats
        const needLog = s?.status?.state === 'post' && leg.playerId && !(box && (!mk?.keys || mk.keys.some((k) => box[k] != null)))
        const row = needLog ? await logRow(leg.playerId, leg.gameId, leg.kickoff) : null
        results.push(gradeLeg(leg, s, { finalAt, now: t, logRow: row }))
      }
      const done = settle(p, results)
      if (!done) {
        // save partial leg results so the page can show them
        const legs = p.legs.map((l, i) => (results[i] ? { ...l, result: results[i].result, value: results[i].value } : l))
        if (legs.some((l, i) => l.result !== p.legs[i].result)) await d.merge('picks', p.id, { legs })
        continue
      }
      const graded = { status: 'graded', result: done.result, profit: done.profit, decimal: done.decimal, legs: done.legs, gradedAt: t }
      const ok = await d.tx(async (tx) => {
        const cur = await tx.get('picks', p.id)
        if (!cur || cur.status !== 'open') return false // graded elsewhere, or deleted
        const prof = await tx.get('profiles', p.uid)
        tx.merge('picks', p.id, graded)
        if (prof) tx.patch('profiles', p.uid, { stats: applyGraded(prof.stats, { ...cur, ...graded }, dayKey(t, tz)), recordAt: t })
        return true
      })
      if (ok) touched.add(p.uid)
    }
    if (touched.size) bust()
    lastGrade = t
    return { checked: open.length, graded: touched.size }
  }

  /** Grade at most every two minutes; callers don't wait on each other. */
  function maybeGrade() {
    if (grading) return grading
    if (now() - lastGrade < 120_000) return Promise.resolve({ skipped: true })
    grading = gradeOpen()
      .catch((e) => {
        log.warn('grading failed', { err: errText(e) })
        return { error: true }
      })
      .finally(() => {
        grading = null
        lastGrade = now()
      })
    return grading
  }

  async function setHidden(admin, { handle, hidden }) {
    if (!admin?.admin) throw new ApiError(403, 'admin', 'Admins only.')
    const owner = await d.get('profileHandles', String(handle || '').toLowerCase())
    if (!owner) throw new ApiError(404, 'not_found', 'No page with that handle.')
    await d.merge('profiles', owner.uid, { hidden: Boolean(hidden), updatedAt: now() })
    bust()
    return { ok: true, handle, hidden: Boolean(hidden) }
  }

  return { me, saveProfile, post, check, remove, tail, page, feed, leaderboard, gradeOpen, maybeGrade, syncPlan, setHidden, rebuildRecord, eliteUntilFor, publicProfile, _atLeast: atLeast }
}

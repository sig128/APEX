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
import { round, envInt } from '../lib/util.js'
import { closeSnap, sameClose, legClv, pickClv } from './clv.js'
import { coach as coachOf } from './coach.js'
import { cleanLimits, nextLimits, effectiveLimits, pauseError, pausedUntil, checkLimits, tiltCheck, netWeek, COOL_DAYS, EXCLUDE_MONTHS } from './rg.js'
import { liveChance, slipChance } from './live.js'

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/
const RESERVED = new Set(['admin', 'apex', 'api', 'me', 'nfl', 'nba', 'mlb', 'nhl', 'ncaaf', 'ncaab', 'wnba', 'lock', 'tools', 'props', 'live', 'pricing', 'account', 'login', 'support', 'help', 'settings', 'picks', 'feed', 'leaderboard', 'kelly', 'slip', 'null', 'undefined', 'root', 'staff', 'mod', 'moderator', 'official'])
const MAX_LEGS = 6
const PICKS_PER_DAY = 20
const DEFAULT_PRICE = -110
// graded picks (wins and losses) before someone shows on the leaderboard
const boardMin = () => envInt('APEX_BOARD_MIN', 20, { min: 1, max: 1000 })
const HOUR_MS = 3600_000
// open picks get their closing prices watched this long before their game
const CLOSE_WATCH_MS = 2 * HOUR_MS
// and their players' injury status this long before
const INJURY_WATCH_MS = 36 * HOUR_MS
// injury-report statuses that alert (a "Returning" badge comes and goes with logs, so it doesn't)
const REPORT_TAGS = new Set(['out', 'doubtful', 'questionable', 'daytoday', 'probable'])
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-]{1,30}(\/[A-Za-z0-9_+\-]{1,30}){0,2}$/
function cleanTz(v) {
  if (typeof v !== 'string' || !TZ_RE.test(v)) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v })
    return v
  } catch {
    return null
  }
}
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
const bucket = () => ({ wins: 0, losses: 0, pushes: 0, voids: 0, units: 0, risked: 0, clvSum: 0, clvN: 0 })
const KEEP_DAYS = 40

function addPick(b, pick) {
  const x = { ...bucket(), ...(b || {}) }
  if (pick.result === 'win') x.wins++
  else if (pick.result === 'loss') x.losses++
  else if (pick.result === 'push') x.pushes++
  else x.voids++
  if (pick.result === 'win' || pick.result === 'loss') x.risked = round(x.risked + pick.units, 2)
  x.units = round(x.units + (pick.profit || 0), 2)
  if (Number.isFinite(pick.clv) && (pick.result === 'win' || pick.result === 'loss')) {
    x.clvSum = round((x.clvSum || 0) + pick.clv, 4)
    x.clvN = (x.clvN || 0) + 1
  }
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
  return { wins: x.wins, losses: x.losses, pushes: x.pushes, voids: x.voids, units: round(x.units, 2), graded, roi: x.risked ? round(x.units / x.risked, 4) : null, hitRate: graded ? round(x.wins / graded, 4) : null, clv: x.clvN ? round(x.clvSum / x.clvN, 4) : null, clvN: x.clvN || 0, streak: streak ? `${streak[0]}${streak.length}` : null, last10: recent.slice(0, 10) }
}

/** The public record (all time and the last 30 days) from the running totals. */
export function recordFromStats(stats, t, tz) {
  if (!stats) return null
  const from = dayKey(t - 29 * DAY_MS, tz)
  let d30 = bucket()
  for (const [day, b] of Object.entries(stats.days || {})) {
    if (day < from) continue
    d30 = { wins: d30.wins + b.wins, losses: d30.losses + b.losses, pushes: d30.pushes + b.pushes, voids: d30.voids + b.voids, units: round(d30.units + b.units, 2), risked: round(d30.risked + b.risked, 2), clvSum: round((d30.clvSum || 0) + (b.clvSum || 0), 4), clvN: (d30.clvN || 0) + (b.clvN || 0) }
  }
  const recent = stats.recent || []
  return { all: recordView(stats.all, recent), d30: recordView(d30, recent) }
}

export function createPicks({ docs, engine, engines = null, billing, now = () => Date.now() }) {
  const d = docs
  // Picks can be on any league: a leg id is "<id>" (NFL) or "<league>:<id>", and each leg is
  // priced, frozen and graded by its own league's engine.
  const engineOf = (key) => (!key || key === 'nfl' ? engine : engines && Object.hasOwn(engines, key) && engines[key]?.views ? engines[key] : null)
  function splitRef(ref) {
    const s = String(ref)
    const i = s.indexOf(':')
    return i > 0 ? { key: s.slice(0, i), id: s.slice(i + 1) } : { key: 'nfl', id: s }
  }
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

  /** A pick for pages and the feed. Subscriber picks hide their legs from others until kickoff. */
  function publicPick(p, { canSee = true } = {}) {
    const hide = Boolean(p.subs) && !canSee && now() < p.lockAt
    if (hide) {
      return { id: p.id, handle: p.handle, createdAt: p.createdAt, lockAt: p.lockAt, locked: false, status: p.status, result: null, units: p.units, price: null, profit: null, note: '', tails: p.tails || 0, subs: true, hidden: true, legCount: p.legs.length, legs: [] }
    }
    return {
      id: p.id,
      subs: Boolean(p.subs),
      clv: Number.isFinite(p.clv) ? p.clv : null,
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
      legs: p.legs.map(publicLeg),
    }
  }

  function publicLeg(l) {
    return {
      id: l.id,
      sport: l.sport || 'nfl',
      playerId: l.playerId || null,
      teamId: l.teamId || null,
      name: l.name,
      short: l.short,
      headshot: l.headshot || null,
      teamAbbr: l.teamAbbr,
      oppAbbr: l.oppAbbr,
      market: l.market,
      label: l.label,
      line: l.line,
      side: l.side,
      kickoff: l.kickoff,
      price: l.price,
      book: l.book || null,
      prob: l.prob,
      fair: l.fair,
      score: l.score,
      result: l.result || null,
      value: l.value ?? null,
      gameId: l.gameId,
      inj: l.inj || null,
      close: l.close ? { price: l.close.price, line: l.close.line, at: l.close.at } : null,
      clv: Number.isFinite(l.clv) ? l.clv : null,
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

  /** One leg from a prop id ("<id>" or "<league>:<id>"), priced and frozen as it is right now. */
  function legFrom(ref) {
    const { key, id } = splitRef(ref)
    const eng = engineOf(key)
    const parsed = eng ? parsePropId(id) : null
    if (!parsed) throw new ApiError(400, 'bad_leg', 'One of those props is not valid.')
    const mk = marketOf(parsed.market)
    if (mk?.oneSided && parsed.side !== 'o') throw new ApiError(400, 'bad_leg', `${mk.label} only has a yes side.`)
    // a player ruled out on the injury report can't go on a record (the board drops him too)
    const inj = parsed.playerId ? eng.wh.injuryOf?.(parsed.playerId) : null
    if (inj?.severity === 'out') {
      const who = eng.wh.players.get(String(parsed.playerId))?.name || 'This player'
      throw new ApiError(409, 'player_out', `${who} is listed ${inj.status || 'out'} on the injury report, so this leg can’t go on a record.`)
    }
    const row = eng.views.findProp(parsed.id)
    if (!row) throw new ApiError(404, 'no_prop', 'That prop is not on the board anymore.')
    const g = row.gameId ? eng.wh.games.get(row.gameId) : null
    if (!g) throw new ApiError(400, 'no_game', 'That prop is not tied to a game on this slate.')
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
      sport: key,
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
      inj: injTag(eng, row.playerId),
    }
  }

  /** The leg's player status as stored on a pick: { tag, label } or null. */
  function injTag(eng, playerId) {
    if (!playerId || !eng?.views?.statusOf) return null
    const t = eng.views.statusOf(playerId)
    return t ? { tag: t.tag, label: t.label } : null
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
    const { legs, problems } = legsFrom(ids)
    // not blocking: players on the injury report or just back from an absence
    const warnings = legs
      .filter((l) => l.inj && l.inj.tag !== 'probable')
      .map((l) => ({ id: l.sport === 'nfl' ? l.id : `${l.sport}:${l.id}`, tag: l.inj.tag, label: l.inj.label, text: l.inj.tag === 'returning' ? `${l.short || l.name} is just back from an absence.` : `${l.short || l.name} is ${l.inj.label.toLowerCase()} on the injury report.` }))
    return { ok: problems.length === 0, legs: problems.map(({ id, code, error }) => ({ id, code, error })), warnings }
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
    const players = legs.map((l) => `${l.sport}:${l.playerId || l.teamId}:${l.market}`)
    if (new Set(players).size !== players.length) throw new ApiError(400, 'conflict', 'Two picks on the same player and stat cancel out. Keep one.')
    const separate = body.mode === 'separate' && legs.length > 1
    const units = Math.min(10, Math.max(0.1, Math.round((Number(body.units) || 1) * 10) / 10))
    const note = cleanText(body.note, 280)
    const t = now()
    const tz = billingConfig().usageTz
    const day = dayKey(t, tz)
    const groups = separate ? legs.map((l) => [l]) : [legs]
    // responsible betting: a break or exclusion stops posting; limits and the tilt check apply
    const rg = await d.get('rg', user.uid)
    const paused = pauseError(rg, t)
    if (paused) throw paused
    const limits = effectiveLimits(rg, t)
    if (Object.values(limits).some((v) => v != null)) {
      const days = [...new Set(Array.from({ length: 7 }, (_, i) => dayKey(t - i * DAY_MS, tz)))]
      const usages = await Promise.all(days.map((k) => d.get('pickUsage', `${user.uid}_${k}`)))
      const today = usages[0] || {}
      checkLimits(limits, { picksToday: today.n || 0, unitsToday: today.units || 0, unitsWeek: usages.reduce((s, u) => s + (u?.units || 0), 0), netWeek: netWeek(prof.stats, days[days.length - 1]) }, { picks: groups.length, units: units * groups.length })
    }
    const tilt = tiltCheck(prof.stats, units)
    if (tilt && body.ackTilt !== true) {
      throw new ApiError(409, 'tilt', `You've lost ${tilt.streak} in a row and this stake is ${tilt.ratio}× your usual ${tilt.usual} units. Post it anyway, or take a break?`, { tilt })
    }
    const subs = body.subs === true
    if (subs && !isElite(prof, t)) throw new ApiError(403, 'upgrade', 'Subscriber picks come with Elite.')
    const pickTz = cleanTz(body.tz)
    const made = await d.tx(async (tx) => {
      const usage = (await tx.get('pickUsage', `${user.uid}_${day}`)) || { n: 0, keys: [] }
      if (usage.n + groups.length > PICKS_PER_DAY) throw new ApiError(429, 'pick_limit', `You can post ${PICKS_PER_DAY} picks a day.`)
      const keys = new Set(usage.keys || [])
      const out = []
      for (const g of groups) {
        const k = g.map((l) => (l.sport === 'nfl' ? l.id : `${l.sport}:${l.id}`)).sort().join('~')
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
          subs,
          ...(pickTz ? { tz: pickTz } : {}),
        }
        tx.set('picks', pick.id, pick)
        out.push(pick)
      }
      tx.set('pickUsage', `${user.uid}_${day}`, { n: usage.n + groups.length, units: round((usage.units || 0) + units * groups.length, 2), keys: [...keys].slice(-200), updatedAt: t })
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
  async function tail(id, who, viewer = null) {
    if (typeof id !== 'string' || !/^pk_[0-9a-f]{20}$/.test(id)) throw new ApiError(404, 'not_found', 'No such pick.')
    if (viewer?.uid) {
      const paused = pauseError(await d.get('rg', viewer.uid), now())
      if (paused) throw paused
    }
    const head = await d.get('picks', id)
    if (head?.subs && !(await canSeePick(head, viewer))) throw new ApiError(403, 'subscribers', 'This pick is for subscribers.')
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
    const canSee = isOwner || Boolean(viewer?.admin) || (open.some((p) => p.subs) && viewer?.uid ? await isSubscriber(owner.uid, viewer.uid) : false)
    const show = (p) => publicPick(p, { canSee })
    return { profile: publicProfile(prof), owner: isOwner, subscriber: !isOwner && canSee && !viewer?.admin, open: open.map(show), history: history.map(show), next: list.length === 30 ? list[list.length - 1].createdAt : null }
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
        out.push({ ...publicPick(p, { canSee: false }), profile: publicProfile(prof, t) })
        if (out.length >= 30) break
      }
      return { picks: out, next: rows.length === 120 ? rows[rows.length - 1].createdAt : null }
    })
  }

  async function leaderboard({ range = '30d' } = {}) {
    const key = range === 'all' ? 'all' : 'd30'
    const min = boardMin()
    return cached(`board:${key}`, 60_000, async () => {
      const t = now()
      // everyone with a recently graded pick (recordAt is stamped when a pick is graded)
      const profs = await d.recent('profiles', { field: 'recordAt', limit: 200, ...(key === 'd30' ? { where: [['recordAt', '>=', t - 30 * DAY_MS]] } : {}) })
      const rows = profs
        .filter((p) => !p.hidden && isElite(p, t))
        .map((p) => ({ p, rec: recordFromStats(p.stats, t, billingConfig().usageTz)?.[key] }))
        .filter((x) => x.rec && x.rec.graded >= min)
        .map((x) => ({ profile: publicProfile(x.p, t), record: x.rec }))
        .sort((a, b) => (b.record.roi ?? -9) - (a.record.roi ?? -9) || (b.record.clv ?? -9) - (a.record.clv ?? -9) || b.record.graded - a.record.graded)
        .slice(0, 50)
      return { range: key === 'all' ? 'all' : '30d', rows, min, rankBy: 'roi' }
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
  async function finalSummary(gameId, key = 'nfl') {
    const eng = engineOf(key)
    if (!eng) return null
    const s = eng.wh.summaries.get(gameId)?.data
    if (s?.status?.state === 'post') return s
    const ck = `${key}:${gameId}`
    const hit = summaryCache.get(ck)
    if (hit && now() - hit.at < 5 * 60_000) return hit.s
    try {
      const fresh = await eng.espn.summary(gameId, { priority: 'background' })
      summaryCache.set(ck, { s: fresh, at: now() })
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
    async function logRow(playerId, gameId, kickoff, key = 'nfl') {
      const eng = engineOf(key)
      if (!eng) return null
      // NFL seasons are named for the year they start; the engine knows every other league's
      const season = key === 'nfl' ? seasonOf(kickoff) : eng.wh.season || seasonOf(kickoff)
      const k = `${key}:${playerId}:${season}`
      if (!logs.has(k)) {
        try {
          logs.set(k, await eng.espn.gamelog(playerId, season, { priority: 'background' }))
        } catch {
          logs.set(k, eng.wh.logs.get(playerId) || [])
        }
      }
      return (logs.get(k) || []).find((r) => r.eventId === gameId) || null
    }
    for (const p of open) {
      // a close missed before kickoff: the board still holds the last pre-game price
      const closed = p.legs.map((l) => (l.close ? l : withClose(l, t)))
      if (closed.some((l, i) => l !== p.legs[i])) {
        p.legs = closed
        await d.merge('picks', p.id, { legs: closed })
      }
      const results = []
      for (const leg of p.legs) {
        if (leg.result) {
          results.push({ result: leg.result, value: leg.value })
          continue
        }
        const key = leg.sport || 'nfl'
        const s = await finalSummary(leg.gameId, key)
        const finalAt = leg.kickoff + 3.5 * 3600_000
        const mk = MARKETS[leg.market]
        const box = s?.players?.[leg.playerId]?.stats
        const needLog = s?.status?.state === 'post' && leg.playerId && !(box && (!mk?.keys || mk.keys.some((k) => box[k] != null)))
        const row = needLog ? await logRow(leg.playerId, leg.gameId, leg.kickoff, key) : null
        results.push(gradeLeg(leg, s, { finalAt, now: t, logRow: row }))
      }
      const done = settle(p, results)
      if (!done) {
        // save partial leg results so the page can show them
        const legs = p.legs.map((l, i) => (results[i] ? { ...l, result: results[i].result, value: results[i].value } : l))
        if (legs.some((l, i) => l.result !== p.legs[i].result)) await d.merge('picks', p.id, { legs })
        continue
      }
      const legsOut = done.legs.map((l) => ({ ...l, clv: legClv(l) }))
      const graded = { status: 'graded', result: done.result, profit: done.profit, decimal: done.decimal, legs: legsOut, clv: pickClv(legsOut), gradedAt: t }
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

  /** A leg with the board's current price as its close (only before or just after its game). */
  function withClose(leg, t) {
    const eng = engineOf(leg.sport || 'nfl')
    if (!eng || !Number.isFinite(leg.kickoff) || t > leg.kickoff + 6 * HOUR_MS) return leg
    // the row at this leg's own line: if the main line moved off it, it has no price and the
    // close stays unmeasured (CLV is only read at the same line)
    const row = eng.views.findProp(leg.id)
    if (!row) return leg
    const g = eng.wh.games.get(leg.gameId)
    const seen = Math.max(eng.wh.lines.get(leg.gameId)?.at || 0, eng.wh.at?.odds || 0)
    const at = Math.min(t, seen || t, leg.kickoff)
    if (g && g.status?.state !== 'pre' && !(seen && seen <= leg.kickoff)) return leg
    const snap = closeSnap(row, leg.side, at)
    // the same prices seen again still move the close's time up, every half hour at most
    if (!snap || (sameClose(snap, leg.close) && snap.at - (leg.close?.at || 0) < 30 * 60_000)) return leg
    return { ...leg, close: snap }
  }

  /**
   * Before kickoff: keep each open pick's closing prices current, and alert its owner when a
   * player on it changes status on the injury report.
   */
  async function watchOpen() {
    const t = now()
    const soon = await d.recent('picks', { field: 'lockAt', limit: 150, dir: 'asc', where: [['status', '==', 'open'], ['lockAt', '>', t]] })
    const alerts = new Map()
    for (const p of soon) {
      if (p.lockAt > t + INJURY_WATCH_MS) break
      let changed = false
      const legs = p.legs.map((l) => {
        let next = l
        if (p.lockAt <= t + CLOSE_WATCH_MS) {
          const c = withClose(l, t)
          if (c !== l) {
            next = c
            changed = true
          }
        }
        if (l.playerId) {
          const eng = engineOf(l.sport || 'nfl')
          const cur = eng?.views?.statuses ? eng.views.statuses([l.playerId]).get(String(l.playerId)) : undefined
          if (cur !== undefined) {
            const report = cur && REPORT_TAGS.has(cur.tag) ? { tag: cur.tag, label: cur.label } : null
            const was = l.inj && REPORT_TAGS.has(l.inj.tag) ? l.inj : null
            if ((report?.tag || null) !== (was?.tag || null)) {
              // picks from before statuses were kept just start tracking, without an alert
              if (l.inj !== undefined) {
                const list = alerts.get(p.uid) || []
                list.push({ id: `${p.id}:${l.playerId}:${report?.tag || 'clear'}:${t}`, kind: 'injury', pickId: p.id, playerId: l.playerId, sport: l.sport || 'nfl', name: l.short || l.name, label: l.label, from: was?.label || 'No status', to: report?.label || 'Off the report', tag: report?.tag || null, kickoff: l.kickoff, at: t })
                alerts.set(p.uid, list)
              }
              next = { ...next, inj: report }
              changed = true
            }
          }
        }
        return next
      })
      if (changed) await d.merge('picks', p.id, { legs })
    }
    for (const [uid, items] of alerts) {
      await d.tx(async (tx) => {
        const cur = (await tx.get('alerts', uid)) || { items: [], seenAt: 0 }
        tx.set('alerts', uid, { items: [...items, ...(cur.items || [])].slice(0, 40), seenAt: cur.seenAt || 0, updatedAt: t })
      })
    }
    if (alerts.size) bust()
    return { watched: soon.length, alerted: alerts.size }
  }

  /** Grade at most every two minutes; callers don't wait on each other. */
  function maybeGrade() {
    if (grading) return grading
    if (now() - lastGrade < 120_000) return Promise.resolve({ skipped: true })
    grading = Promise.all([gradeOpen(), watchOpen().catch((e) => log.warn('watching open picks failed', { err: errText(e) }))]).then(([g]) => g)
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

  // ---- subscribers ---------------------------------------------------------------------------
  async function isSubscriber(creatorUid, viewerUid) {
    if (!creatorUid || !viewerUid) return false
    if (creatorUid === viewerUid) return true
    const s = await d.get('subs', `${creatorUid}_${viewerUid}`)
    return Boolean(s) && (!s.until || s.until > now())
  }
  async function canSeePick(p, viewer) {
    if (!p.subs || now() >= p.lockAt) return true
    if (!viewer?.uid) return false
    return Boolean(viewer.admin) || p.uid === viewer.uid || (await isSubscriber(p.uid, viewer.uid))
  }
  /** One pick by id, with its legs when the viewer may see them. */
  async function pickFor(id, viewer) {
    if (typeof id !== 'string' || !/^pk_[0-9a-f]{20}$/.test(id)) throw new ApiError(404, 'not_found', 'No such pick.')
    const p = await d.get('picks', id)
    if (!p || (p.hidden && p.uid !== viewer?.uid && !viewer?.admin)) throw new ApiError(404, 'not_found', 'No such pick.')
    return { pick: publicPick(p, { canSee: await canSeePick(p, viewer) }) }
  }
  async function subscribers(user) {
    const prof = await mustProfile(user)
    return { subscribers: (prof.subscribers || []).map((x) => ({ handle: x.handle, since: x.since })), max: 500 }
  }
  async function setSubscriber(user, { handle, remove: drop = false } = {}) {
    const prof = await mustProfile(user)
    if (!drop && !isElite(prof)) throw new ApiError(403, 'upgrade', 'Subscriber picks come with Elite.')
    const h = String(handle || '').trim().toLowerCase().replace(/^@/, '')
    if (!HANDLE_RE.test(h)) throw new ApiError(400, 'bad_handle', 'That handle does not look right.')
    const who = await d.get('profileHandles', h)
    if (!who) throw new ApiError(404, 'not_found', 'No page with that handle.')
    if (who.uid === user.uid) throw new ApiError(400, 'self', 'That’s your own page.')
    const t = now()
    const out = await d.tx(async (tx) => {
      const cur = await tx.get('profiles', user.uid)
      const list = (cur?.subscribers || []).filter((x) => x.uid !== who.uid)
      if (drop) tx.del('subs', `${user.uid}_${who.uid}`)
      else {
        if (list.length >= 500) throw new ApiError(409, 'full', 'You have 500 subscribers, the most a page can have for now.')
        list.unshift({ uid: who.uid, handle: h, since: t })
        tx.set('subs', `${user.uid}_${who.uid}`, { creator: user.uid, sub: who.uid, handle: h, since: t })
      }
      tx.patch('profiles', user.uid, { subscribers: list, updatedAt: t })
      return list
    })
    bust()
    return { subscribers: out.map((x) => ({ handle: x.handle, since: x.since })) }
  }

  async function mustProfile(user) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    const p = await profileOf(user.uid)
    if (!p) throw new ApiError(409, 'no_profile', 'Make your page first.')
    return p
  }

  // ---- alerts ----------------------------------------------------------------------------------
  async function alertsFor(user) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    const a = (await d.get('alerts', user.uid)) || { items: [], seenAt: 0 }
    const items = a.items || []
    return { items, unread: items.filter((x) => x.at > (a.seenAt || 0)).length, seenAt: a.seenAt || 0 }
  }
  async function seenAlerts(user) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    await d.merge('alerts', user.uid, { seenAt: now() })
    return { ok: true }
  }

  // ---- all of someone's picks (coach, records) ------------------------------------------------
  async function allPicksOf(uid, max = 1000) {
    const all = []
    let before
    while (all.length < max) {
      const page = await picksOf(uid, { limit: 200, before })
      all.push(...page)
      if (page.length < 200) break
      before = page[page.length - 1].createdAt
    }
    return all
  }

  async function coachFor(user) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    return cached(`coach:${user.uid}`, 60_000, async () => {
      const all = await allPicksOf(user.uid)
      const out = coachOf(all, { now: now(), tz: billingConfig().usageTz })
      // the picks behind every insight, so each one can be checked
      const ids = new Set([...out.insights.flatMap((x) => x.picks), ...out.week.picks])
      const refs = {}
      for (const p of all) {
        if (!ids.has(p.id)) continue
        refs[p.id] = { id: p.id, createdAt: p.createdAt, result: p.result, units: p.units, profit: p.profit ?? null, price: p.price, clv: Number.isFinite(p.clv) ? p.clv : null, legs: p.legs.map((l) => `${l.short || l.name} ${l.label}`) }
      }
      return { ...out, refs }
    })
  }

  // ---- responsible betting ---------------------------------------------------------------------
  async function rgView(uid, rg) {
    const t = now()
    const tz = billingConfig().usageTz
    const days = [...new Set(Array.from({ length: 7 }, (_, i) => dayKey(t - i * DAY_MS, tz)))]
    const [usages, prof] = await Promise.all([Promise.all(days.map((k) => d.get('pickUsage', `${uid}_${k}`))), profileOf(uid)])
    return {
      limits: effectiveLimits(rg, t),
      pending: rg?.pending && rg.pending.at > t ? rg.pending : null,
      coolUntil: (rg?.coolUntil || 0) > t ? rg.coolUntil : null,
      excludedUntil: (rg?.excludedUntil || 0) > t ? rg.excludedUntil : null,
      pausedUntil: pausedUntil(rg, t) || null,
      usage: { picksToday: usages[0]?.n || 0, unitsToday: usages[0]?.units || 0, unitsWeek: round(usages.reduce((s, u) => s + (u?.units || 0), 0), 2), netWeek: netWeek(prof?.stats, days[days.length - 1]) },
      options: { coolDays: COOL_DAYS, excludeMonths: EXCLUDE_MONTHS },
    }
  }
  async function rgGet(user) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    return rgView(user.uid, await d.get('rg', user.uid))
  }
  async function rgLimits(user, body = {}) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    const wanted = cleanLimits(body)
    const t = now()
    const next = await d.tx(async (tx) => {
      const cur = await tx.get('rg', user.uid)
      const n = nextLimits(cur, wanted, t)
      tx.set('rg', user.uid, n)
      return n
    })
    return rgView(user.uid, next)
  }
  /** A break (days) or a self-exclusion (months). Neither can be shortened once set. */
  async function rgPause(user, { kind, days, months } = {}) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    const t = now()
    let field
    let until
    if (kind === 'cool') {
      if (!COOL_DAYS.includes(Number(days))) throw new ApiError(400, 'bad_pause', `Pick ${COOL_DAYS.join(', ')} days.`)
      field = 'coolUntil'
      until = t + Number(days) * DAY_MS
    } else if (kind === 'exclude') {
      if (!EXCLUDE_MONTHS.includes(Number(months))) throw new ApiError(400, 'bad_pause', `Pick ${EXCLUDE_MONTHS.join(', ')} months.`)
      field = 'excludedUntil'
      until = t + Math.round(Number(months) * 30.44) * DAY_MS
    } else throw new ApiError(400, 'bad_pause', 'Choose a break or a self-exclusion.')
    const next = await d.tx(async (tx) => {
      const cur = (await tx.get('rg', user.uid)) || {}
      const n = { ...cur, [field]: Math.max(cur[field] || 0, until), updatedAt: t }
      tx.set('rg', user.uid, n)
      return n
    })
    return rgView(user.uid, next)
  }
  /** For other features (contests): { coolUntil, excludedUntil } or null. */
  async function pauseOf(uid) {
    if (!uid) return null
    const rg = await d.get('rg', uid)
    const t = now()
    return pausedUntil(rg, t) ? { coolUntil: rg.coolUntil || 0, excludedUntil: rg.excludedUntil || 0, error: pauseError(rg, t) } : null
  }

  // ---- live slips ------------------------------------------------------------------------------
  async function liveFor(user) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    const t = now()
    const list = await picksOf(user.uid, { limit: 60 })
    const open = list.filter((p) => p.status === 'open' && p.lockAt <= t)
    let at = 0
    const out = open.map((p) => {
      const legs = p.legs.map((l) => {
        const base = publicLeg(l)
        if (l.result) return { ...base, chance: l.result === 'win' ? 1 : l.result === 'loss' ? 0 : null }
        const eng = engineOf(l.sport || 'nfl')
        if (!eng) return { ...base, chance: null }
        const tr = eng.views.track([l.id]).legs[0]
        const row = eng.views.findProp(l.id)
        at = Math.max(at, eng.wh.at?.summaries || 0)
        const prog = tr?.live || null
        return { ...base, game: tr?.game ? { status: tr.game.status, home: tr.game.home?.abbr, away: tr.game.away?.abbr } : null, live: prog ? { cur: prog.cur, line: prog.line, projected: prog.projected, elapsed: prog.elapsed, status: prog.status, final: prog.final, untracked: Boolean(prog.untracked) } : null, chance: liveChance(row, prog) }
      })
      const live = legs.filter((l) => l.result !== 'void' && l.result !== 'push')
      const dec = live.reduce((x, l) => x * decimalOf(l.price), 1)
      const chance = slipChance(legs)
      const payout = round(p.units * dec, 2)
      return { id: p.id, units: p.units, price: decimalToAmerican(dec), decimal: round(dec, 3), payout, chance, fair: Number.isFinite(chance) ? round(chance * payout, 2) : null, legs }
    })
    return { picks: out, at: at || null, refreshMs: 20_000, now: t }
  }

  return { me, saveProfile, post, check, remove, tail, page, feed, leaderboard, gradeOpen, watchOpen, maybeGrade, syncPlan, setHidden, rebuildRecord, eliteUntilFor, publicProfile, pickFor, subscribers, setSubscriber, alertsFor, seenAlerts, coachFor, rgGet, rgLimits, rgPause, pauseOf, liveFor, _atLeast: atLeast }
}

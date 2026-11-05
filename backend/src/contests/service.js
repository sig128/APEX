// Weekly free-to-play contests. The admin builds a slate of 5 to 10 props from the board and
// publishes it; signed-in users pick a side on each for free, and each pick locks when its game
// starts. Every slate prop is graded once from the final box score (the same grading as picks),
// one point per right pick, and a tie goes to the entry that was last changed earliest.
//
// Storage, read by id or by one ordered field (no query needs a composite index):
//   contests/{id}                   settings, the slate (frozen at publish) with its results, winners
//   contestEntries/{id}_{uid}       one person's entry: their sides, when each changed, the 21+ check
//   contestBoards/{id}              every entry in short form, for standings; written in the same
//                                   transaction as the entry, so the two never drift apart
// Lists order contests by createdAt (admin), activeSince (open or closed) or finalAt (finished).
// Read, never written here: rg/{uid} (a break or self-exclusion) and profiles/{uid} (the handle).
import crypto from 'node:crypto'
import { ApiError } from '../lib/router.js'
import { MARKETS, marketOf } from '../nfl/markets.js'
import { parsePropId, propId } from '../nfl/analytics/core.js'
import { gradeLeg } from '../picks/service.js'
import { dayKey } from '../billing/service.js'
import { billingConfig } from '../billing/config.js'
import { log, errText } from '../lib/log.js'

export const MIN_PROPS = 5
export const MAX_PROPS = 10
export const MAX_PLACES = 10
// The board document holds every entry (about 120 bytes each), which keeps it well inside
// Firestore's 1 MiB document limit.
export const MAX_ENTRIES = 5000
const TOP = 50
const GRADE_EVERY_MS = 120_000
// no game is over this soon after it starts, so ESPN isn't asked before then
const ASK_AFTER_MS = 90 * 60_000
// about when a game ends (the 18-hour wait for a missing player's log counts from here)
const FINAL_AFTER_MS = 3.5 * 3600_000
// a game still not final three days after its start time was postponed or called off: void
const STALE_VOID_MS = 72 * 3600_000
const ID_RE = /^ct_[0-9a-f]{20}$/
const KEY_RE = /^p\d{1,2}$/
const ACTIVE = new Set(['open', 'closed'])

const cleanText = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/** '' or an https address (the official rules). Anything else is refused. */
export function rulesUrlOf(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  let u = null
  try {
    u = new URL(s)
  } catch {
    u = null
  }
  if (!u || u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password || s.length > 500) {
    throw new ApiError(400, 'bad_rules_url', 'The rules link has to be a full https:// address.')
  }
  return u.toString()
}

/**
 * Someone's responsible-play settings (their 'rg' document: { coolUntil, excludedUntil }, epoch
 * ms; null when they never set any). While either is in the future they can't enter a contest or
 * change an entry. The exclusion is named first: it's the longer and firmer of the two.
 */
export function rgBlock(rg, t) {
  if (!rg || typeof rg !== 'object') return null
  const excluded = Number(rg.excludedUntil) || 0
  const cool = Number(rg.coolUntil) || 0
  const day = (ms) => dayKey(ms, billingConfig().usageTz)
  if (excluded > t) return { code: 'self_excluded', until: excluded, message: `You’ve excluded yourself from picks and contests until ${day(excluded)}.` }
  if (cool > t) return { code: 'cooling_off', until: cool, message: `You’re on a break from picks and contests until ${day(cool)}.` }
  return null
}

/** One entry's tally against the slate's results. p: one character per slate prop ('o', 'u' or '-'). */
export function scoreOf(slate, p = '') {
  const s = { points: 0, correct: 0, wrong: 0, pushes: 0, pending: 0, picked: 0 }
  slate.forEach((prop, i) => {
    const side = p[i]
    if (side !== 'o' && side !== 'u') return
    s.picked++
    const r = prop.result
    if (!r) s.pending++
    else if (r === 'push' || r === 'void') s.pushes++
    else if (r === side) {
      s.correct++
      s.points++
    } else s.wrong++
  })
  return s
}

/** Standings: most points first; a tie goes to the entry last changed earliest. */
export function rank(slate, rows = []) {
  return rows
    .map((r) => ({ uid: r.u, name: r.n, handle: r.h || null, changedAt: r.t, createdAt: r.c, ...scoreOf(slate, r.p) }))
    .sort((a, b) => b.points - a.points || a.changedAt - b.changedAt || a.createdAt - b.createdAt || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
    .map((r, i) => ({ rank: i + 1, ...r }))
}

const encode = (slate, picks) => slate.map((p) => picks[p.id]?.side || '-').join('')

function splitRef(ref) {
  const s = String(ref)
  const i = s.indexOf(':')
  return i > 0 ? { key: s.slice(0, i), id: s.slice(i + 1) } : { key: 'nfl', id: s }
}

const seasonOf = (ts) => {
  const dt = new Date(ts)
  return dt.getUTCFullYear() - (dt.getUTCMonth() < 2 ? 1 : 0)
}

export function createContests({ docs, engines = {}, now = () => Date.now() }) {
  const d = docs
  const engineOf = (key) => (engines && Object.hasOwn(engines, key) && engines[key]?.views ? engines[key] : null)

  // Contests and their standings, kept a few seconds per instance (busted by this instance's writes).
  const memo = new Map()
  let listMemo = null
  const bust = (id) => {
    if (id) memo.delete(id)
    listMemo = null
  }

  // ---- the slate ------------------------------------------------------------------------------

  /** When a prop locks: its frozen start time, or earlier if the game was moved up. */
  function lockAtOf(p) {
    const g = engineOf(p.sport)?.wh?.games?.get(p.gameId)
    const k = g ? Date.parse(g.date) : NaN
    return Number.isFinite(k) && k < p.kickoff ? k : p.kickoff
  }
  /** Locked at its start time, or as soon as the scoreboard says the game is under way. */
  function isLocked(p, t) {
    if (t >= lockAtOf(p)) return true
    const st = engineOf(p.sport)?.wh?.games?.get(p.gameId)?.status?.state
    return Boolean(st && st !== 'pre')
  }

  const leagueName = (key) => String(key || '').toUpperCase()

  /** One slate prop from a board ref ("<id>" for NFL, "<league>:<id>"), frozen as it is right now. */
  function propFrom(ref) {
    const { key, id } = splitRef(ref)
    const eng = engineOf(key)
    const parsed = eng ? parsePropId(id) : null
    if (!parsed) throw new ApiError(400, 'bad_prop', 'One of those props is not valid.')
    const mk = marketOf(parsed.market)
    // entrants choose the side, so every prop is kept as its over (or yes) row
    const row = eng.views.findProp(propId(parsed.subject, parsed.market, 'o', parsed.line))
    if (!row) throw new ApiError(404, 'no_prop', 'That prop isn’t on the board anymore.')
    const stat = mk.long || mk.label
    const who = `${row.short || row.name} ${mk.oneSided ? stat : `${row.line} ${stat}`}`
    if (row.posted == null) {
      throw new ApiError(400, 'not_posted', row.main != null ? `${who} isn’t a line a sportsbook posted. The posted line is ${row.main}.` : `${who}: no sportsbook has posted this one.`)
    }
    const g = row.gameId ? eng.wh.games.get(row.gameId) : null
    if (!g) throw new ApiError(400, 'no_game', `${who} isn’t tied to a game on the current slate.`)
    const kick = Date.parse(g.date)
    if (g.status?.state !== 'pre' || !(kick - now() > 60_000)) throw new ApiError(400, 'started', `${g.shortName} has started, so ${who} can’t go on a slate.`)
    return {
      id: null,
      ref: `${key}:${row.id}`,
      sport: key,
      kind: row.kind,
      playerId: row.playerId || null,
      teamId: row.kind === 'team' ? row.teamId : null,
      name: row.name,
      short: row.short || row.name,
      headshot: row.headshot || null,
      pos: row.pos || null,
      teamAbbr: row.teamAbbr || null,
      oppAbbr: row.oppAbbr || null,
      home: Boolean(row.home),
      market: row.market,
      stat,
      line: row.line,
      oneSided: Boolean(mk.oneSided),
      label: mk.oneSided ? stat : `${row.line} ${stat}`,
      sides: mk.oneSided ? [{ side: 'o', label: 'Yes' }] : [{ side: 'o', label: `Over ${row.line}` }, { side: 'u', label: `Under ${row.line}` }],
      gameId: g.id,
      game: g.shortName,
      kickoff: kick,
      result: null,
      value: null,
      gradedAt: null,
    }
  }

  /** A fresh serverless instance may not have a league loaded yet: load it before reading its board. */
  async function warm(keys) {
    for (const key of keys) {
      const eng = engineOf(key)
      if (!eng || typeof eng.started !== 'function' || eng.started()) continue
      try {
        await eng.ensureStarted()
      } catch (e) {
        log.warn('contest slate: league failed to load', { sport: key, err: errText(e) })
      }
    }
  }

  /** Every ref checked, so the admin sees all the problems at once. All good, or it throws. */
  async function slateFrom(refs, leagues = []) {
    await warm([...new Set(refs.map((r) => splitRef(r).key))])
    const attempt = () =>
      refs.map((ref) => {
        try {
          return { ref, prop: propFrom(ref) }
        } catch (e) {
          if (!(e instanceof ApiError)) throw e
          return { ref, problem: { ref, code: e.code, error: e.message, status: e.status } }
        }
      })
    let out = attempt()
    // game logs still coming in on a fresh instance: give them a few seconds, once
    const waiting = [...new Set(out.filter((x) => x.problem?.code === 'no_prop').map((x) => splitRef(x.ref).key))].filter((k) => engineOf(k)?.catchUp && engineOf(k).logsLeft?.() > 0)
    if (waiting.length) {
      await Promise.all(waiting.map((k) => engineOf(k).catchUp(8000).catch(() => null)))
      out = attempt()
    }
    const seen = new Set()
    for (const x of out) {
      if (!x.prop) continue
      const p = x.prop
      const who = `${p.short} ${p.label}`
      const dup = `${p.sport}:${p.playerId || `t${p.teamId}`}:${p.market}`
      if (leagues.length && !leagues.includes(p.sport)) x.problem = { ref: x.ref, code: 'bad_league', error: `${who} is ${leagueName(p.sport)}, which isn’t one of this contest’s leagues.`, status: 400 }
      else if (seen.has(dup)) x.problem = { ref: x.ref, code: 'dup_prop', error: `${who} is on the slate twice. Keep one line per player and stat.`, status: 400 }
      seen.add(dup)
    }
    const problems = out.filter((x) => x.problem).map((x) => x.problem)
    if (problems.length) {
      const [first] = problems
      const msg = problems.length === 1 ? first.error : `${problems.length} of these props can’t go on the slate. ${first.error}`
      throw new ApiError(first.status, first.code, msg, { props: problems.map(({ ref, code, error }) => ({ ref, code, error })) })
    }
    return out.map((x, i) => ({ ...x.prop, id: `p${i + 1}` }))
  }

  // ---- shapes ---------------------------------------------------------------------------------

  function slateView(c, t) {
    return (c.slate || []).map((p) => ({
      id: p.id,
      sport: p.sport,
      kind: p.kind,
      playerId: p.playerId,
      teamId: p.teamId,
      name: p.name,
      short: p.short,
      headshot: p.headshot,
      pos: p.pos,
      teamAbbr: p.teamAbbr,
      oppAbbr: p.oppAbbr,
      home: Boolean(p.home),
      market: p.market,
      stat: p.stat,
      line: p.line,
      label: p.label,
      oneSided: p.oneSided,
      sides: p.sides,
      gameId: p.gameId,
      game: p.game,
      kickoff: p.kickoff,
      lockAt: lockAtOf(p),
      locked: c.status !== 'draft' && isLocked(p, t),
      result: p.result || null,
      value: p.value ?? null,
      gradedAt: p.gradedAt || null,
    }))
  }

  const publicRow = (r) => ({ rank: r.rank, name: r.name, handle: r.handle, points: r.points, correct: r.correct, wrong: r.wrong, pushes: r.pushes, pending: r.pending, picked: r.picked, changedAt: r.changedAt })

  function contestView(c, t) {
    const slate = slateView(c, t)
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      leagues: c.leagues || [],
      prize: c.prize || '',
      sponsor: c.sponsor || '',
      rulesUrl: c.rulesUrl || '',
      places: c.places || 1,
      entries: c.entries || 0,
      publishedAt: c.publishedAt || null,
      closedAt: c.closedAt || null,
      cancelledAt: c.cancelledAt || null,
      finalAt: c.finalAt || null,
      lockAt: slate.length ? Math.min(...slate.map((p) => p.lockAt)) : null,
      lastLockAt: slate.length ? Math.max(...slate.map((p) => p.lockAt)) : null,
      // entries can still be made or changed right now
      open: c.status === 'open' && slate.some((p) => !p.locked),
      graded: slate.filter((p) => p.result).length,
      slate,
    }
  }

  function summaryView(c, t) {
    const v = contestView(c, t)
    return {
      id: v.id,
      title: v.title,
      status: v.status,
      leagues: v.leagues,
      prize: v.prize,
      sponsor: v.sponsor,
      rulesUrl: v.rulesUrl,
      places: v.places,
      entries: v.entries,
      props: v.slate.length,
      graded: v.graded,
      lockAt: v.lockAt,
      lastLockAt: v.lastLockAt,
      open: v.open,
      publishedAt: v.publishedAt,
      finalAt: v.finalAt,
      winners: (c.final?.winners || []).map(publicRow),
    }
  }

  function entryView(c, e, ranked) {
    if (!e) return null
    const picks = Object.fromEntries(Object.entries(e.picks || {}).map(([k, v]) => [k, v.side]))
    return { picks, createdAt: e.createdAt, updatedAt: e.updatedAt, confirmedAt: e.confirmedAt || null, rank: ranked?.rank ?? null, ...scoreOf(c.slate || [], encode(c.slate || [], e.picks || {})) }
  }

  // ---- reads ----------------------------------------------------------------------------------

  /** A contest and its standings, shared by every viewer for a few seconds. */
  async function loaded(id) {
    const hit = memo.get(id)
    if (hit && hit.until > now()) return hit.value
    const c = await d.get('contests', id)
    let value = null
    if (c) {
      const board = c.status === 'draft' ? null : await d.get('contestBoards', id)
      value = { c, ranked: rank(c.slate || [], board?.rows || []) }
    }
    memo.set(id, { value, until: now() + 10_000 })
    if (memo.size > 200) memo.delete(memo.keys().next().value)
    return value
  }

  const activeList = () => d.recent('contests', { field: 'activeSince', where: [['activeSince', '>', 0]], limit: 25 })

  /** Open contests (soonest lock first) and the last few finished ones with their winners. */
  async function list() {
    if (!listMemo || listMemo.until <= now()) {
      const [active, finals] = await Promise.all([activeList(), d.recent('contests', { field: 'finalAt', limit: 10 })])
      listMemo = { active: active.filter((c) => ACTIVE.has(c.status)), finals: finals.filter((c) => c.status === 'final'), until: now() + 15_000 }
    }
    const t = now()
    const open = listMemo.active.map((c) => summaryView(c, t)).sort((a, b) => (a.lockAt ?? 0) - (b.lockAt ?? 0))
    return { contests: [...open, ...listMemo.finals.map((c) => summaryView(c, t))], at: t }
  }

  /** One contest: the slate with lock times and results, the top of the standings, and the viewer's entry. */
  async function view(id, viewer = null) {
    if (!ID_RE.test(String(id))) throw new ApiError(404, 'not_found', 'No such contest.')
    const base = await loaded(id)
    // never public: a draft, or one cancelled before it went live
    if (!base || !base.c.publishedAt) throw new ApiError(404, 'not_found', 'No such contest.')
    const t = now()
    const { c, ranked } = base
    const top = ranked.slice(0, TOP)
    const out = {
      contest: contestView(c, t),
      standings: { rows: top.map(publicRow), total: ranked.length },
      winners: (c.final?.winners || []).map(publicRow),
      you: null,
      at: t,
    }
    if (viewer?.uid && viewer.uid !== 'admin') {
      const [entry, rg] = await Promise.all([d.get('contestEntries', `${id}_${viewer.uid}`), d.get('rg', viewer.uid)])
      const mine = ranked.find((r) => r.uid === viewer.uid) || null
      out.you = { entered: Boolean(entry), entry: entryView(c, entry, mine), block: rgBlock(rg, t) }
      out.standings.rows = top.map((r, i) => (r.uid === viewer.uid ? { ...out.standings.rows[i], you: true } : out.standings.rows[i]))
    }
    return out
  }

  // ---- entering -------------------------------------------------------------------------------

  /** body.picks: { p1: 'o' | 'u' | 'yes' | null, ... }; keys left out keep what's saved. */
  function picksIn(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'bad_picks', 'Send your picks as { prop: side }.')
    const entries = Object.entries(v)
    if (entries.length > MAX_PROPS * 2) throw new ApiError(400, 'bad_picks', 'That is more picks than the slate has.')
    for (const [k, side] of entries) {
      if (!KEY_RE.test(k)) throw new ApiError(400, 'bad_prop', 'That prop isn’t on this contest’s slate.')
      if (side != null && typeof side !== 'string') throw new ApiError(400, 'bad_side', 'Pick over or under.')
    }
    return entries
  }

  function sideOf(p, raw) {
    const s = raw == null ? '' : String(raw).trim().toLowerCase()
    if (!s) return null
    if (p.oneSided) {
      if (s === 'o' || s === 'y' || s === 'yes' || s === 'over') return 'o'
      throw new ApiError(400, 'bad_side', `${p.short} ${p.label} only has a yes side.`)
    }
    if (s === 'o' || s === 'over') return 'o'
    if (s === 'u' || s === 'under') return 'u'
    throw new ApiError(400, 'bad_side', 'Pick over or under.')
  }

  function labelOf(uid, prof) {
    if (prof?.handle && !prof.hidden) return { n: `@${prof.handle}`, h: prof.handle }
    // no public picks page: a stable tag instead of anyone's real name
    return { n: `Entrant ${crypto.createHash('sha256').update(`propify-contest:${uid}`).digest('hex').slice(0, 6).toUpperCase()}`, h: null }
  }

  /**
   * Make or change an entry. Free, one per person per contest. Each pick can change until its
   * game starts and never after; the first save needs confirm: true (21+ and read the rules).
   */
  async function enter(user, id, body = {}) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in with Google to enter.')
    if (!ID_RE.test(String(id))) throw new ApiError(404, 'not_found', 'No such contest.')
    const want = picksIn(body.picks)
    const t = now()
    const out = await d.tx(async (tx) => {
      const c = await tx.get('contests', id)
      if (!c || !c.publishedAt) throw new ApiError(404, 'not_found', 'No such contest.')
      if (c.status === 'cancelled') throw new ApiError(409, 'cancelled', 'This contest was cancelled.')
      if (c.status !== 'open') throw new ApiError(409, 'closed', 'Entries for this contest are closed.')
      const block = rgBlock(await tx.get('rg', user.uid), t)
      if (block) throw new ApiError(403, block.code, block.message, { until: block.until })
      // the picks page, if any, names the entry on the standings
      const prof = await tx.get('profiles', user.uid)
      const eid = `${id}_${user.uid}`
      const cur = await tx.get('contestEntries', eid)
      const board = (await tx.get('contestBoards', id)) || { contestId: id, rows: [] }
      if (!cur) {
        if (body.confirm !== true) throw new ApiError(400, 'confirm', 'Confirm you’re 21 or older and have read the official rules.')
        if (c.slate.every((p) => isLocked(p, t))) throw new ApiError(409, 'all_locked', 'Every game on this slate has started, so entries are closed.')
        if ((board.rows || []).length >= MAX_ENTRIES) throw new ApiError(409, 'full', 'This contest is full.')
      }
      const picks = { ...(cur?.picks || {}) }
      const locked = []
      let changed = false
      for (const [k, raw] of want) {
        const p = c.slate.find((x) => x.id === k)
        if (!p) throw new ApiError(400, 'bad_prop', 'That prop isn’t on this contest’s slate.')
        const side = sideOf(p, raw)
        if ((picks[k]?.side || null) === side) continue
        if (isLocked(p, t)) {
          locked.push(p)
          continue
        }
        if (side) picks[k] = { side, at: t }
        else delete picks[k]
        changed = true
      }
      if (locked.length) {
        const [p] = locked
        const msg = locked.length === 1 ? `${p.game} has started, so your ${p.short} pick is locked.` : `${locked.length} of those games have started, so those picks are locked.`
        throw new ApiError(409, 'locked', msg, { props: locked.map((x) => x.id) })
      }
      if (!Object.keys(picks).length) throw new ApiError(400, 'no_picks', 'Pick a side on at least one prop.')
      if (cur && !changed) return { c, entry: cur, rows: board.rows || [] }
      const who = labelOf(user.uid, prof)
      const entry = {
        contestId: id,
        uid: user.uid,
        email: user.email || null,
        label: who.n,
        handle: who.h,
        picks,
        createdAt: cur?.createdAt || t,
        updatedAt: t,
        confirmedAt: cur?.confirmedAt || t,
        changes: (cur?.changes || 0) + 1,
      }
      const rows = (board.rows || []).filter((r) => r.u !== user.uid)
      rows.push({ u: user.uid, n: who.n, h: who.h, p: encode(c.slate, picks), t, c: entry.createdAt })
      tx.set('contestEntries', eid, entry)
      tx.set('contestBoards', id, { contestId: id, rows, updatedAt: t })
      if (!cur) tx.patch('contests', id, { entries: rows.length })
      return { c, entry, rows }
    })
    bust(id)
    const mine = rank(out.c.slate, out.rows).find((r) => r.uid === user.uid) || null
    return { you: { entered: true, entry: entryView(out.c, out.entry, mine), block: null } }
  }

  // ---- grading --------------------------------------------------------------------------------

  const summaries = new Map()
  async function finalSummary(p, t) {
    const eng = engineOf(p.sport)
    if (!eng) return null
    const s = eng.wh?.summaries?.get(p.gameId)?.data
    if (s?.status?.state === 'post') return s
    if (t - p.kickoff < ASK_AFTER_MS) return null
    const ck = `${p.sport}:${p.gameId}`
    const hit = summaries.get(ck)
    if (hit && t - hit.at < 5 * 60_000) return hit.s
    try {
      const fresh = await eng.espn.summary(p.gameId, { priority: 'background' })
      summaries.set(ck, { s: fresh, at: t })
      if (summaries.size > 300) summaries.delete(summaries.keys().next().value)
      return fresh
    } catch (e) {
      log.warn('contest grading: summary failed', { gameId: p.gameId, err: errText(e) })
      summaries.set(ck, { s: null, at: t })
      return null
    }
  }

  async function logRow(p, logs) {
    const eng = engineOf(p.sport)
    if (!eng) return null
    const season = p.sport === 'nfl' ? seasonOf(p.kickoff) : eng.wh.season || seasonOf(p.kickoff)
    const k = `${p.sport}:${p.playerId}:${season}`
    if (!logs.has(k)) {
      try {
        logs.set(k, await eng.espn.gamelog(p.playerId, season, { priority: 'background' }))
      } catch {
        logs.set(k, eng.wh.logs.get(p.playerId) || [])
      }
    }
    return (logs.get(k) || []).find((r) => r.eventId === p.gameId) || null
  }

  /** One slate prop's result, the same way a pick's leg is graded: 'o', 'u', 'push' or 'void'. Null = not yet. */
  async function gradeProp(p, t, logs) {
    const s = await finalSummary(p, t)
    const mk = MARKETS[p.market]
    const box = s?.players?.[p.playerId]?.stats
    const needLog = s?.status?.state === 'post' && p.playerId && !(box && (!mk?.keys || mk.keys.some((k) => box[k] != null)))
    const row = needLog ? await logRow(p, logs) : null
    const g = gradeLeg({ teamId: p.teamId, playerId: p.playerId, market: p.market, line: p.line, side: 'o' }, s, { finalAt: p.kickoff + FINAL_AFTER_MS, now: t, logRow: row })
    if (g) return { result: g.result === 'win' ? 'o' : g.result === 'loss' ? 'u' : g.result, value: g.value ?? null }
    if (t - p.kickoff > STALE_VOID_MS) return { result: 'void', value: null }
    return null
  }

  /** Every prop graded: the standings are final and the winners are kept on the contest. */
  function finalized(c, board, t) {
    const ranked = rank(c.slate, board?.rows || [])
    const keep = (r) => ({ rank: r.rank, uid: r.uid, name: r.name, handle: r.handle, points: r.points, correct: r.correct, wrong: r.wrong, pushes: r.pushes, pending: r.pending, picked: r.picked, changedAt: r.changedAt })
    // nobody wins with zero points
    const winners = ranked.filter((r) => r.points > 0).slice(0, c.places || 1)
    return { ...c, status: 'final', activeSince: undefined, finalAt: t, updatedAt: t, entries: ranked.length, final: { at: t, entries: ranked.length, winners: winners.map(keep), top: ranked.slice(0, TOP).map(keep) } }
  }

  let lastGrade = 0
  let grading = null
  /** Grade every slate prop whose game is final, once; finish contests whose slate is all graded. */
  async function gradeActive() {
    const t = now()
    const active = (await activeList()).filter((c) => ACTIVE.has(c.status))
    const logs = new Map()
    let graded = 0
    let finals = 0
    for (const c of active) {
      const results = new Map()
      for (const p of c.slate || []) {
        if (p.result || !isLocked(p, t)) continue
        const r = await gradeProp(p, t, logs)
        if (r) results.set(p.id, r)
      }
      if (!results.size) continue
      const done = await d.tx(async (tx) => {
        const cur = await tx.get('contests', c.id)
        if (!cur || !ACTIVE.has(cur.status)) return null
        let n = 0
        const slate = cur.slate.map((p) => {
          if (p.result || !results.has(p.id)) return p
          n++
          return { ...p, ...results.get(p.id), gradedAt: t }
        })
        if (!n) return null
        const last = slate.every((p) => p.result)
        const board = last ? await tx.get('contestBoards', c.id) : null
        const next = last ? finalized({ ...cur, slate }, board, t) : { ...cur, slate, updatedAt: t }
        tx.set('contests', c.id, next)
        return { n, final: last }
      })
      if (!done) continue
      graded += done.n
      if (done.final) finals++
      bust(c.id)
      if (done.final) log.info('contest final', { id: c.id })
    }
    lastGrade = t
    return { checked: active.length, graded, finals }
  }

  /** At most every two minutes per instance; callers don't wait on each other. */
  function maybeGrade() {
    if (grading) return grading
    if (now() - lastGrade < GRADE_EVERY_MS) return Promise.resolve({ skipped: true })
    grading = gradeActive()
      .catch((e) => {
        log.warn('contest grading failed', { err: errText(e) })
        return { error: true }
      })
      .finally(() => {
        grading = null
        lastGrade = now()
      })
    return grading
  }

  // ---- the admin ------------------------------------------------------------------------------

  const mustAdmin = (a) => {
    if (!a?.admin) throw new ApiError(403, 'admin', 'Admins only.')
  }
  const idOk = (id) => {
    if (!ID_RE.test(String(id))) throw new ApiError(404, 'not_found', 'No such contest.')
  }

  function placesOf(v) {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1 || n > MAX_PLACES) throw new ApiError(400, 'bad_places', `Winners has to be a whole number from 1 to ${MAX_PLACES}.`)
    return n
  }
  function leaguesOf(v) {
    if (v == null || v === '') return []
    const list = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    for (const k of list) if (!engineOf(k)) throw new ApiError(400, 'bad_league', `${leagueName(k)} isn’t a league on this site.`)
    return [...new Set(list)]
  }
  function refsOf(v) {
    if (!Array.isArray(v)) throw new ApiError(400, 'bad_slate', 'The slate is a list of props from the board.')
    const refs = v.map((x) => String(x ?? '').trim()).filter(Boolean)
    if (refs.length > MAX_PROPS) throw new ApiError(400, 'too_many', `A slate has at most ${MAX_PROPS} props.`)
    return refs
  }

  /** The fields a draft can set. The slate is checked against the board as it is now. */
  async function draftFields(body) {
    const f = {}
    if ('title' in body) f.title = cleanText(body.title, 80)
    if ('prize' in body) f.prize = cleanText(body.prize, 200)
    if ('sponsor' in body) f.sponsor = cleanText(body.sponsor, 80)
    if ('rulesUrl' in body) f.rulesUrl = rulesUrlOf(body.rulesUrl)
    if ('places' in body) f.places = placesOf(body.places)
    if ('slate' in body) {
      const refs = refsOf(body.slate)
      const slate = await slateFrom(refs, leaguesOf(body.leagues))
      f.slate = slate
      f.refs = slate.map((p) => p.ref)
      f.leagues = [...new Set(slate.map((p) => p.sport))]
    }
    return f
  }

  async function create(admin, body = {}) {
    mustAdmin(admin)
    const f = await draftFields(body || {})
    const t = now()
    const c = { id: `ct_${crypto.randomBytes(10).toString('hex')}`, status: 'draft', title: 'Weekly contest', prize: '', sponsor: '', rulesUrl: '', places: 1, leagues: [], refs: [], slate: [], entries: 0, createdAt: t, updatedAt: t, ...f }
    if (!c.title) c.title = 'Weekly contest'
    await d.set('contests', c.id, c)
    bust(c.id)
    return { contest: adminContest(c, t) }
  }

  async function update(admin, id, body = {}) {
    mustAdmin(admin)
    idOk(id)
    const f = await draftFields(body || {})
    const t = now()
    const next = await d.tx(async (tx) => {
      const cur = await tx.get('contests', id)
      if (!cur) throw new ApiError(404, 'not_found', 'No such contest.')
      if (cur.status !== 'draft') throw new ApiError(409, 'not_draft', 'Only a draft can be edited. Cancel this one and start a new one to change it.')
      const c = { ...cur, ...f, updatedAt: t }
      if (!c.title) c.title = 'Weekly contest'
      tx.set('contests', id, c)
      return c
    })
    bust(id)
    return { contest: adminContest(next, t) }
  }

  /** Live: entries open. Needs a title and 5 to 10 props, and an https rules link when there's a prize. */
  async function publish(admin, id) {
    mustAdmin(admin)
    idOk(id)
    const cur = await d.get('contests', id)
    if (!cur) throw new ApiError(404, 'not_found', 'No such contest.')
    if (cur.status !== 'draft') throw new ApiError(409, 'not_draft', 'This contest is already published.')
    if (!cur.title) throw new ApiError(400, 'no_title', 'Give the contest a title.')
    const refs = cur.refs || []
    if (refs.length < MIN_PROPS || refs.length > MAX_PROPS) throw new ApiError(400, 'slate_size', `A slate needs ${MIN_PROPS} to ${MAX_PROPS} props. This one has ${refs.length}.`)
    if (cur.prize && !cur.rulesUrl) throw new ApiError(400, 'rules_url', 'A contest with a prize needs a link to its official rules (https) before it goes live.')
    // re-checked and frozen now: names, lines, sides, games and start times as they are at publish
    const slate = await slateFrom(refs)
    const t = now()
    const next = await d.tx(async (tx) => {
      const c = await tx.get('contests', id)
      if (!c || c.status !== 'draft') throw new ApiError(409, 'not_draft', 'This contest is already published.')
      const out = { ...c, status: 'open', slate, refs: slate.map((p) => p.ref), leagues: [...new Set(slate.map((p) => p.sport))], entries: 0, publishedAt: t, activeSince: t, updatedAt: t }
      tx.set('contests', id, out)
      tx.set('contestBoards', id, { contestId: id, rows: [], updatedAt: t })
      return out
    })
    bust(id)
    log.info('contest published', { id, props: slate.length })
    return { contest: adminContest(next, t) }
  }

  async function transition(id, fn) {
    idOk(id)
    const t = now()
    const next = await d.tx(async (tx) => {
      const cur = await tx.get('contests', id)
      if (!cur) throw new ApiError(404, 'not_found', 'No such contest.')
      const c = fn(cur, t)
      tx.set('contests', id, c)
      return c
    })
    bust(id)
    return { contest: adminContest(next, t) }
  }

  /** No new entries or changes; grading carries on and the contest still finishes. */
  async function close(admin, id) {
    mustAdmin(admin)
    return transition(id, (c, t) => {
      if (c.status !== 'open') throw new ApiError(409, 'not_open', c.status === 'closed' ? 'Entries are already closed.' : 'Only an open contest can close its entries.')
      return { ...c, status: 'closed', closedAt: t, updatedAt: t }
    })
  }

  async function cancel(admin, id) {
    mustAdmin(admin)
    return transition(id, (c, t) => {
      if (c.status === 'final') throw new ApiError(409, 'final', 'A finished contest can’t be cancelled.')
      if (c.status === 'cancelled') throw new ApiError(409, 'cancelled', 'This contest is already cancelled.')
      return { ...c, status: 'cancelled', activeSince: undefined, cancelledAt: t, updatedAt: t }
    })
  }

  function adminContest(c, t) {
    return { ...contestView(c, t), refs: c.refs || [], createdAt: c.createdAt, updatedAt: c.updatedAt, final: c.final || null }
  }

  async function adminList(admin) {
    mustAdmin(admin)
    const t = now()
    const rows = await d.recent('contests', { field: 'createdAt', limit: 100 })
    return { contests: rows.map((c) => ({ ...summaryView(c, t), createdAt: c.createdAt, updatedAt: c.updatedAt })), at: t }
  }

  /** One contest for the admin: everything, the standings with who's who, and how to reach the winners. */
  async function adminView(admin, id) {
    mustAdmin(admin)
    idOk(id)
    const c = await d.get('contests', id)
    if (!c) throw new ApiError(404, 'not_found', 'No such contest.')
    const t = now()
    const board = c.status === 'draft' ? null : await d.get('contestBoards', id)
    const ranked = rank(c.slate || [], board?.rows || [])
    const winners = c.final?.winners || []
    const entries = await Promise.all(winners.map((w) => d.get('contestEntries', `${id}_${w.uid}`)))
    return {
      contest: adminContest(c, t),
      standings: { rows: ranked.slice(0, TOP).map((r) => ({ ...publicRow(r), uid: r.uid })), total: ranked.length },
      winners: winners.map((w, i) => ({ ...w, email: entries[i]?.email || null })),
      at: t,
    }
  }

  async function gradeNow(admin) {
    mustAdmin(admin)
    return gradeActive()
  }

  return { list, view, enter, gradeActive, maybeGrade, create, update, publish, close, cancel, adminList, adminView, gradeNow }
}

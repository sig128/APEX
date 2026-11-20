// The live movement ticker (paid): for every pick PropPickz has posted, what has moved since.
// The line and price (the board's book and the best across books), injury and lineup news, the
// board changing its mind, and a status: still valid, line moved, at risk, or voided. At kickoff
// the pick closes and its closing line value is kept.
//
// Built only from data the engine already has (no extra odds calls). The state lives in the store
// so every server instance tells the same story: when each pick was posted and at what number,
// the last state seen, the close, and the recent changes. Free visitors get a snapshot that is at
// least 30 minutes old; the live list only goes to members (the routes decide who is who).
import { americanToProb } from '../lib/odds.js'
import { propId } from './analytics/core.js'

const MIN = 60_000
const HOUR = 60 * MIN
export const DELAY_MS = 30 * MIN
const SNAP_EVERY = 10 * MIN
const SNAPS_KEPT = 6
const KEEP_AFTER_KICKOFF = 8 * HOUR
const MAX_PICKS = 40
const MAX_EVENTS = 6
const TOP_PICKS = 20

export const STATUS_LABEL = { valid: 'Still valid', moved: 'Line moved', risk: 'Pick at risk', void: 'Pick voided', live: 'In play', closed: 'Closed' }
// how serious an injury tag is, for "did it get worse since the pick was posted"
const SEV = { probable: 0, returning: 0, daytoday: 1, questionable: 1, doubtful: 2, out: 3 }
const sevOf = (tag) => (tag == null ? -1 : SEV[tag] ?? 0)
const prob = (a) => americanToProb(a)
const r1 = (x) => Math.round(x * 10) / 10
const r3 = (x) => Math.round(x * 1000) / 1000

export const subjectOf = (c) => (c.playerId ? String(c.playerId) : `t${c.teamId}`)
/** One pick, whatever its line does: who, which stat, which side. */
export const pickKey = (c) => `${subjectOf(c)}.${c.market}.${c.side === 'u' ? 'u' : 'o'}`
const sideField = (c) => (c.oneSided ? 'yes' : c.side === 'u' ? 'under' : 'over')
const fmtOdds = (a) => (a == null ? '' : a > 0 ? `+${a}` : `−${Math.abs(a)}`)
const fmtLine = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1))
const sideWord = (c) => (c.oneSided ? '' : c.side === 'u' ? 'Under' : 'Over')

/**
 * The state of one posted pick right now, from the board: the book's main line, the price on the
 * pick's side there, the best price across books, the model's chance at the posted line and at
 * the current one, injury and lineup news, and the game.
 */
export function stateOf({ posted, main, atPosted, atNow, board, inPicks, inj, boost, game, dataAt }) {
  const f = sideField(posted)
  const price = atNow?.price ? atNow.price[f] ?? null : null
  const best = atNow?.price?.best?.[f]
  return {
    line: main ? main.line : null,
    price: Number.isFinite(price) ? price : null,
    book: atNow?.price?.book || null,
    best: best && Number.isFinite(best.price) ? { price: best.price, book: best.book || null } : null,
    prob: Number.isFinite(atPosted?.prob) ? r3(atPosted.prob) : null,
    probNow: Number.isFinite(atNow?.prob) ? r3(atNow.prob) : null,
    // the board backs the other side of this stat now
    flipped: Boolean(board && board.side !== (posted.side === 'u' ? 'u' : 'o') && !posted.oneSided),
    inPicks: Boolean(inPicks),
    inj: inj?.tag || null,
    injText: inj ? String(inj.detail || inj.status || inj.label || '').slice(0, 60) || null : null,
    boost: boost?.short || null,
    state: game?.status?.state || 'pre',
    voidGame: /POSTPONED|CANCELED|CANCELLED/.test(game?.status?.name || ''),
    at: dataAt || 0,
  }
}

const sameState = (a, b) => Boolean(a && b) && ['line', 'price', 'prob', 'flipped', 'inPicks', 'inj', 'boost', 'state', 'voidGame'].every((k) => a[k] === b[k]) && (a.best?.price ?? null) === (b.best?.price ?? null) && (a.best?.book ?? null) === (b.best?.book ?? null)

/** Which way the market went for someone holding the pick: 'up' (toward it), 'down', or null. */
export function directionOf(posted, line, price) {
  const over = posted.side !== 'u'
  if (line != null && posted.line != null && line !== posted.line) return (line > posted.line) === over ? 'up' : 'down'
  const a = prob(price)
  const b = prob(posted.price)
  if (a == null || b == null || Math.abs(a - b) < 0.005) return null
  return a > b ? 'up' : 'down'
}

/** Closing line value for the pick: in points when the line moved, in implied chance when it didn't. */
export function clvOf(posted, close) {
  if (!close || close.line == null || posted.line == null) return null
  if (close.line !== posted.line) {
    const pts = posted.side === 'u' ? posted.line - close.line : close.line - posted.line
    return { kind: 'line', value: r1(pts) }
  }
  const a = prob(close.price)
  const b = prob(posted.price)
  if (a == null || b == null) return null
  return { kind: 'price', value: r3(a - b) }
}

/** The tag for a pick, with the reason. */
export function assess(posted, s, close = null) {
  if (!s) return { status: 'valid', why: null }
  if (s.voidGame) return { status: 'void', why: 'Game postponed' }
  if (s.inj === 'out') return { status: 'void', why: 'Ruled out' }
  if (s.state === 'in') return { status: 'live', why: close ? null : 'Game started' }
  if (s.state === 'post') return { status: 'closed', why: 'Final' }
  if (s.line == null) return { status: 'risk', why: 'Line off the board' }
  if (sevOf(s.inj) >= 2 || (sevOf(s.inj) >= 1 && sevOf(s.inj) > sevOf(posted.inj))) return { status: 'risk', why: s.injText ? `${tagWord(s.inj)}: ${s.injText}` : tagWord(s.inj) }
  if (s.flipped) return { status: 'risk', why: `The board now leans ${posted.side === 'u' ? 'over' : 'under'}` }
  if (s.prob != null && s.prob < 0.5) return { status: 'risk', why: `Under 50% at ${fmtLine(posted.line)} now` }
  if (s.line !== posted.line) return { status: 'moved', why: `${fmtLine(posted.line)} → ${fmtLine(s.line)}` }
  const a = prob(s.price)
  const b = prob(posted.price)
  if (a != null && b != null && Math.abs(a - b) >= 0.025) return { status: 'moved', why: `${fmtOdds(posted.price)} → ${fmtOdds(s.price)}` }
  return { status: 'valid', why: null }
}
const tagWord = (t) => ({ out: 'Out', doubtful: 'Doubtful', questionable: 'Questionable', daytoday: 'Day-to-day', probable: 'Probable', returning: 'Returning' })[t] || 'Injury news'

/** What changed between two looks at a pick, as ticker lines. */
export function changes(posted, prev, s, t) {
  const out = []
  if (!prev) return out
  // size: how big a line move (points) or price move (cents) was, for alert thresholds
  const add = (kind, text, dir = null, size = null) => out.push(size == null ? { t, kind, text, dir } : { t, kind, text, dir, size })
  if (prev.line !== s.line) {
    if (s.line == null) add('line', 'Line pulled at the book', 'down')
    else if (prev.line == null) add('line', `Line back up at ${fmtLine(s.line)}`, directionOf(posted, s.line, s.price))
    else add('line', `Line ${fmtLine(prev.line)} → ${fmtLine(s.line)}`, directionOf(posted, s.line, s.price), r1(Math.abs(s.line - prev.line)))
  } else if (prev.price != null && s.price != null && prev.price !== s.price) {
    const a = prob(s.price)
    const b = prob(prev.price)
    // a cent here and there is noise; report a real move (about 10 cents near even money)
    if (a != null && b != null && Math.abs(a - b) >= 0.02) add('price', `${sideWord(posted) || 'Price'} ${fmtOdds(prev.price)} → ${fmtOdds(s.price)}`.trim(), a > b ? 'up' : 'down', centsBetween(prev.price, s.price))
  }
  if (s.best && (!prev.best || s.best.price > prev.best.price + 4) && s.best.book && s.best.book !== s.book && s.line === prev.line) add('book', `Best price ${fmtOdds(s.best.price)} at ${bookName(s.best.book)}`, null)
  if (prev.inj !== s.inj) {
    if (s.inj === 'out') add('injury', s.injText ? `Ruled out: ${s.injText}` : 'Ruled out', 'down')
    else if (s.inj && sevOf(s.inj) > sevOf(prev.inj)) add('injury', s.injText ? `${tagWord(s.inj)}: ${s.injText}` : tagWord(s.inj), 'down')
    else if (sevOf(s.inj) < sevOf(prev.inj)) add('injury', s.inj ? `Upgraded to ${tagWord(s.inj).toLowerCase()}` : 'Off the injury report', 'up')
  }
  if (s.boost && s.boost !== prev.boost) add('lineup', `Teammate out: ${s.boost}`, 'up')
  if (s.flipped && !prev.flipped) add('board', `The board now leans ${posted.side === 'u' ? 'over' : 'under'}`, 'down')
  if (!s.flipped && prev.flipped) add('board', `The board is back on the ${posted.side === 'u' ? 'under' : 'over'}`, 'up')
  if (!s.inPicks && prev.inPicks && s.state === 'pre') add('board', 'Dropped out of the PropPickz picks', 'down')
  if (s.voidGame && !prev.voidGame) add('game', 'Game postponed', 'down')
  return out
}

/** Cents between two American prices, across even money too (+105 to −110 is 15). */
export function centsBetween(a, b) {
  const x = (p) => (p > 0 ? p - 100 : p + 100)
  return Math.abs(x(a) - x(b))
}

const BOOK_NAMES = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', caesars: 'Caesars', williamhill_us: 'Caesars', bet365: 'bet365', fanatics: 'Fanatics', betrivers: 'BetRivers', espnbet: 'theScore Bet', thescore: 'theScore Bet', pointsbetus: 'PointsBet', betonlineag: 'BetOnline', bovada: 'Bovada', mybookieag: 'MyBookie', hardrockbet: 'Hard Rock Bet', ballybet: 'Bally Bet', espn: 'ESPN BET' }
const bookName = (k) => BOOK_NAMES[String(k).toLowerCase()] || String(k)

const WEIGHT = { post: 1, book: 2, board: 3, price: 4, lineup: 5, line: 6, injury: 7, game: 8, close: 9 }

/** The ticker's line for one pick, as the page shows it. */
export function itemOf(P, L, C, events) {
  const a = assess(P, L, C)
  const line = L?.line ?? P.line
  const price = L?.price ?? null
  const clv = clvOf(P, C)
  // newest first; news that lands together reads in order of weight (an injury before a reshuffle)
  const evs = [...(events || [])].sort((a, b) => a.t - b.t || (WEIGHT[a.kind] || 0) - (WEIGHT[b.kind] || 0))
  return {
    key: P.key,
    id: P.id,
    sport: P.sport,
    gameId: P.gameId,
    kickoff: P.kickoff,
    name: P.name,
    short: P.short,
    teamAbbr: P.teamAbbr,
    oppAbbr: P.oppAbbr,
    headshot: P.headshot || null,
    market: P.market,
    label: P.label,
    shortLabel: P.shortLabel,
    side: P.side,
    lock: Boolean(P.lock),
    posted: { t: P.t, line: P.line, price: P.price, book: P.book, best: P.best, prob: P.prob, inj: P.inj },
    now: L ? { t: L.at || null, line: L.line, price: L.price, book: L.book, best: L.best, prob: L.prob, probNow: L.probNow, inj: L.inj, boost: L.boost } : null,
    close: C ? { t: C.t, line: C.line, price: C.price } : null,
    moved: { line: line != null && P.line != null ? r1(line - P.line) : null, chance: L?.prob != null && P.prob != null ? r3(L.prob - P.prob) : null },
    dir: directionOf(P, line, price),
    status: a.status,
    statusLabel: STATUS_LABEL[a.status],
    why: a.why,
    clv,
    events: evs.slice(-MAX_EVENTS).reverse(),
    at: evs.length ? evs[evs.length - 1].t : P.t,
  }
}

/** The list the ticker shows: newest change first, voided and at-risk picks never buried. */
export function itemsOf(doc) {
  if (!doc?.posted) return []
  const items = Object.values(doc.posted).map((P) => itemOf(P, doc.last?.[P.key], doc.close?.[P.key], doc.events?.[P.key]))
  return items.sort((a, b) => b.at - a.at)
}

export function createTicker({ engine, store, now = () => Date.now() }) {
  const sport = engine.sport?.key || 'nfl'
  const NS = `ticker-${sport}`
  let mem = null // the last doc this instance read or wrote
  let lastTick = 0
  let busy = null
  const stats = { ticks: 0, changes: 0, error: null }

  /** The picks PropPickz has out right now: the board's top picks and the lock's legs. */
  function currentPicks() {
    const v = engine.views
    const out = new Map()
    const home = v.home()
    for (const c of (home.tabs?.apex || []).slice(0, TOP_PICKS)) if (c) out.set(pickKey(c), { c, lock: false })
    let lock = null
    try {
      lock = v.lock()?.lock
    } catch {
      lock = null
    }
    for (const l of lock?.legs || []) {
      const k = pickKey(l)
      if (out.has(k)) out.get(k).lock = true
      else out.set(k, { c: l, lock: true })
    }
    return out
  }

  /** The book's main line for a stat on a game, from the warehouse (null when it's down). */
  function mainLine(P) {
    const props = engine.wh.lines.get(String(P.gameId))?.props || []
    const team = P.subject.startsWith('t')
    const hit = props.find((x) => x.market === P.market && (team ? !x.athleteId && String(x.teamId) === P.subject.slice(1) : String(x.athleteId) === P.subject))
    return hit && Number.isFinite(hit.line) ? { line: hit.line, open: hit.open ?? null } : null
  }

  function stateNow(P, picks, byId) {
    const v = engine.views
    const game = engine.wh.games.get(String(P.gameId))
    const main = mainLine(P)
    const side = P.side === 'u' ? 'u' : 'o'
    const atPosted = v.findProp(propId(P.subject, P.market, side, P.line))
    const atNow = main ? (main.line === P.line ? atPosted : v.findProp(propId(P.subject, P.market, side, main.line))) : null
    // the board's own side on this stat at the main line, if it lists one
    const other = side === 'u' ? 'o' : 'u'
    const board = main ? byId.get(propId(P.subject, P.market, side, main.line)) || byId.get(propId(P.subject, P.market, other, main.line)) || null : null
    const st = P.subject.startsWith('t') ? null : v.statusOf(P.subject)
    return stateOf({
      posted: P,
      main,
      atPosted,
      atNow,
      board,
      inPicks: picks.has(P.key),
      inj: st?.tag ? { tag: st.tag, detail: st.detail || null, status: st.status || null, label: st.label || null } : null,
      boost: atNow?.boost || atPosted?.boost || null,
      game,
      dataAt: engine.wh.at?.lines || 0,
    })
  }

  function postedOf(key, { c, lock }, t) {
    const f = sideField(c)
    // a board card carries prices by side; a lock leg carries the one price it was built on
    const price = Number.isFinite(c.price) ? c.price : c.price && Number.isFinite(c.price[f]) ? c.price[f] : null
    const best = c.shop && Number.isFinite(c.shop.price) ? { price: c.shop.price, book: c.shop.book || null } : null
    const st = c.playerId ? engine.views.statusOf(String(c.playerId)) : null
    const inj = st?.tag || null
    const ko = typeof c.kickoff === 'number' ? c.kickoff : Date.parse(c.kickoff)
    return {
      key,
      id: propId(subjectOf(c), c.market, c.side === 'u' ? 'u' : 'o', c.line),
      subject: subjectOf(c),
      sport,
      gameId: String(c.gameId),
      kickoff: Number.isFinite(ko) ? ko : null,
      name: c.name,
      short: c.short || c.name,
      teamAbbr: c.teamAbbr || null,
      oppAbbr: c.oppAbbr || null,
      headshot: c.headshot || null,
      market: c.market,
      label: c.label,
      shortLabel: c.shortLabel || c.label,
      side: c.side === 'u' ? 'u' : 'o',
      oneSided: Boolean(c.oneSided),
      line: c.line,
      price,
      book: (c.price && typeof c.price === 'object' ? c.price.book : null) || c.book || null,
      best,
      prob: Number.isFinite(c.prob) ? r3(c.prob) : null,
      inj,
      lock: Boolean(lock),
      t,
    }
  }

  /** One look at the board: post new picks, note what moved, close what kicked off. */
  async function tick() {
    if (busy) return busy
    busy = (async () => {
      const t = now()
      lastTick = t
      // nothing to follow until the board is in (a fresh server is still loading)
      if (!engine.views || !engine.wh?.games?.size || !engine.views.allRows().rows.length) return { skipped: true }
      const picks = currentPicks()
      const byId = engine.views.allRows().byId
      let changed = 0
      const doc = await store.update(NS, 'state', (cur) => {
        changed = 0
        const d = cur && cur.v === 1 ? cur : { v: 1, sport, posted: {}, last: {}, close: {}, events: {}, snaps: [], snapAt: 0 }
        let dirty = !cur || cur.v !== 1
        const push = (key, evs) => {
          if (!evs.length) return
          d.events[key] = [...(d.events[key] || []), ...evs].slice(-MAX_EVENTS * 2)
          changed += evs.length
          dirty = true
        }
        // newly posted picks (a pick is followed from the first time it's out, while its game is ahead)
        for (const [key, p] of picks) {
          if (d.posted[key]) {
            if (p.lock && !d.posted[key].lock) {
              d.posted[key].lock = true
              dirty = true
            }
            continue
          }
          const g = engine.wh.games.get(String(p.c.gameId))
          if (!g || g.status?.state !== 'pre') continue
          if (Object.keys(d.posted).length >= MAX_PICKS) break
          const P = postedOf(key, p, t)
          d.posted[key] = P
          push(key, [{ t, kind: 'post', text: `Posted: ${P.label}${P.price != null ? ` at ${fmtOdds(P.price)}` : ''}`, dir: null }])
        }
        for (const key of Object.keys(d.posted)) {
          const P = d.posted[key]
          if (P.kickoff && t - P.kickoff > KEEP_AFTER_KICKOFF) {
            delete d.posted[key]
            delete d.last[key]
            delete d.close[key]
            delete d.events[key]
            dirty = true
            continue
          }
          const prev = d.last[key] || null
          const S = stateNow(P, picks, byId)
          // another instance with fresher lines already wrote this pick: don't undo it
          if (prev && S.at && prev.at && S.at < prev.at && S.state === prev.state) continue
          // a game never goes back to "not started"
          if (prev && order(S.state) < order(prev.state)) continue
          if (prev && prev.state === 'pre' && S.state !== 'pre' && !d.close[key]) {
            d.close[key] = { t, line: prev.line, price: prev.price }
            const clv = clvOf(P, d.close[key])
            push(key, [{ t, kind: 'close', text: closeText(P, d.close[key], clv), dir: clv ? (clv.value > 0 ? 'up' : clv.value < 0 ? 'down' : null) : null }])
          }
          // the game's on (or done): the close is the story now, so line chatter stops
          if (S.state === 'pre') push(key, changes(P, prev || { ...S, inj: P.inj, inPicks: true }, S, t))
          if (!sameState(prev, S)) {
            d.last[key] = S
            dirty = true
          }
        }
        if (t - (d.snapAt || 0) >= SNAP_EVERY && Object.keys(d.posted).length) {
          d.snaps = [...(d.snaps || []), { at: t, items: itemsOf(d).map(trimForSnap) }].slice(-SNAPS_KEPT)
          d.snapAt = t
          dirty = true
        }
        if (!dirty) return undefined
        d.updatedAt = t
        return d
      })
      mem = doc
      stats.ticks++
      if (changed) {
        stats.changes += changed
        engine.hub?.publish('ticker', 'update', { sport, at: t, items: itemsOf(doc) })
      }
      return { changed, picks: Object.keys(doc?.posted || {}).length }
    })()
      .catch((e) => {
        stats.error = String(e?.message || e)
        return { error: stats.error }
      })
      .finally(() => {
        busy = null
      })
    return busy
  }

  const subscribed = () => Boolean(engine.hub?.hasSubscribers?.('ticker'))
  /** Due for another look: every 30 s while someone's watching live, else every 3 minutes. */
  const due = () => now() - lastTick > (subscribed() ? 30_000 : 3 * MIN)

  async function read() {
    const d = await store.get(NS, 'state')
    if (d) mem = d
    return mem
  }

  /** The live list (members). Takes a fresh look first when the last one is stale. */
  async function live({ budgetMs = 4000 } = {}) {
    if (due()) {
      let timer
      await Promise.race([tick(), new Promise((r) => (timer = setTimeout(r, budgetMs)))])
      clearTimeout(timer)
    }
    const d = mem || (await read())
    return { sport, live: true, locked: false, at: d?.updatedAt || null, items: itemsOf(d) }
  }

  /** What a free visitor gets: the newest snapshot at least 30 minutes old, and how many are live. */
  async function delayed() {
    const d = mem && now() - (mem.updatedAt || 0) < 5 * MIN ? mem : (await read()) || mem
    const t = now()
    const snap = [...(d?.snaps || [])].reverse().find((s) => t - s.at >= DELAY_MS) || null
    return { sport, live: false, locked: true, delayMin: DELAY_MS / MIN, at: snap?.at || null, items: snap ? snap.items.slice(0, 12) : [], count: d?.posted ? Object.keys(d.posted).length : 0 }
  }

  /** The current list for a stream that just opened (members only; the route checks). */
  const initial = () => (mem ? { sport, at: mem.updatedAt || null, items: itemsOf(mem) } : null)

  return { tick, due, live, delayed, initial, stats: () => ({ ...stats, lastTick, picks: mem?.posted ? Object.keys(mem.posted).length : 0 }) }
}

const order = (s) => (s === 'post' ? 2 : s === 'in' ? 1 : 0)

function closeText(P, C, clv) {
  const at = `${C.line != null ? fmtLine(C.line) : '—'}${C.price != null ? ` (${fmtOdds(C.price)})` : ''}`
  if (!clv) return `Closed at ${at}`
  if (clv.kind === 'line') return clv.value > 0 ? `Closed at ${at}: beat the close by ${fmtLine(clv.value)}` : clv.value < 0 ? `Closed at ${at}: the line moved ${fmtLine(-clv.value)} against it` : `Closed at ${at}`
  const pts = Math.round(clv.value * 1000) / 10
  return pts > 0 ? `Closed at ${at}: beat the close by ${pts} pts` : pts < 0 ? `Closed at ${at}: the price moved ${-pts} pts against it` : `Closed at ${at}`
}

/** Snapshots keep only what the delayed view shows. */
function trimForSnap(it) {
  return { key: it.key, id: it.id, sport: it.sport, name: it.name, short: it.short, teamAbbr: it.teamAbbr, label: it.label, shortLabel: it.shortLabel, side: it.side, posted: { line: it.posted.line, price: it.posted.price }, now: it.now ? { line: it.now.line, price: it.now.price } : null, moved: it.moved, dir: it.dir, status: it.status, statusLabel: it.statusLabel, why: it.why, at: it.at, events: it.events.slice(0, 1) }
}

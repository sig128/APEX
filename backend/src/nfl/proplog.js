// The prop log: what the board backed on every line before each game, and how it came out.
// It is the record the admin page reads to see where the model makes money and where it
// leaks: hit rate against the probability it gave, and units at the prices that were there.
//
// One document per league per game day (US Eastern): the board's side on every main line
// (the side it gives at least 50%), with its probability, the book's price and the best
// price seen, the edge over the no-vig price, the score, the read and the matchup. Rows keep
// moving until their game starts (the last pre-game look is what gets graded) and keep the
// first price seen, so line moves can be measured. After the games, rows are graded from the
// box score (or the game log when the box leaves a player out), and the day is folded into a
// monthly summary: per day, per series and per segment. The raw day stays for drill-downs.
import { MARKETS } from './markets.js'
import { outcome, parsePropId } from './analytics/core.js'
import { tierOf } from './analytics/notes.js'
import { americanToDecimal, americanToProb } from '../lib/odds.js'
import { log, errText } from '../lib/log.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const MAX_ROWS = 3500 // per league per day (the busiest NFL Sunday is about half that)
const RECORD_EVERY = 10 * MIN
const GRADE_EVERY = 15 * MIN
const VOID_AFTER = 36 * HOUR // a player with no box line and no log row this long after the game didn't play
const KEEP_DAYS = 120 // days the grader still looks at

/** Row layout (arrays keep a busy day well under the store's document size). */
export const COLS = ['id', 'game', 'p', 'price', 'best', 'book', 'edge', 'score', 'lean', 'mu', 'home', 'p0', 'price0', 'line0', 't0', 't1', 'res', 'val']
const C = Object.fromEntries(COLS.map((k, i) => [k, i]))
export const rowObj = (a) => Object.fromEntries(COLS.map((k, i) => [k, a[i] ?? null]))

const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null)
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0)

/** YYYY-MM-DD in US Eastern (the day ESPN files a game under). */
export function dayET(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
  const get = (t) => parts.find((p) => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

const sideKey = (r) => (r.oneSided ? 'yes' : r.side === 'u' ? 'under' : 'over')
const leanCode = (l) => (l === 'for' ? 'f' : l === 'against' ? 'a' : l === 'mixed' ? 'm' : null)

/** Does tonight's matchup help this side: h(elps), x (hurts), n(eutral), or null when unknown. */
function matchupCode(r) {
  const m = r.matchup
  if (!m || !(m.games >= 3) || !Number.isFinite(m.rank) || !m.of) return null
  const tier = tierOf(m.rank, m.of)
  if (tier === 'mid') return 'n'
  const soft = tier === 'soft'
  return (r.side === 'u') !== soft ? 'h' : 'x'
}

/** The compact row for one board row, carrying the first look forward from `prev`. */
export function logRow(r, gameId, t, prev = null) {
  const key = sideKey(r)
  const price = Number.isFinite(r.price?.[key]) ? r.price[key] : null
  const best = r.price?.best?.[key]
  const bestPrice = Number.isFinite(best?.price) ? best.price : price
  const row = []
  row[C.id] = r.id
  row[C.game] = String(gameId)
  row[C.p] = r3(r.prob)
  row[C.price] = price
  row[C.best] = bestPrice
  row[C.book] = (Number.isFinite(best?.price) ? best.book : r.price?.book) || null
  row[C.edge] = Number.isFinite(r.edge) && r.price ? r3(r.edge) : null
  row[C.score] = Number.isFinite(r.rank ?? r.score) ? Math.round(r.rank ?? r.score) : null
  row[C.lean] = leanCode(r.read?.lean)
  row[C.mu] = matchupCode(r)
  row[C.home] = r.home === true ? 1 : r.home === false ? 0 : null
  row[C.p0] = prev ? prev[C.p0] : row[C.p]
  row[C.price0] = prev ? prev[C.price0] : bestPrice
  row[C.line0] = prev ? prev[C.line0] : r.line
  row[C.t0] = prev ? prev[C.t0] : t
  row[C.t1] = t
  row[C.res] = null
  row[C.val] = null
  return row
}

const rowKey = (r, gameId) => `${gameId}:${r.kind === 'team' || r.teamId && !r.playerId ? `t${r.teamId}` : r.playerId}:${r.market}`

// ---- grading and summaries -------------------------------------------------------------------

/** The stat a row was about, from the final box score or the player's game log. */
export function valueFor(row, summary, logRows = null) {
  const id = parsePropId(row[C.id])
  if (!id) return { void: true }
  if (id.teamId) {
    const t = summary.home?.id === id.teamId ? summary.home : summary.away?.id === id.teamId ? summary.away : null
    return t && Number.isFinite(Number(t.score)) ? { v: Number(t.score) } : null
  }
  const mk = MARKETS[id.market]
  if (!mk) return { void: true }
  const box = summary.players?.[id.playerId]?.stats
  if (box && (!mk.keys || mk.keys.some((k) => box[k] != null))) return { v: mk.stat(box) }
  const lr = logRows?.find((x) => String(x.eventId) === String(row[C.game]))
  if (lr) return { v: mk.stat(lr.s || {}) }
  return null
}

export function resultOf(row, v) {
  const id = parsePropId(row[C.id])
  const o = id ? outcome(v, id.line, id.side) : null
  return o === 'hit' ? 'w' : o === 'miss' ? 'l' : o === 'push' ? 'p' : 'v'
}

/** Accumulator: n, wins, losses, pushes, units, risked, sum of squared profits, sum of the
 * probabilities given, sum and count of break-even rates, sum and count of line moves. */
export const ACC = ['n', 'w', 'l', 'p', 'u', 'r', 'sq', 'sp', 'si', 'ni', 'cv', 'nc']
const newAcc = () => ACC.map(() => 0)
export function addTo(acc, row) {
  const res = row[C.res]
  if (res !== 'w' && res !== 'l' && res !== 'p') return acc
  acc[0]++
  if (res === 'w') acc[1]++
  else if (res === 'l') acc[2]++
  else acc[3]++
  const price = Number.isFinite(row[C.best]) ? row[C.best] : row[C.price]
  if (Number.isFinite(price)) {
    const dec = americanToDecimal(price)
    const profit = res === 'w' ? dec - 1 : res === 'l' ? -1 : 0
    acc[4] += profit
    acc[5]++
    acc[6] += profit * profit
    if (res !== 'p') {
      acc[8] += americanToProb(price)
      acc[9]++
    }
  }
  if (res !== 'p' && Number.isFinite(row[C.p])) acc[7] += row[C.p]
  const id = parsePropId(row[C.id])
  if (id && Number.isFinite(row[C.price0]) && Number.isFinite(price) && row[C.line0] === id.line) {
    acc[10] += americanToProb(price) - americanToProb(row[C.price0])
    acc[11]++
  }
  return acc
}
export const sumAcc = (a, b) => a.map((x, i) => x + (b?.[i] || 0))
const roundAcc = (a) => a.map((x, i) => (i <= 3 || i === 5 || i === 9 || i === 11 ? x : r3(x)))

function probBucket(p) {
  if (!Number.isFinite(p)) return null
  return String(Math.min(85, Math.max(50, Math.floor((p * 100) / 5) * 5)))
}
function edgeBucket(e) {
  if (!Number.isFinite(e)) return 'none'
  const pts = e * 100
  return pts < 0 ? 'neg' : pts < 2 ? '0' : pts < 4 ? '2' : pts < 6 ? '4' : '6'
}
function priceBucket(a) {
  if (!Number.isFinite(a)) return 'none'
  return a <= -200 ? 'fav2' : a <= -131 ? 'fav' : a <= 110 ? 'even' : a <= 200 ? 'dog' : 'long'
}
function scoreBucket(s) {
  if (!Number.isFinite(s)) return null
  return s >= 90 ? '90' : s >= 80 ? '80' : s >= 70 ? '70' : s >= 60 ? '60' : '0'
}

/** Every segment a graded row belongs to. */
export function segmentsOf(row) {
  const id = parsePropId(row[C.id])
  if (!id) return []
  const mk = MARKETS[id.market]
  const out = [`m:${id.market}`, `s:${mk?.oneSided ? 'y' : id.side}`, `eb:${edgeBucket(row[C.edge])}`, `ld:${row[C.lean] || 'n'}`, `mu:${row[C.mu] || 'n'}`, `pr:${priceBucket(Number.isFinite(row[C.best]) ? row[C.best] : row[C.price])}`, `bk:${row[C.book] || 'none'}`]
  const pb = probBucket(row[C.p])
  if (pb) out.push(`pb:${pb}`)
  const sb = scoreBucket(row[C.score])
  if (sb) out.push(`sc:${sb}`)
  if (row[C.home] === 0 || row[C.home] === 1) out.push(`h:${row[C.home]}`)
  const price = Number.isFinite(row[C.best]) ? row[C.best] : row[C.price]
  if (Number.isFinite(row[C.price0]) && Number.isFinite(price) && row[C.line0] === id.line) {
    const mv = americanToProb(price) - americanToProb(row[C.price0])
    out.push(`cl:${mv > 0.005 ? 'with' : mv < -0.005 ? 'against' : 'flat'}`)
  }
  return out
}

/** A graded day in numbers: every lean, the top 10 by score, edge 3+ at a real price, and segments. */
export function summarizeDay(doc) {
  const rows = Object.values(doc.rows || {})
  const graded = rows.filter((r) => r[C.res] === 'w' || r[C.res] === 'l' || r[C.res] === 'p')
  const all = newAcc()
  const seg = {}
  for (const r of graded) {
    addTo(all, r)
    for (const k of segmentsOf(r)) addTo((seg[k] ||= newAcc()), r)
  }
  const top = newAcc()
  for (const r of [...graded].sort((a, b) => (b[C.score] ?? 0) - (a[C.score] ?? 0) || (b[C.p] ?? 0) - (a[C.p] ?? 0)).slice(0, 10)) addTo(top, r)
  const edge = newAcc()
  for (const r of graded) if (Number.isFinite(r[C.edge]) && r[C.edge] >= 0.03) addTo(edge, r)
  return {
    rows: rows.length,
    voids: rows.filter((r) => r[C.res] === 'v').length,
    all: roundAcc(all),
    top: roundAcc(top),
    edge: roundAcc(edge),
    seg: Object.fromEntries(Object.entries(seg).map(([k, a]) => [k, roundAcc(a)])),
  }
}

// ---- the log ---------------------------------------------------------------------------------

export function createPropLog({ engine, store, now = () => Date.now() }) {
  const sport = engine.sport?.key || 'nfl'
  const NS = `proplog-${sport}`
  const SUM = `propsum-${sport}`
  let lastRecord = 0
  let lastVersion = null
  let lastGrade = 0
  let busy = null
  const stats = { recorded: 0, graded: 0, days: 0, error: null }

  // the index: every day on file, and the ones still waiting on results (the grader reads only those)
  const readIndex = async () => {
    const v = await store.get(NS, 'index')
    return { all: Array.isArray(v?.all) ? v.all : [], open: Array.isArray(v?.open) ? v.open : [] }
  }
  async function addToIndex(days) {
    await store.update(NS, 'index', (v) => {
      const all = Array.isArray(v?.all) ? v.all : []
      const open = Array.isArray(v?.open) ? v.open : []
      const nextAll = [...new Set([...all, ...days])].sort().slice(-400)
      const nextOpen = [...new Set([...open, ...days])].sort().slice(-KEEP_DAYS)
      const same = (a, b) => a.length === b.length && a.every((d, i) => d === b[i])
      return same(nextAll, all) && same(nextOpen, open) ? undefined : { all: nextAll, open: nextOpen }
    })
  }
  async function closeDay(day) {
    await store.update(NS, 'index', (v) => (v?.open?.includes(day) ? { ...v, open: v.open.filter((d) => d !== day) } : undefined))
  }

  /** Save the board's current side on every line whose game hasn't started. */
  async function record() {
    if (!store || !engine.views) return { skipped: true }
    const t = now()
    const { rows } = engine.views.allRows()
    const byDay = new Map()
    for (const r of rows) {
      const g = engine.wh.games.get(String(r.gameId))
      if (!g || g.status?.state !== 'pre') continue
      const ko = Date.parse(g.date)
      if (!Number.isFinite(ko) || ko <= t || ko - t > 4 * DAY) continue
      if (!Number.isFinite(r.prob) || r.prob <= 0 || r.prob >= 1) continue
      const day = dayET(ko)
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push({ r, g, ko })
    }
    let n = 0
    for (const [day, list] of byDay) {
      await store.update(NS, day, (cur) => {
        const doc = cur || { v: 1, sport, day, createdAt: t, games: {}, pl: {}, rows: {}, done: false }
        if (doc.done) return undefined
        for (const { r, g, ko } of list) {
          const key = rowKey(r, g.id)
          doc.rows[key] = logRow(r, g.id, t, doc.rows[key] || null)
          doc.games[g.id] = { k: ko, n: g.shortName || null }
          if (r.playerId) doc.pl[r.playerId] = [r.short || r.name || '', r.teamAbbr || '', r.oppAbbr || '', r.pos || '']
          else if (r.teamId) doc.pl[`t${r.teamId}`] = [r.name || r.teamAbbr || '', r.teamAbbr || '', r.oppAbbr || '', 'team']
          n++
        }
        const keys = Object.keys(doc.rows)
        if (keys.length > MAX_ROWS) {
          // keep the strongest leans when a day runs long
          const keep = new Set(keys.sort((a, b) => (doc.rows[b][C.score] ?? 0) - (doc.rows[a][C.score] ?? 0)).slice(0, MAX_ROWS))
          for (const k of keys) if (!keep.has(k)) delete doc.rows[k]
        }
        doc.updatedAt = t
        return doc
      })
    }
    if (byDay.size) await addToIndex([...byDay.keys()])
    stats.recorded += n
    return { rows: n, days: [...byDay.keys()] }
  }

  async function summaryFor(gameId) {
    const s = engine.wh.summaries.get(String(gameId))?.data
    if (s?.status?.state === 'post' || !engine.espn?.summary) return s || null
    try {
      return await engine.espn.summary(gameId, { priority: 'background' })
    } catch (e) {
      log.warn('proplog summary failed', { sport, gameId, err: errText(e) })
      return s || null
    }
  }

  /** Grade rows whose games are final; fold finished days into the monthly summary. */
  async function grade({ maxLogFetches = 30 } = {}) {
    if (!store) return { skipped: true }
    const t = now()
    const today = dayET(t)
    const days = (await readIndex()).open.filter((d) => d <= today)
    let gradedRows = 0
    let folded = 0
    let fetches = 0
    const logCache = new Map()
    async function logsOf(playerId, season) {
      const k = `${playerId}:${season}`
      if (logCache.has(k)) return logCache.get(k)
      let rows = engine.wh.logs.get(String(playerId)) || null
      if (fetches < maxLogFetches && engine.espn?.gamelog) {
        fetches++
        try {
          rows = await engine.espn.gamelog(playerId, season, { priority: 'background' })
        } catch {
          /* keep the warehouse copy */
        }
      }
      logCache.set(k, rows)
      return rows
    }
    for (const day of days) {
      const doc = await store.get(NS, day)
      if (!doc || doc.done) {
        await closeDay(day)
        continue
      }
      const updates = {}
      const gameState = {}
      for (const [gid, g] of Object.entries(doc.games || {})) {
        if (!(g.k + 2.5 * HOUR < t)) continue
        const pending = Object.entries(doc.rows).filter(([, r]) => r[C.game] === gid && !r[C.res])
        if (!pending.length) continue
        const s = await summaryFor(gid)
        if (s?.status?.state !== 'post') {
          // postponed or never finished: after three days, nothing on it counts
          if (t - g.k > 3 * DAY) for (const [k] of pending) updates[k] = ['v', null]
          continue
        }
        gameState[gid] = 'post'
        const season = engine.wh.season || new Date(g.k).getUTCFullYear()
        for (const [k, r] of pending) {
          let got = valueFor(r, s)
          if (!got) {
            const id = parsePropId(r[C.id])
            if (id?.playerId) got = valueFor(r, s, await logsOf(id.playerId, season))
          }
          if (got?.void) updates[k] = ['v', null]
          else if (got) updates[k] = [resultOf(r, got.v), got.v]
          else if (t - g.k > VOID_AFTER) updates[k] = ['v', null]
        }
      }
      const n = Object.keys(updates).length
      if (!n && !Object.values(doc.rows).every((r) => r[C.res])) continue
      let finished = null
      await store.update(NS, day, (cur) => {
        if (!cur || cur.done) return undefined
        for (const [k, [res, val]] of Object.entries(updates)) {
          const r = cur.rows[k]
          if (!r || r[C.res]) continue
          r[C.res] = res
          r[C.val] = val
        }
        const allDone = Object.values(cur.rows).every((r) => r[C.res])
        if (allDone) {
          cur.done = true
          cur.gradedAt = t
          finished = cur
        }
        return cur
      })
      gradedRows += n
      if (finished) {
        const sum = summarizeDay(finished)
        await store.update(SUM, day.slice(0, 7), (cur) => ({ ...(cur || {}), days: { ...(cur?.days || {}), [day]: { ...sum, at: t } } }))
        await closeDay(day)
        folded++
      }
    }
    stats.graded += gradedRows
    stats.days += folded
    return { rows: gradedRows, days: folded }
  }

  /** Record (every 10 minutes, when the board moved) and grade (every 15); never two at once. */
  function maybeTick({ force = false } = {}) {
    if (busy) return busy
    const t = now()
    const doRecord = force || (t - lastRecord > RECORD_EVERY && engine.wh.aVersion !== lastVersion)
    const doGrade = force || t - lastGrade > GRADE_EVERY
    if (!doRecord && !doGrade) return Promise.resolve({ skipped: true })
    busy = (async () => {
      const out = {}
      try {
        if (doRecord) {
          lastRecord = t
          lastVersion = engine.wh.aVersion
          out.record = await record()
        }
        if (doGrade) {
          lastGrade = t
          out.grade = await grade()
        }
        stats.error = null
      } catch (e) {
        stats.error = errText(e)
        log.warn('proplog tick failed', { sport, err: errText(e) })
        out.error = true
      } finally {
        busy = null
      }
      return out
    })()
    return busy
  }

  /** Monthly summaries for these months (YYYY-MM), as { day: summary }. */
  async function summaries(months) {
    if (!store) return {}
    const docs = await Promise.all(months.map((m) => store.get(SUM, m)))
    return Object.assign({}, ...docs.map((d) => d?.days || {}))
  }

  /** One day as readable rows, for drill-downs. */
  async function day(key) {
    if (!store) return null
    const doc = await store.get(NS, key)
    if (!doc) return null
    const rows = Object.values(doc.rows).map((a) => {
      const r = rowObj(a)
      const id = parsePropId(r.id)
      const subject = id?.playerId || (id?.teamId ? `t${id.teamId}` : null)
      const pl = doc.pl?.[subject] || []
      const mk = MARKETS[id?.market] || {}
      return { ...r, name: pl[0] || null, team: pl[1] || null, opp: pl[2] || null, pos: pl[3] || null, market: id?.market || null, marketLabel: mk.label || id?.market || null, side: mk.oneSided ? 'y' : id?.side || null, line: id?.line ?? null, kickoff: doc.games?.[r.game]?.k || null, game: doc.games?.[r.game]?.n || null }
    })
    return { sport, day: key, done: Boolean(doc.done), gradedAt: doc.gradedAt || null, rows }
  }

  return { record, grade, maybeTick, summaries, day, index: readIndex, status: () => ({ ...stats, lastRecord: lastRecord || null, lastGrade: lastGrade || null }) }
}

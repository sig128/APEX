// The season ledger for the 3-Leg Lock: one entry per NFL week, the lock as it stood when its
// first leg kicked off (or a Pass), graded from the box scores like any user pick. Wins, losses
// and passes all stay on the record.
import { gradeLeg } from '../picks/service.js'
import { americanToDecimal } from '../lib/odds.js'
import { round } from '../lib/util.js'
import { log, errText } from '../lib/log.js'

const NS = 'locks'
const HOUR = 3_600_000
const keyOf = (season, week) => `${season}-w${String(week).padStart(2, '0')}`

function frozenLeg(l) {
  return {
    id: l.id,
    kind: l.kind,
    playerId: l.playerId,
    teamId: l.kind === 'team' ? l.teamId : null,
    gameId: l.gameId,
    kickoff: Date.parse(l.kickoff) || null,
    name: l.name,
    short: l.short,
    headshot: l.headshot || null,
    teamAbbr: l.teamAbbr,
    oppAbbr: l.oppAbbr,
    market: l.market,
    label: l.label,
    line: l.line,
    side: l.side,
    prob: l.prob,
    price: l.price ?? null,
  }
}

/** One week's line: W/L/P, and units at the staked share (1 unit = 1% of bankroll) when priced. */
export function settleLock(entry, results) {
  const legs = entry.lock.legs.map((l, i) => ({ ...l, ...(results[i] || {}) }))
  if (legs.some((l) => !l.result)) return null
  const live = legs.filter((l) => l.result !== 'void' && l.result !== 'push')
  const result = legs.some((l) => l.result === 'loss') ? 'loss' : live.length ? 'win' : 'push'
  const units = round((entry.lock.stake?.pct ?? 0.02) * 100, 2)
  const priced = live.every((l) => Number.isFinite(l.price))
  const dec = priced ? live.reduce((d, l) => d * americanToDecimal(l.price), 1) : null
  const profit = !priced ? null : result === 'win' ? round(units * (dec - 1), 2) : result === 'loss' ? -units : 0
  return { legs, result, units, profit, decimal: dec == null ? null : round(dec, 3) }
}

export function createLedger({ engine, store, now = () => Date.now() }) {
  let ticking = null
  let lastTick = 0

  /** Save this week's current lock (or Pass) until the lock's first leg kicks off. */
  async function record(out) {
    if (!store || !out?.season || !out?.week || !out.funnel?.scanned) return
    const k = keyOf(out.season, out.week)
    const t = now()
    await store.update(NS, k, (cur) => {
      if (cur?.frozen) return undefined
      const base = { key: k, season: out.season, week: out.week, updatedAt: t, firstAt: cur?.firstAt || t }
      if (out.status === 'pass' || !out.lock) return { ...base, status: 'pass', reason: out.reason, near: out.near || null, lock: null }
      const lock = { id: out.lock.id, legs: out.lock.legs.map(frozenLeg), independent: out.lock.independent, simulated: out.lock.simulated, price: out.lock.price, breakEven: out.lock.breakEven, stake: out.lock.stake }
      if (cur?.lock?.id === lock.id && cur.status === 'open') return { ...cur, updatedAt: t, lock: { ...lock } }
      return { ...base, status: 'open', certified: out.status === 'certified', lock }
    })
    await store.update(NS, 'index', (list) => (Array.isArray(list) && list.includes(k) ? undefined : [...(Array.isArray(list) ? list : []), k].sort()))
  }

  async function summaryFor(gameId) {
    const s = engine.wh.summaries.get(gameId)?.data
    if (s?.status?.state === 'post' || !engine.espn?.summary) return s || null
    try {
      return await engine.espn.summary(gameId, { priority: 'background' })
    } catch (e) {
      log.warn('ledger summary failed', { gameId, err: errText(e) })
      return s || null
    }
  }

  /** Freeze locks whose first leg kicked off, close out Pass weeks, grade finished locks. */
  async function tick() {
    if (!store) return { skipped: true }
    const t = now()
    const keys = (await store.get(NS, 'index')) || []
    let changed = 0
    for (const k of keys) {
      const e = await store.get(NS, k)
      if (!e || e.status === 'graded') continue
      if (!e.frozen) {
        const pastWeek = e.season !== engine.wh.season || e.week !== engine.wh.week
        const started = e.lock?.legs?.some((l) => l.kickoff && l.kickoff <= t)
        const weekDone = !e.lock && (pastWeek || [...engine.wh.games.values()].every((g) => g.status?.state !== 'pre'))
        if (started || weekDone || (pastWeek && e.lock)) {
          await store.update(NS, k, (cur) => (cur && !cur.frozen ? { ...cur, frozen: true, frozenAt: t, status: cur.lock ? 'live' : 'pass' } : undefined))
          changed++
        }
        continue
      }
      if (e.status !== 'live' || !e.lock) continue
      const results = []
      for (const leg of e.lock.legs) {
        if (leg.result) {
          results.push({ result: leg.result, value: leg.value })
          continue
        }
        const s = await summaryFor(leg.gameId)
        const logRow = leg.playerId ? (engine.wh.logs.get(leg.playerId) || []).find((r) => r.eventId === leg.gameId) || null : null
        results.push(gradeLeg(leg, s, { finalAt: (leg.kickoff || t) + 3.5 * HOUR, now: t, logRow }))
      }
      const done = settleLock(e, results)
      await store.update(NS, k, (cur) => {
        if (!cur || cur.status !== 'live') return undefined
        if (!done) {
          const legs = cur.lock.legs.map((l, i) => (results[i] ? { ...l, result: results[i].result, value: results[i].value } : l))
          return legs.some((l, i) => l.result !== cur.lock.legs[i].result) ? { ...cur, lock: { ...cur.lock, legs } } : undefined
        }
        return { ...cur, status: 'graded', gradedAt: t, result: done.result, units: done.units, profit: done.profit, decimal: done.decimal, lock: { ...cur.lock, legs: done.legs } }
      })
      changed++
    }
    return { changed }
  }

  /** At most every two minutes; callers don't wait on each other. */
  function maybeTick() {
    if (ticking) return ticking
    if (now() - lastTick < 120_000) return Promise.resolve({ skipped: true })
    ticking = tick()
      .catch((e) => {
        log.warn('ledger tick failed', { err: errText(e) })
        return { error: true }
      })
      .finally(() => {
        ticking = null
        lastTick = now()
      })
    return ticking
  }

  /** The season so far: every week, newest first, and the running record. */
  async function season(year = engine.wh.season) {
    if (!store) return { season: year, weeks: [], record: emptyRecord() }
    const keys = ((await store.get(NS, 'index')) || []).filter((k) => k.startsWith(`${year}-`))
    const weeks = (await Promise.all(keys.map((k) => store.get(NS, k)))).filter(Boolean).sort((a, b) => b.week - a.week)
    const r = emptyRecord()
    for (const w of weeks) {
      if (w.status === 'pass' && w.frozen) r.passes++
      if (w.status !== 'graded') continue
      if (w.result === 'win') r.wins++
      else if (w.result === 'loss') r.losses++
      else r.pushes++
      if (w.profit != null) {
        r.units = round(r.units + w.profit, 2)
        r.risked = round(r.risked + w.units, 2)
      }
    }
    r.roi = r.risked ? round(r.units / r.risked, 4) : null
    return { season: year, weeks, record: r }
  }

  return { record, tick, maybeTick, season, keyOf }
}

const emptyRecord = () => ({ wins: 0, losses: 0, pushes: 0, passes: 0, units: 0, risked: 0, roi: null })

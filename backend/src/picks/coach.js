// The betting coach: patterns in someone's own graded picks that cost them, each with its
// numbers and the picks behind it. A pattern is only shown when every group it compares has
// enough graded picks (THRESHOLD wins and losses); below that it says nothing.
import { MARKETS } from '../nfl/markets.js'
import { round } from '../lib/util.js'

export const THRESHOLD = 10
const GAP = 0.1 // ten points of ROI before two groups are called different
const DAY_MS = 86_400_000

const isDecided = (p) => p.status === 'graded' && (p.result === 'win' || p.result === 'loss')

function group() {
  return { n: 0, wins: 0, losses: 0, units: 0, risked: 0, stake: 0, ids: [] }
}
function add(g, p) {
  g.n++
  if (p.result === 'win') g.wins++
  else g.losses++
  g.units += p.profit || 0
  g.risked += p.units || 0
  g.stake += p.units || 0
  g.ids.push(p.id)
}
function view(g) {
  return { n: g.n, wins: g.wins, losses: g.losses, units: round(g.units, 2), roi: g.risked ? round(g.units / g.risked, 4) : null, avgStake: g.n ? round(g.stake / g.n, 2) : null }
}

const sign = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`
const pct = (x) => `${sign(x * 100, 0)}%`
const unitsText = (x) => `${sign(x, 1)} units`
const picksText = (n) => `${n} pick${n === 1 ? '' : 's'}`

function hourIn(ts, tz) {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ts))
    return Number(h) % 24
  } catch {
    return new Date(ts).getUTCHours()
  }
}

const legLabel = (n) => (n === 1 ? 'singles' : n >= 5 ? '5+ leg parlays' : `${n}-leg parlays`)
const marketName = (k) => MARKETS[k]?.label || k
const sportOfPick = (p) => {
  const s = new Set(p.legs.map((l) => l.sport || 'nfl'))
  return s.size === 1 ? [...s][0] : 'mixed'
}

/** Groups keyed by name, from the decided picks. */
function groupBy(picks, keyOf) {
  const m = new Map()
  for (const p of picks) {
    const k = keyOf(p)
    if (k == null) continue
    if (!m.has(k)) m.set(k, group())
    add(m.get(k), p)
  }
  return m
}

/** Best and worst groups that both clear the threshold, when they differ by GAP or more. */
function spread(m) {
  const ok = [...m.entries()].filter(([, g]) => g.n >= THRESHOLD && g.risked > 0)
  if (ok.length < 2) return null
  ok.sort((a, b) => b[1].units / b[1].risked - a[1].units / a[1].risked)
  const [bk, best] = ok[0]
  const [wk, worst] = ok[ok.length - 1]
  const gap = best.units / best.risked - worst.units / worst.risked
  return gap >= GAP ? { bk, best, wk, worst, gap } : null
}

/**
 * Insights from someone's picks (any status; only decided ones count).
 * tz: the person's time zone when a pick didn't record its own.
 */
export function coach(picks, { now = Date.now(), tz = 'America/New_York' } = {}) {
  const all = (picks || []).filter((p) => Array.isArray(p.legs) && p.legs.length)
  const decided = all.filter(isDecided).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  const insights = []

  // 1. how many legs
  const byLegs = groupBy(decided, (p) => Math.min(5, p.legs.length))
  const s1 = spread(byLegs)
  if (s1) {
    const w = view(s1.worst)
    const b = view(s1.best)
    insights.push({
      id: 'legs',
      tone: 'warn',
      title: 'Number of legs',
      text: `Your ${legLabel(s1.wk)} are at ${pct(w.roi)} ROI (${unitsText(w.units)}) over ${picksText(w.n)}. Your ${legLabel(s1.bk)} are at ${pct(b.roi)} (${unitsText(b.units)}) over ${picksText(b.n)}.`,
      groups: [{ name: legLabel(s1.wk), ...w }, { name: legLabel(s1.bk), ...b }],
      picks: s1.worst.ids,
    })
  }

  // 2. sport
  const s2 = spread(groupBy(decided, sportOfPick))
  if (s2) {
    const w = view(s2.worst)
    const b = view(s2.best)
    const nm = (k) => (k === 'mixed' ? 'mixed-league parlays' : k.toUpperCase())
    insights.push({
      id: 'sport',
      tone: 'warn',
      title: 'League',
      text: `You're ${unitsText(b.units)} on ${nm(s2.bk)} (${pct(b.roi)} ROI over ${picksText(b.n)}) but ${unitsText(w.units)} on ${nm(s2.wk)} (${pct(w.roi)} over ${picksText(w.n)}).`,
      groups: [{ name: nm(s2.wk), ...w }, { name: nm(s2.bk), ...b }],
      picks: s2.worst.ids,
    })
  }

  // 3. bet type (singles only: a parlay's result can't be pinned on one market)
  const s3 = spread(groupBy(decided.filter((p) => p.legs.length === 1), (p) => p.legs[0].market))
  if (s3) {
    const w = view(s3.worst)
    const b = view(s3.best)
    insights.push({
      id: 'market',
      tone: 'warn',
      title: 'Bet type',
      text: `Single ${marketName(s3.wk).toLowerCase()} picks are at ${pct(w.roi)} ROI (${unitsText(w.units)}) over ${picksText(w.n)}, against ${pct(b.roi)} on ${marketName(s3.bk).toLowerCase()} over ${picksText(b.n)}.`,
      groups: [{ name: marketName(s3.wk), ...w }, { name: marketName(s3.bk), ...b }],
      picks: s3.worst.ids,
    })
  }

  // 4. stake right after a loss vs right after a win
  const afterLoss = group()
  const afterWin = group()
  const graded = decided.slice().sort((a, b) => (a.gradedAt || 0) - (b.gradedAt || 0))
  for (const p of decided) {
    let last = null
    for (const q of graded) {
      if ((q.gradedAt || 0) >= (p.createdAt || 0)) break
      last = q
    }
    if (!last) continue
    add(last.result === 'loss' ? afterLoss : afterWin, p)
  }
  if (afterLoss.n >= THRESHOLD && afterWin.n >= THRESHOLD) {
    const l = view(afterLoss)
    const w = view(afterWin)
    if (w.avgStake > 0 && l.avgStake / w.avgStake >= 1.25) {
      insights.push({
        id: 'chase',
        tone: 'warn',
        title: 'Stakes after a loss',
        text: `After a loss your stake goes up to ${l.avgStake} units on average, from ${w.avgStake} after a win (${round(l.avgStake / w.avgStake, 1)}×). Those ${picksText(l.n)} are at ${pct(l.roi)} ROI (${unitsText(l.units)}).`,
        groups: [{ name: 'After a loss', ...l }, { name: 'After a win', ...w }],
        picks: afterLoss.ids,
      })
    }
  }

  // 5. late at night
  const late = group()
  const day = group()
  for (const p of decided) {
    const h = hourIn(p.createdAt || 0, p.tz || tz)
    add(h < 5 ? late : day, p)
  }
  if (late.n >= THRESHOLD && day.n >= THRESHOLD) {
    const l = view(late)
    const d = view(day)
    if (l.roi != null && d.roi != null && d.roi - l.roi >= GAP) {
      insights.push({
        id: 'late',
        tone: 'warn',
        title: 'Late-night picks',
        text: `Picks you make between midnight and 5 am are at ${pct(l.roi)} ROI (${unitsText(l.units)}) over ${picksText(l.n)}, against ${pct(d.roi)} the rest of the day.`,
        groups: [{ name: 'Midnight to 5 am', ...l }, { name: 'Rest of the day', ...d }],
        picks: late.ids,
      })
    }
  }

  // 6. prices against the close
  const withClv = decided.filter((p) => Number.isFinite(p.clv))
  if (withClv.length >= THRESHOLD) {
    const avg = withClv.reduce((s, p) => s + p.clv, 0) / withClv.length
    const beat = withClv.filter((p) => p.clv > 0).length
    insights.push({
      id: 'clv',
      tone: avg >= 0 ? 'good' : 'warn',
      title: 'Prices against the close',
      text: avg >= 0
        ? `Your prices beat the closing price by ${pct(avg).replace('+', '')} on average over ${picksText(withClv.length)} (${beat} of them beat it). That's the best sign a record isn't just luck.`
        : `Your prices trail the closing price by ${pct(-avg).replace('+', '')} on average over ${picksText(withClv.length)}. Getting in earlier or shopping for a better price would help.`,
      groups: [{ name: 'Average CLV', n: withClv.length, clv: round(avg, 4), beat }],
      picks: withClv.map((p) => p.id),
    })
  }

  // the week
  const weekAgo = now - 7 * DAY_MS
  const wk = group()
  let clvSum = 0
  let clvN = 0
  for (const p of decided) {
    if ((p.gradedAt || 0) < weekAgo) continue
    add(wk, p)
    if (Number.isFinite(p.clv)) {
      clvSum += p.clv
      clvN++
    }
  }
  const made = all.filter((p) => (p.createdAt || 0) >= weekAgo).length
  return {
    threshold: THRESHOLD,
    decided: decided.length,
    week: { ...view(wk), made, clv: clvN ? round(clvSum / clvN, 4) : null, picks: wk.ids },
    insights,
  }
}

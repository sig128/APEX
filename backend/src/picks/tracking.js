// Tracking: someone's own graded picks as a P&L line, a won/lost record, and trends by leg count,
// league and market. Descriptive only: wins and losses alike, with sample sizes, and anything
// built on fewer than ten decided picks is marked as a small sample (patterns there are mostly
// noise). Units are what the record already says each pick paid or lost.
import { americanToDecimal, decimalToAmerican } from '../lib/odds.js'
import { marketOf } from '../nfl/markets.js'

export const RANGES = { '30d': 30, '90d': 90, all: null }
export const SMALL = 10
const DAY = 86_400_000
const r2 = (x) => Math.round(x * 100) / 100
const r3 = (x) => Math.round(x * 1000) / 1000

const legBucket = (n) => (n === 1 ? '1' : n === 2 ? '2' : n === 3 ? '3' : '4+')
const LEG_LABEL = { 1: 'Singles', 2: '2-leg parlays', 3: '3-leg parlays', '4+': '4+ leg parlays' }
const SPORT_NAME = { nfl: 'NFL', nba: 'NBA', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', ncaaf: 'College football', ncaab: 'College basketball', mixed: 'Mixed leagues' }
const sportOf = (p) => {
  const s = new Set(p.legs.map((l) => l.sport || 'nfl'))
  return s.size === 1 ? [...s][0] : 'mixed'
}

function bucket() {
  return { n: 0, w: 0, l: 0, p: 0, v: 0, units: 0, risked: 0, dec: 0, decN: 0, clv: 0, clvN: 0, first: null, last: null }
}
function addPick(b, p, at) {
  b.n++
  if (p.result === 'win') b.w++
  else if (p.result === 'loss') b.l++
  else if (p.result === 'push') b.p++
  else b.v++
  b.units += Number(p.profit) || 0
  if (p.result === 'win' || p.result === 'loss') b.risked += Number(p.units) || 0
  const d = Number.isFinite(p.decimal) ? p.decimal : americanToDecimal(p.price)
  if (d > 1) {
    b.dec += d
    b.decN++
  }
  if (Number.isFinite(p.clv)) {
    b.clv += p.clv
    b.clvN++
  }
  b.first = b.first == null ? at : Math.min(b.first, at)
  b.last = b.last == null ? at : Math.max(b.last, at)
}
function view(key, label, b) {
  const decided = b.w + b.l
  return {
    key,
    label,
    picks: b.n,
    w: b.w,
    l: b.l,
    p: b.p,
    v: b.v,
    hit: decided ? r3(b.w / decided) : null,
    units: r2(b.units),
    roi: b.risked ? r3(b.units / b.risked) : null,
    avgOdds: b.decN ? decimalToAmerican(b.dec / b.decN) : null,
    clv: b.clvN ? r3(b.clv / b.clvN) : null,
    from: b.first,
    to: b.last,
    small: decided < SMALL,
  }
}

/** Every graded pick in the range, as a record, a daily line, trends and the current streak. */
export function tracking(picks, { now = Date.now(), range = '30d', dayOf = (t) => new Date(t).toISOString().slice(0, 10) } = {}) {
  const days = Object.hasOwn(RANGES, range) ? RANGES[range] : 30
  const since = days ? now - days * DAY : -Infinity
  const graded = picks
    .filter((p) => p.status === 'graded' && p.result)
    .map((p) => ({ p, at: p.gradedAt || p.lockAt || p.createdAt }))
    .filter((x) => x.at >= since)
    .sort((a, b) => a.at - b.at)
  const all = bucket()
  const byDay = new Map()
  const byLegs = new Map()
  const bySport = new Map()
  const byMarket = new Map()
  const marketName = {}
  for (const { p, at } of graded) {
    addPick(all, p, at)
    const day = dayOf(at)
    const d = byDay.get(day) || { day, units: 0, w: 0, l: 0, n: 0 }
    d.units += Number(p.profit) || 0
    d.n++
    if (p.result === 'win') d.w++
    if (p.result === 'loss') d.l++
    byDay.set(day, d)
    const lk = legBucket(p.legs.length)
    if (!byLegs.has(lk)) byLegs.set(lk, bucket())
    addPick(byLegs.get(lk), p, at)
    const sk = sportOf(p)
    if (!bySport.has(sk)) bySport.set(sk, bucket())
    addPick(bySport.get(sk), p, at)
    // legs by market: each leg's own result, so a parlay's winning legs count too
    for (const l of p.legs) {
      if (!l.result || l.result === 'void') continue
      const mk = l.market
      if (!marketName[mk]) marketName[mk] = marketOf(mk)?.long || String(l.label || mk).replace(/^(over|under)\s+[\d.]+\s+/i, '') || mk
      if (!byMarket.has(mk)) byMarket.set(mk, bucket())
      addPick(byMarket.get(mk), { result: l.result, profit: 0, units: 0, price: l.price, clv: l.clv }, at)
    }
  }
  let cum = 0
  const series = [...byDay.values()].map((d) => {
    cum += d.units
    return { day: d.day, units: r2(d.units), cum: r2(cum), w: d.w, l: d.l, n: d.n }
  })
  // the current streak: the latest decided picks in a row
  const decided = graded.filter((x) => x.p.result === 'win' || x.p.result === 'loss').map((x) => x.p.result)
  let streak = null
  if (decided.length) {
    const last = decided[decided.length - 1]
    let n = 0
    for (let i = decided.length - 1; i >= 0 && decided[i] === last; i--) n++
    streak = { kind: last, n }
  }
  const order = (a, b) => b.picks - a.picks
  return {
    range: days ? range : 'all',
    from: graded.length ? graded[0].at : null,
    to: graded.length ? graded[graded.length - 1].at : null,
    record: view('all', 'All picks', all),
    series,
    streak,
    last10: decided.slice(-10),
    byLegs: ['1', '2', '3', '4+'].filter((k) => byLegs.has(k)).map((k) => view(k, LEG_LABEL[k], byLegs.get(k))),
    bySport: [...bySport.entries()].map(([k, b]) => view(k, SPORT_NAME[k] || k.toUpperCase(), b)).sort(order),
    // markets count legs, not picks: units don't apply there
    byMarket: [...byMarket.entries()].map(([k, b]) => ({ ...view(k, marketName[k] || k, b), units: null, roi: null })).sort(order).slice(0, 12),
    small: SMALL,
  }
}

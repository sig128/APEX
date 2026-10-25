// Monte Carlo for a slip: play the legs out 10,000-100,000 times.
//
// Each leg's chance is the APEX probability (the number people see). What the simulation adds is
// how legs move together: a shared factor per game (pace, a shootout), per team (the offense
// has a good day), per team's pass/run tilt (a passing script feeds the QB and his receivers and
// starves the running back), and per player (two stats of the same player). Every leg is a
// latent normal built from those factors; its stat is drawn from a distribution centered so the
// line hits exactly as often as APEX says, so the correlations change the parlay, never a leg.
import { MARKETS } from '../markets.js'

// ---- math -----------------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normals(rand) {
  let spare = null
  return () => {
    if (spare != null) {
      const v = spare
      spare = null
      return v
    }
    let u = 0
    while (u === 0) u = rand()
    const r = Math.sqrt(-2 * Math.log(u))
    const th = 2 * Math.PI * rand()
    spare = r * Math.sin(th)
    return r * Math.cos(th)
  }
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7). */
export function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

/** Inverse standard normal CDF (Acklam). */
export function phiInv(p) {
  const pp = Math.min(1 - 1e-12, Math.max(1e-12, p))
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (pp < lo) {
    const q = Math.sqrt(-2 * Math.log(pp))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (pp > 1 - lo) return -phiInv(1 - pp)
  const q = pp - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

function poissonCdfTable(lambda, max = 60) {
  const out = []
  let pmf = Math.exp(-lambda)
  let cdf = pmf
  out.push(cdf)
  for (let k = 1; k <= max; k++) {
    pmf *= lambda / k
    cdf += pmf
    out.push(cdf)
  }
  return out
}

/** lambda with P(X >= k) = target, by bisection. */
function lambdaFor(k, target) {
  let lo = 1e-4
  let hi = Math.max(2, k * 4 + 8)
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const t = poissonCdfTable(mid, k)
    const atLeast = 1 - (k > 0 ? t[k - 1] : 0)
    if (atLeast < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// ---- how legs move together ----------------------------------------------------------------
// loadings on: G game pace, T team offense, P team pass tilt (+ pass, - run), U the player
const GROUP = {
  pass: { G: 0.25, T: 0.35, P: 0.45, U: 0.55 },
  passInt: { G: 0.1, T: -0.2, P: 0.35, U: 0.5 },
  rush: { G: 0.15, T: 0.3, P: -0.25, U: 0.55 },
  rec: { G: 0.25, T: 0.3, P: 0.4, U: 0.55 },
  rushRec: { G: 0.2, T: 0.35, P: 0.1, U: 0.55 },
  td: { G: 0.25, T: 0.45, P: 0, U: 0.4 },
  def: { G: 0.1, T: 0, P: 0, U: 0.55 },
  kick: { G: 0.3, T: 0.35, P: 0, U: 0.5 },
  team: { G: 0.5, T: 0.65, P: 0, U: 0 },
}
const GROUP_OF = {
  passYds: 'pass', passAtt: 'pass', passCmp: 'pass', passTd: 'pass', longPass: 'pass', passRushYds: 'pass', passInt: 'passInt',
  rushYds: 'rush', rushAtt: 'rush', longRush: 'rush',
  rec: 'rec', recYds: 'rec', longRec: 'rec', rushRecYds: 'rushRec',
  anyTd: 'td', td2: 'td',
  tackles: 'def', tacklesAst: 'def', sacks: 'def',
  fgMade: 'kick', kickPts: 'kick',
  teamPts: 'team',
}

/** Correlation of two legs' stats under the factor model (for display and tests). */
export function statCorrelation(a, b) {
  const la = GROUP[GROUP_OF[a.market] || 'def']
  const lb = GROUP[GROUP_OF[b.market] || 'def']
  let c = 0
  if (a.gameId && a.gameId === b.gameId) c += la.G * lb.G
  if (a.teamId && a.teamId === b.teamId) c += la.T * lb.T + la.P * lb.P
  if (a.playerId && a.playerId === b.playerId) c += la.U * lb.U
  return c
}

// ---- the simulation -------------------------------------------------------------------------
const pOver = (r) => (r.side === 'u' ? 1 - r.prob : r.prob)

function legModel(r) {
  const mk = MARKETS[r.market] || {}
  const po = Math.min(0.995, Math.max(0.005, pOver(r)))
  if (mk.dist === 'poisson' || r.oneSided) {
    const k = Math.floor(r.line) + 1
    const lambda = lambdaFor(k, po)
    return { kind: 'poisson', table: poissonCdfTable(lambda, Math.max(30, k * 4 + 10)), lambda }
  }
  const sd = r.sd > 0 ? r.sd : Math.max(1, (r.proj || r.line || 10) * (mk.cv || 0.4))
  return { kind: 'normal', sd, mu: r.line + sd * phiInv(po) }
}

function draw(model, z) {
  if (model.kind === 'normal') return Math.max(0, Math.round(model.mu + model.sd * z))
  const u = phi(z)
  const t = model.table
  let lo = 0
  let hi = t.length - 1
  if (u > t[hi]) return hi
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] >= u) hi = mid
    else lo = mid + 1
  }
  return lo
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]

/**
 * rows: full prop rows (views.findProp). Returns per-leg and parlay results.
 * price: the parlay's American odds (optional); bets: bets in the luck-vs-skill run.
 */
export function simulateSlip(rows, { iterations = 10_000, seed = 7, price = null, bets = 100, bettors = 2000 } = {}) {
  const n = rows.length
  const N = Math.min(100_000, Math.max(1000, Math.round(iterations)))
  const rand = mulberry32(seed)
  const z = normals(rand)
  const games = [...new Set(rows.map((r) => r.gameId).filter(Boolean))]
  const teams = [...new Set(rows.map((r) => r.teamId).filter(Boolean))]
  const players = [...new Set(rows.map((r) => r.playerId).filter(Boolean))]
  const legs = rows.map((r) => {
    const l = GROUP[GROUP_OF[r.market] || 'def']
    const shared = l.G * l.G + l.T * l.T + l.P * l.P + (r.playerId ? l.U * l.U : 0)
    return { r, l, g: games.indexOf(r.gameId), t: teams.indexOf(r.teamId), u: players.indexOf(r.playerId), own: Math.sqrt(Math.max(0.02, 1 - shared)), model: legModel(r), values: new Int32Array(N), hits: 0, pushes: 0 }
  })
  const G = new Float64Array(games.length)
  const T = new Float64Array(teams.length)
  const P = new Float64Array(teams.length)
  const U = new Float64Array(players.length)
  let parlayHits = 0
  let parlayPush = 0
  const legsHit = new Array(n + 1).fill(0)
  const onlyMiss = new Array(n).fill(0)
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < G.length; k++) G[k] = z()
    for (let k = 0; k < T.length; k++) {
      T[k] = z()
      P[k] = z()
    }
    for (let k = 0; k < U.length; k++) U[k] = z()
    let hit = 0
    let live = 0
    let missIdx = -1
    let misses = 0
    for (let j = 0; j < n; j++) {
      const L = legs[j]
      const lat = (L.g >= 0 ? L.l.G * G[L.g] : 0) + (L.t >= 0 ? L.l.T * T[L.t] + L.l.P * P[L.t] : 0) + (L.u >= 0 ? L.l.U * U[L.u] : 0) + L.own * z()
      const v = draw(L.model, lat)
      L.values[i] = v
      if (v === L.r.line) {
        L.pushes++
        continue
      }
      live++
      const ok = L.r.side === 'u' ? v < L.r.line : v > L.r.line
      if (ok) {
        L.hits++
        hit++
      } else {
        misses++
        missIdx = j
      }
    }
    legsHit[hit]++
    if (live === 0) parlayPush++
    else if (misses === 0) parlayHits++
    if (misses === 1) onlyMiss[missIdx]++
  }

  const legOut = legs.map((L, j) => {
    const sorted = Float64Array.from(L.values).sort()
    const lo = Math.max(0, Math.min(quantile(sorted, 0.01), Math.floor(L.r.line) - 1))
    const hi = Math.max(quantile(sorted, 0.99), Math.ceil(L.r.line) + 1)
    const width = Math.max(1, Math.ceil((hi - lo + 1) / 24))
    const bins = []
    for (let x = lo; x <= hi; x += width) bins.push({ x0: x, x1: x + width - 1, n: 0 })
    for (const v of L.values) {
      const b = Math.min(bins.length - 1, Math.max(0, Math.floor((v - lo) / width)))
      bins[b].n++
    }
    return {
      id: L.r.id,
      name: L.r.name,
      short: L.r.short,
      label: L.r.label,
      line: L.r.line,
      side: L.r.side,
      apex: L.r.prob,
      hitRate: L.hits / N,
      pushRate: L.pushes / N,
      median: quantile(sorted, 0.5),
      p10: quantile(sorted, 0.1),
      p90: quantile(sorted, 0.9),
      bins: bins.map((b) => ({ x0: b.x0, x1: b.x1, share: b.n / N })),
      onlyMiss: onlyMiss[j] / N,
    }
  })
  const hitRate = parlayHits / N
  const pushRate = parlayPush / N
  const independent = legs.reduce((x, L) => x * (L.hits / Math.max(1, N - L.pushes)), 1)
  const pairs = []
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const c = statCorrelation(rows[a], rows[b]) * (rows[a].side === rows[b].side ? 1 : -1)
    if (Math.abs(c) >= 0.05) pairs.push({ a: rows[a].id, b: rows[b].id, together: c })
  }

  let priceOut = null
  let luck = null
  const dec = Number.isFinite(price) && Math.abs(price) >= 100 ? (price > 0 ? 1 + price / 100 : 1 + 100 / -price) : null
  if (dec) {
    const implied = 1 / dec
    const ev = hitRate * (dec - 1) - (1 - hitRate - pushRate)
    priceOut = { price, decimal: dec, implied, ev, breakEven: implied }
    luck = luckVsSkill({ p: hitRate, push: pushRate, dec, bets, bettors, seed: seed + 1 })
  }
  return {
    iterations: N,
    margin: 1.96 * Math.sqrt(Math.max(hitRate * (1 - hitRate), 1e-6) / N),
    legs: legOut,
    parlay: { hitRate, pushRate, independent, legsHit: legsHit.map((c) => c / N), correlated: pairs },
    price: priceOut,
    luck,
  }
}

/**
 * Luck vs skill: many bettors place the same bet again and again. With APEX's chance (skill)
 * and with the book's own chance (no edge, all luck), at 1 unit a bet.
 */
export function luckVsSkill({ p, push = 0, dec, bets = 100, bettors = 2000, seed = 11 }) {
  const runs = (prob, pushP) => {
    const rand = mulberry32(seed)
    const steps = Math.max(10, Math.min(1000, bets))
    const marks = Array.from({ length: 21 }, (_, i) => Math.round((i * steps) / 20))
    const at = marks.map(() => new Float64Array(bettors))
    const finals = new Float64Array(bettors)
    for (let b = 0; b < bettors; b++) {
      let units = 0
      let m = 1
      for (let s = 1; s <= steps; s++) {
        const u = rand()
        if (u < prob) units += dec - 1
        else if (u >= prob + pushP) units -= 1
        if (s === marks[m]) at[m++][b] = units
      }
      finals[b] = units
    }
    const bands = marks.map((step, i) => {
      const sorted = Float64Array.from(at[i]).sort()
      return { step, p10: quantile(sorted, 0.1), p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) }
    })
    const up = finals.reduce((c, v) => c + (v > 0 ? 1 : 0), 0) / bettors
    return { bands, up, median: bands[bands.length - 1].p50 }
  }
  // no edge: the bet wins exactly as often as its price says
  return { bets: Math.max(10, Math.min(1000, bets)), skill: runs(p, push), luck: runs(1 / dec, 0) }
}

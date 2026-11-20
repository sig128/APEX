// The parlay builder: pick how much risk (safe, balanced or longshot), how many legs and roughly
// what it should pay, and it finds the legs on the board that fit.
//
// Every prop for games that haven't started (main lines and nearby alternates) is screened by the
// profile: the chance each leg needs, games behind it, a steady role, the injury report, and the
// house rule that nothing shorter than -500 after the vig is worth a leg. Then a search over
// combinations of the chosen size, with three hard rules: one leg per player or team, no two legs
// that pull against each other (the same correlation floor the 3-Leg Lock uses), and a cap on legs
// from one game. The target is a price, read as a chance (+300 is one time in four): among the
// combinations whose fair price lands near it, the legs with the most support win: games behind
// them, a steady role, the projection agreeing with the hit rates, recent form and the read. With
// sportsbook prices on enough of the board, only priced legs are used, the posted payout and its
// expected value are shown, and value counts first. The finalists are played out in the
// correlated simulation, and the chance shown is the simulation's, never the legs multiplied.
import { RULES } from '../rules.js'
import { simulateSlip, phiInv } from './sim.js'
import { legCorrelation, recencyOf, priceOf, bookOf, playableAt } from './lock.js'
import { americanToDecimal, decimalToAmerican } from '../../lib/odds.js'
import { round } from '../../lib/util.js'

export const LEG_RANGE = { min: 2, max: 8 }
export const TARGET_RANGE = { min: 100, max: 20_000 }

/**
 * The three profiles. minProb: the chance every leg needs. typical: the range most legs fall in,
 * which sets the payouts offered for each leg count. perGame: legs from one game, unless one game
 * is picked. markets: 'core' keeps to the familiar markets (yards, receptions, points, anytime
 * TD); 'all' lets the rest in at a cost.
 */
export const PROFILES = {
  safe: {
    key: 'safe',
    label: 'Safe',
    blurb: 'Each leg likely. It cashes most often and pays the least.',
    legs: { min: 2, max: 4, def: 2 },
    typical: [0.62, 0.8],
    minProb: 0.6,
    minSample: 8,
    minRole: 0.7,
    oneSided: false,
    questionable: false,
    moveAgainst: false,
    perGame: 2,
    markets: 'core',
  },
  balanced: {
    key: 'balanced',
    label: 'Balanced',
    blurb: 'A real payout from legs the numbers back.',
    legs: { min: 2, max: 6, def: 3 },
    typical: [0.52, 0.72],
    minProb: 0.5,
    minSample: 6,
    minRole: 0.55,
    oneSided: true,
    questionable: false,
    moveAgainst: true,
    perGame: 3,
    markets: 'core',
  },
  longshot: {
    key: 'longshot',
    label: 'Longshot',
    blurb: 'A big price. Most of these lose, so a small stake is the point.',
    legs: { min: 3, max: 8, def: 4 },
    typical: [0.35, 0.65],
    minProb: 0.2,
    minSample: 5,
    minRole: 0.4,
    oneSided: true,
    questionable: true,
    moveAgainst: true,
    perGame: 4,
    markets: 'all',
  },
}

// payouts people recognise, for the one-tap targets
const NICE = [100, 110, 120, 130, 150, 175, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 15000, 20000]
const snap = (dec) => NICE.reduce((best, a) => (Math.abs(Math.log((1 + a / 100) / dec)) < Math.abs(Math.log((1 + best / 100) / dec)) ? a : best), NICE[0])

/** Four payouts a profile can reach with n legs, shortest first (American odds, +100 and up). */
export function targetsFor(risk, n) {
  const P = PROFILES[risk] || PROFILES.balanced
  const [pLo, pHi] = P.typical
  const a = Math.max(2, (1 / pHi) ** n)
  const b = Math.min(1 + TARGET_RANGE.max / 100, Math.max(a * 1.25, (1 / pLo) ** n))
  return [...new Set([0, 1 / 3, 2 / 3, 1].map((f) => snap(a * (b / a) ** f)))]
}
/** The default target: the second of the four. */
export const defaultTarget = (risk, n) => {
  const t = targetsFor(risk, n)
  return t[Math.min(1, t.length - 1)]
}

/** The profiles as the page needs them (no internals). */
export function profilesView() {
  return Object.values(PROFILES).map((p) => {
    const targets = {}
    for (let n = p.legs.min; n <= p.legs.max; n++) targets[n] = targetsFor(p.key, n)
    return { key: p.key, label: p.label, blurb: p.blurb, legs: p.legs, minProb: p.minProb, targets, target: defaultTarget(p.key, p.legs.def) }
  })
}

const POOL_MAX = 90
const BEAM = 260
const FINALISTS = 12
const DEAD_ZONE = Math.log(1.1) // within 10% of the target's payout counts as on target
const ON_TARGET = Math.log(1.3) // further than 30% off is "the closest we could get"
const SWAP_BAND = Math.log(1.3)

const clamp01 = (x) => Math.max(0, Math.min(1, x))
const subjectOf = (r) => (r.kind === 'team' || !r.playerId ? `t${r.teamId}` : String(r.playerId))
const dens = (p) => {
  const z = phiInv(Math.min(0.999, Math.max(0.001, p)))
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)
}
const decOf = (american) => americanToDecimal(american)

/** A line that moved against this side since it opened, by more than the noise (as the lock reads it). */
export function movedAgainst(r) {
  if (!r?.move?.delta) return false
  const withUs = (r.side === 'u' ? -1 : 1) * Math.sign(r.move.delta) > 0
  const big = Math.abs(r.move.delta) >= Math.max(0.5, Math.abs(r.move.open || r.line) * 0.03)
  return !withUs && big
}

/** Shorter than -500 once the vig is in: the house rule says too short to beat it. */
export const tooShort = (p) => playableAt(p) <= RULES.maxFavorite

/**
 * How much stands behind a leg, 0 to 1, apart from its chance: games behind the numbers, a
 * steady role, the line inside his usual range, the projection on its own backing the side,
 * recent form at or above the chance, and the read. Injury news, a line moving away and (where
 * the profile allows them) the less familiar markets cost.
 */
export function supportOf(r, { now = Date.now(), injury = null, core = null } = {}) {
  const conf = clamp01(((r.sample ?? 0) - 4) / 16)
  const role = clamp01(((r.role ?? 0.8) - 0.4) / 0.6)
  const fit = clamp01(((r.fit ?? 1) - 0.6) / 0.4)
  // the projection alone: for a likely side it should clear 50% by itself; for a longer line
  // (an alternate, a yes-only market) it should land near the chance we give it
  const model = Number.isFinite(r.probModel) ? r.probModel : null
  const backs = model == null ? 0.4 : !r.oneSided && r.prob >= 0.5 ? clamp01((model - 0.5) / 0.2) : clamp01(1 - Math.abs(model - r.prob) / 0.2)
  const rec = recencyOf(r, now).weighted
  const form = rec == null ? 0.45 : clamp01(0.5 + (rec - r.prob) * 2)
  const lean = r.read?.lean === 'for' ? 1 : r.read?.lean === 'mixed' ? 0.5 : r.read?.lean === 'against' ? 0 : 0.4
  let q = 0.2 * conf + 0.16 * role + 0.1 * fit + 0.22 * backs + 0.17 * form + 0.15 * lean
  if (movedAgainst(r)) q -= 0.08
  if (core && !core.has(r.market)) q -= 0.12
  const sev = injury?.severity
  if (sev === 'questionable') q -= 0.15
  else if (sev === 'probable' || sev === 'other') q -= 0.04
  return round(clamp01(q), 3)
}

/** Normalize what the page asked for. Throws a message when it can't be read. */
export function readRequest(body = {}) {
  const risk = Object.hasOwn(PROFILES, body.risk) ? body.risk : 'balanced'
  const P = PROFILES[risk]
  const n = Number(body.legs ?? P.legs.def)
  if (!Number.isInteger(n) || n < LEG_RANGE.min || n > LEG_RANGE.max) return { error: `Pick ${LEG_RANGE.min} to ${LEG_RANGE.max} legs.` }
  const legs = Math.min(P.legs.max, Math.max(P.legs.min, n))
  const t = Math.round(Number(body.target ?? defaultTarget(risk, legs)))
  if (!Number.isFinite(t) || t < TARGET_RANGE.min || t > TARGET_RANGE.max) return { error: `Target odds go from +${TARGET_RANGE.min} to +${TARGET_RANGE.max.toLocaleString('en-US')}.` }
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(String))].filter((x) => x.length <= 80).slice(0, 40) : [])
  const gameId = body.gameId != null && body.gameId !== '' && /^\w{3,24}$/.test(String(body.gameId)) ? String(body.gameId) : null
  return { risk, legs, adjusted: legs !== n, target: t, keep: ids(body.keep), avoid: ids(body.avoid), gameId }
}

/**
 * The builds. rows: full prop rows for games that haven't started (main lines and alternates);
 * keepRows: legs the person wants in, from their slip. Returns { status, mode, funnel, builds }.
 */
export function buildParlays(rows, { risk = 'balanced', legs: n = 3, target = 400, keepRows = [], avoid = [], gameId = null, now = Date.now(), injuryOf = () => null, core = null, options = 3, iterations = 20_000, seed = 202 } = {}) {
  const P = PROFILES[risk] || PROFILES.balanced
  // the familiar markets only, or (longshot) everything with the rest marked down
  const coreSet = core ? new Set(core) : null
  const strict = P.markets === 'core' && coreSet
  const avoidSet = new Set(avoid)
  const targetDec = 1 + target / 100
  const targetLn = Math.log(targetDec)
  const funnel = { scanned: 0, injury: 0, oneSided: 0, markets: 0, sample: 0, role: 0, chance: 0, short: 0, market: 0, avoided: 0, eligible: 0, priced: 0 }

  // ---- the legs the person keeps ----
  const keep = keepRows.map((r) => ({ r, p: r.prob, q: supportOf(r, { now, injury: r.playerId ? injuryOf(r.playerId) : null, core: coreSet }), dec: priceOf(r) != null ? decOf(priceOf(r)) : null, subject: subjectOf(r), kept: true, inj: r.playerId ? injuryOf(r.playerId) : null }))
  for (let i = 0; i < keep.length; i++)
    for (let j = i + 1; j < keep.length; j++) {
      if (keep[i].subject === keep[j].subject) return fail('keep_conflict', `${keep[i].r.short || keep[i].r.name} is in your slip twice. Keep one of those legs.`)
      if (legCorrelation(keep[i].r, keep[j].r) < RULES.corrFloor) return fail('keep_conflict', `${keep[i].r.short || keep[i].r.name} and ${keep[j].r.short || keep[j].r.name} pull against each other. Keep one of them.`)
    }
  if (keep.length >= n) return fail('keep_too_many', `You're keeping ${keep.length} legs. Pick more legs than that, or keep fewer.`)
  const keepIds = new Set(keep.map((k) => k.r.id))
  const keepSubjects = new Set(keep.map((k) => k.subject))

  // ---- screen the board ----
  const cands = []
  const seen = new Set()
  for (const r of rows) {
    if (!r || seen.has(r.id) || keepIds.has(r.id)) continue
    seen.add(r.id)
    funnel.scanned++
    if (avoidSet.has(r.id)) {
      funnel.avoided++
      continue
    }
    if (r.pending || !(r.prob > 0 && r.prob < 1)) continue
    if (gameId && String(r.gameId) !== gameId) continue
    const inj = r.playerId ? injuryOf(r.playerId) : null
    const sev = inj?.severity
    if (sev === 'out' || sev === 'doubtful' || (sev === 'questionable' && !P.questionable)) {
      funnel.injury++
      continue
    }
    if (r.oneSided && !P.oneSided) {
      funnel.oneSided++
      continue
    }
    if (strict && !coreSet.has(r.market)) {
      funnel.markets++
      continue
    }
    if ((r.sample ?? 0) < P.minSample) {
      funnel.sample++
      continue
    }
    if ((r.role ?? 1) < P.minRole) {
      funnel.role++
      continue
    }
    if (r.prob < P.minProb) {
      funnel.chance++
      continue
    }
    if (tooShort(r.prob)) {
      funnel.short++
      continue
    }
    if (!P.moveAgainst && movedAgainst(r)) {
      funnel.market++
      continue
    }
    const a = priceOf(r)
    cands.push({ r, p: r.prob, q: supportOf(r, { now, injury: inj, core: strict ? null : coreSet }), dec: a != null ? decOf(a) : null, subject: subjectOf(r), inj })
  }
  funnel.eligible = cands.length
  funnel.priced = cands.filter((c) => c.dec).length

  const need = n - keep.length
  // book mode: enough of the board has posted prices that the payout can be the real one
  const book = funnel.priced >= Math.max(12, 3 * need) && keep.every((k) => k.dec)
  const pool0 = book ? cands.filter((c) => c.dec) : cands
  const subjects = new Set(pool0.map((c) => c.subject).filter((s) => !keepSubjects.has(s)))
  if (subjects.size < need) {
    return { status: 'short', mode: book ? 'book' : 'fair', funnel, builds: [], reason: shortReason(funnel, { need, n, P, players: subjects.size, gameId, kept: keep.length }) }
  }

  // ---- keep the most useful part of the pool: support, closeness to the per-leg target ----
  // the target is the fair price (the chance) in both modes; posted prices add value, not the target
  const keepLn = keep.reduce((s, k) => s - Math.log(k.p), 0)
  const perLeg = (targetLn - keepLn) / need // the log-payout each remaining leg should carry
  const legLn = (c) => -Math.log(c.p)
  const useful = (c) => c.q - 0.6 * Math.abs(legLn(c) - perLeg) + (book ? 2 * Math.log(c.p * c.dec) : 0)
  // at most three lines per player and stat, so one player can't crowd the pool
  const perKey = new Map()
  const pool = []
  for (const c of [...pool0].sort((a, b) => useful(b) - useful(a))) {
    if (keepSubjects.has(c.subject)) continue
    const k = `${c.subject}:${c.r.market}`
    if ((perKey.get(k) || 0) >= 3) continue
    perKey.set(k, (perKey.get(k) || 0) + 1)
    pool.push(c)
    if (pool.length >= POOL_MAX) break
  }
  const all = [...keep, ...pool] // keep legs first: indexes 0..keep.length-1
  const K = keep.length
  const m = all.length
  const ratio = all.map((c) => dens(c.p) / c.p)
  const corr = new Float64Array(m * m)
  const clash = new Uint8Array(m * m)
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++) {
      const c = legCorrelation(all[i].r, all[j].r)
      corr[i * m + j] = corr[j * m + i] = c
      if (all[i].subject === all[j].subject || c < RULES.corrFloor) clash[i * m + j] = clash[j * m + i] = 1
    }
  const cap = gameId ? Infinity : P.perGame

  // ---- beam search over combinations (pool indexes ascending, so each set is seen once) ----
  const lnMax = Math.max(...pool.map(legLn))
  const lnMin = Math.min(...pool.map(legLn))
  let states = [{ idx: [...Array(K).keys()], last: K - 1, lnP: keep.reduce((s, k) => s + Math.log(k.p), 0), adj: pairAdj([...Array(K).keys()]), q: keep.reduce((s, k) => s + k.q, 0), lnBook: book ? keep.reduce((s, k) => s + Math.log(k.dec), 0) : 0, games: gamesOf([...Array(K).keys()]) }]
  function pairAdj(idx) {
    let a = 0
    for (let x = 0; x < idx.length; x++) for (let y = x + 1; y < idx.length; y++) a += corr[idx[x] * m + idx[y]] * ratio[idx[x]] * ratio[idx[y]]
    return a
  }
  function gamesOf(idx) {
    const g = new Map()
    for (const i of idx) g.set(all[i].r.gameId, (g.get(all[i].r.gameId) || 0) + 1)
    return g
  }
  const factor = (adj) => Math.min(2.5, Math.max(0.4, 1 + adj))
  const lnPay = (s) => -(s.lnP + Math.log(factor(s.adj)))
  for (let step = K; step < n; step++) {
    const left = n - step - 1
    const next = []
    for (const s of states) {
      for (let j = Math.max(s.last + 1, K); j < m; j++) {
        let bad = false
        let add = 0
        for (const i of s.idx) {
          if (clash[i * m + j]) {
            bad = true
            break
          }
          add += corr[i * m + j] * ratio[i] * ratio[j]
        }
        if (bad) continue
        const g = all[j].r.gameId
        if ((s.games.get(g) || 0) >= cap) continue
        const ns = { idx: [...s.idx, j], last: j, lnP: s.lnP + Math.log(all[j].p), adj: s.adj + add, q: s.q + all[j].q, lnBook: book ? s.lnBook + Math.log(all[j].dec) : 0, games: s.games }
        // can the legs still to come land it near the target? (a wide margin: the simulation decides)
        const pay = lnPay(ns)
        if (pay + left * lnMin > targetLn + Math.log(1.8) || pay + left * lnMax < targetLn - Math.log(1.8)) continue
        ns.games = new Map(s.games).set(g, (s.games.get(g) || 0) + 1)
        next.push(ns)
      }
    }
    // partial score: support so far, payout per leg near what the target needs, and value
    const score = (s) => {
      const k = s.idx.length
      const dev = Math.abs(lnPay(s) / k - targetLn / n)
      const edge = book ? s.idx.reduce((x, i) => x + Math.log(all[i].p * all[i].dec), 0) / k : 0
      const done = k === n ? finalScore(s) : s.q / k - 0.6 * dev + 2 * edge
      return done
    }
    for (const s of next) s.score = score(s)
    next.sort((a, b) => b.score - a.score)
    states = next.slice(0, BEAM)
    if (!states.length) break
  }
  // near the target comes first (a big bonus), then support, then value at the posted prices
  // (capped, so one mispriced leg can't drag the parlay away from the price that was asked for)
  function finalScore(s, chance = null) {
    const p = chance ?? Math.exp(s.lnP) * factor(s.adj)
    const dist = Math.abs(-Math.log(p) - targetLn)
    const pen = Math.max(0, dist - DEAD_ZONE) * 2.5
    const ev = book ? Math.max(-0.3, Math.min(0.3, p * Math.exp(s.lnBook) - 1)) : 0
    return (dist <= ON_TARGET ? 10 : 0) + s.q / s.idx.length + 1.2 * ev - pen
  }
  const complete = states.filter((s) => s.idx.length === n)
  if (!complete.length) return { status: 'short', mode: book ? 'book' : 'fair', funnel, builds: [], reason: `No ${n} legs ${gameId ? 'in this game' : 'on the board'} fit together near +${target}: too many of them pull against each other. Try fewer legs or a different target.` }

  // ---- play the finalists out; the simulation's chance decides ----
  const finalists = complete.sort((a, b) => b.score - a.score).slice(0, FINALISTS)
  const runs = Math.min(iterations, 12_000)
  for (const s of finalists) {
    const sim = simulateSlip(s.idx.map((i) => all[i].r), { iterations: runs, seed })
    s.chance = sim.parlay.hitRate
    s.final = finalScore(s, Math.max(1e-6, s.chance))
  }
  finalists.sort((a, b) => b.final - a.final)
  // each option has to be a different parlay: fewer than half its legs shared with an earlier
  // one (kept legs don't count), or at most half when the board is thin
  const chosen = []
  for (const share of [Math.floor((n - K - 1) / 2), Math.floor((n - K) / 2)]) {
    for (const s of finalists) {
      if (chosen.length >= options || chosen.includes(s)) continue
      const subj = new Set(s.idx.filter((i) => i >= K).map((i) => all[i].subject))
      if (chosen.some((c) => c.idx.filter((i) => i >= K && subj.has(all[i].subject)).length > share)) continue
      chosen.push(s)
    }
  }
  chosen.sort((a, b) => b.final - a.final)

  const builds = chosen.map((s) => {
    const rs = s.idx.map((i) => all[i].r)
    const sim = simulateSlip(rs, { iterations, seed: seed + 1 })
    const chance = sim.parlay.hitRate
    const pay = -Math.log(Math.max(1e-6, chance))
    const dec = book ? Math.exp(s.lnBook) : null
    const together = []
    for (let a = 0; a < s.idx.length; a++)
      for (let b = a + 1; b < s.idx.length; b++) {
        const c = corr[s.idx[a] * m + s.idx[b]]
        if (c >= 0.05) together.push({ a: rs[a].id, b: rs[b].id, corr: round(c, 3) })
      }
    const games = new Set(rs.map((r) => r.gameId))
    return {
      id: rs.map((r) => r.id).join('~'),
      legs: s.idx.map((i, k) => ({
        r: all[i].r,
        kept: Boolean(all[i].kept),
        support: all[i].q,
        simHit: round(sim.legs[k].hitRate, 4),
        price: book ? priceOf(all[i].r) : null,
        book: book ? bookOf(all[i].r) : null,
        injury: all[i].inj?.severity && all[i].inj.severity !== 'other' ? { status: all[i].inj.status, severity: all[i].inj.severity } : null,
        swaps: all[i].kept ? [] : swapsFor(s, k),
      })),
      chance: round(chance, 4),
      margin: round(sim.margin, 4),
      iterations: sim.iterations,
      independent: round(sim.parlay.independent, 4),
      multiplied: round(rs.reduce((x, r) => x * r.prob, 1), 4),
      fair: decimalToAmerican(1 / Math.max(1e-6, chance)),
      price: dec ? { american: decimalToAmerican(dec), decimal: round(dec, 3), ev: round(chance * dec - 1, 4) } : null,
      onTarget: Math.abs(pay - targetLn) <= ON_TARGET,
      gap: round(pay - targetLn, 3),
      games: games.size,
      sameGame: games.size < rs.length,
      together,
    }
  })

  /** Up to three other legs for slot k that keep the parlay valid and its price close. */
  function swapsFor(s, k) {
    const others = s.idx.filter((_, x) => x !== k)
    const otherSubj = new Set(others.map((i) => all[i].subject))
    const lnP0 = others.reduce((x, i) => x + Math.log(all[i].p), 0)
    const adj0 = pairAdj(others)
    const games = gamesOf(others)
    const here = lnPay(s)
    const out = []
    for (let j = K; j < m; j++) {
      if (s.idx.includes(j) || otherSubj.has(all[j].subject)) continue
      if (others.some((i) => clash[i * m + j])) continue
      if ((games.get(all[j].r.gameId) || 0) >= cap) continue
      const adj = adj0 + others.reduce((x, i) => x + corr[i * m + j] * ratio[i] * ratio[j], 0)
      const chance = Math.exp(lnP0 + Math.log(all[j].p)) * factor(adj)
      const pay = -Math.log(chance)
      if (Math.abs(pay - here) > SWAP_BAND) continue
      out.push({ r: all[j].r, support: all[j].q, chance: round(chance, 4), score: all[j].q - Math.abs(pay - targetLn) })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 3).map(({ score, ...x }) => x)
  }

  const best = builds[0]
  return {
    status: best?.onTarget ? 'ok' : 'off_target',
    mode: book ? 'book' : 'fair',
    funnel,
    builds,
    reason: best && !best.onTarget ? offReason(best, { n, target, P, book }) : null,
  }
}

function fail(code, reason) {
  return { status: 'error', code, reason, builds: [], funnel: null }
}

function offReason(best, { n, target, P, book }) {
  const got = fmtOdds(best.fair)
  // what would get closer, of the moves still open to this profile
  const fixes =
    best.gap > 0
      ? [n > P.legs.min && 'fewer legs', P.key !== 'safe' && 'a safer profile'].filter(Boolean)
      : [n < P.legs.max && 'more legs', P.key !== 'longshot' && 'a bolder profile'].filter(Boolean)
  const fix = fixes.length ? `${fixes.join(' or ').replace(/^./, (c) => c.toUpperCase())} gets closer.` : 'Try a different target.'
  return `The closest ${n}-leg ${P.label.toLowerCase()} parlay on the board is fair at about ${got}, not +${target}. ${fix}`
}

function shortReason(f, { need, n, P, players, gameId, kept }) {
  const where = gameId ? 'in this game' : 'on the board'
  if (!f.scanned) return gameId ? 'This game has no props open right now.' : 'No games on the board have props open right now.'
  const legs = (k) => `${k} ${k === 1 ? 'prop' : 'props'}`
  const who = (k) => `${k} ${k === 1 ? 'player' : 'players'}`
  const pass = f.eligible ? `Only ${legs(f.eligible)} from ${who(players)} pass the ${P.label.toLowerCase()} screen ${where}` : `No props pass the ${P.label.toLowerCase()} screen ${where}`
  const needs = kept ? `the ${need} legs still to find need ${need} other players` : `a ${n}-leg parlay needs ${n} different players`
  const out = [`${pass}, and ${needs}.`]
  if (f.chance) out.push(`${f.chance} ${f.chance === 1 ? 'was' : 'were'} under the ${Math.round(P.minProb * 100)}% each leg needs.`)
  return out.join(' ')
}

const fmtOdds = (a) => (a == null ? '–' : a > 0 ? `+${a}` : String(a))

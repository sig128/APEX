// The 3-Leg Lock: every prop on the board run through the APEX rules, then the one three-leg
// parlay most likely to cash among the combinations that pass all of them, or a Pass.
//
// A leg is certified on seven checks, each traceable to a number on the prop:
//   probability  APEX win probability of at least 65%
//   edge         APEX beats the price's implied probability (vig included) by 2+ points
//   sample       8+ games behind the numbers
//   recency      the last 15 days weighted most: recency-weighted hit rate of 60%+, and not a
//                miss in every game of the last 15 days
//   regression   the projection on its own backs the side, and no hot streak far above the
//                player's longer record
//   role         a steady role (snaps/targets) and not on the injury report as doubtful or
//                questionable
//   market       the line hasn't moved against the side since it opened
// Edge is "pending" when no sportsbook price is posted: the leg can still make a lock, which is
// then only a bet at the break-even price or better.
//
// The three legs: different players, multiplied together over 45% before any correlation
// bonus, no pair that pulls against the other, and positive expected value at the price when
// there is one. The pick is the combination the correlated simulation says cashes most often.
import { RULES, RECENCY_WEIGHTS } from '../rules.js'
import { statCorrelation, simulateSlip, phiInv } from './sim.js'
import { americanToProb, americanToDecimal, probToAmerican, decimalToAmerican } from '../../lib/odds.js'
import { round } from '../../lib/util.js'

const DAY = 86_400_000
const dens = (p) => {
  const z = phiInv(Math.min(0.999, Math.max(0.001, p)))
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)
}
const pctTxt = (p) => `${Math.round(p * 100)}%`

/** The best price on the side the row bets, across books (line shopping), if any book posted one. */
export function priceOf(row) {
  if (!row?.price) return null
  const side = row.oneSided ? 'yes' : row.side === 'u' ? 'under' : 'over'
  const best = row.price.best?.[side]
  const a = best?.price ?? row.price[side]
  return Number.isFinite(a) && Math.abs(a) >= 100 ? a : null
}

/** Which book has that best price. */
export function bookOf(row) {
  const side = row.oneSided ? 'yes' : row.side === 'u' ? 'under' : 'over'
  return row.price?.best?.[side]?.book || (row.price?.[side] != null ? row.price.book : null) || null
}

/** The worst price that still keeps the edge rule: implied probability at most p - edgeMin. */
export function playableAt(p, edgeMin = RULES.edgeMin) {
  return probToAmerican(Math.max(0.01, p - edgeMin))
}

function hitRate(list) {
  const graded = list.filter((r) => r.o === 'hit' || r.o === 'miss')
  return { hits: graded.filter((r) => r.o === 'hit').length, n: graded.length }
}

/** Hit rates over the last 15 days, last 5 and the season, blended with the most weight on recent. */
export function recencyOf(row, now) {
  const recent = row.recent || []
  const d15 = hitRate(recent.filter((r) => r.date && now - Date.parse(r.date) <= RULES.recentDays * DAY && Date.parse(r.date) <= now))
  const l5 = hitRate(recent.slice(-5))
  const season = row.windows?.find((w) => w.key === 'season') || null
  // the last 15 days carry the most weight, scaled down when they hold a single game
  const parts = [
    [RECENCY_WEIGHTS.d15 * Math.min(1, d15.n / 2), d15.n ? d15.hits / d15.n : null],
    [RECENCY_WEIGHTS.l5, l5.n ? l5.hits / l5.n : null],
    [RECENCY_WEIGHTS.season, season?.n ? season.hits / season.n : null],
  ].filter(([, v]) => v != null)
  const wsum = parts.reduce((s, [w]) => s + w, 0)
  const weighted = wsum ? parts.reduce((s, [w, v]) => s + w * v, 0) / wsum : null
  return { d15, l5, season: season ? { hits: season.hits, n: season.n } : null, weighted: weighted == null ? null : round(weighted, 3) }
}

const SEVERE = new Set(['out', 'doubtful', 'questionable'])

/**
 * The seven checks for one leg. Each: { key, label, state: 'pass' | 'fail' | 'pending', detail }.
 * `ok` is true when nothing failed (edge may be pending).
 */
export function certifyLeg(row, { now = Date.now(), injury = null } = {}) {
  const checks = []
  const add = (key, label, state, detail) => checks.push({ key, label, state, detail })
  const p = row.prob

  add('prob', 'Win probability', p >= RULES.legMin ? 'pass' : 'fail', `APEX ${pctTxt(p)} (needs ${pctTxt(RULES.legMin)})`)

  const price = priceOf(row)
  const implied = price != null ? americanToProb(price) : null
  const edge = implied != null ? p - implied : null
  const ev = price != null ? p * americanToDecimal(price) - 1 : null
  if (price == null) add('edge', 'Edge over the vig', 'pending', `No sportsbook price posted. Playable at ${fmt(playableAt(p))} or better`)
  else add('edge', 'Edge over the vig', edge >= RULES.edgeMin && ev > 0 ? 'pass' : 'fail', `${fmt(price)} implies ${pctTxt(implied)}; APEX ${pctTxt(p)}, edge ${(edge * 100).toFixed(1)} pts, EV ${ev >= 0 ? '+' : ''}${(ev * 100).toFixed(1)}%`)

  const sample = row.sample ?? 0
  const l10 = row.windows?.find((w) => w.key === 'L10')
  add('sample', 'Sample size', sample >= RULES.sampleMin ? 'pass' : 'fail', `${sample} games behind it${l10 ? `; ${l10.hits}/${l10.n} in the last ${l10.n}` : ''} (needs ${RULES.sampleMin})`)

  const rec = recencyOf(row, now)
  const swept = rec.d15.n >= 2 && rec.d15.hits === 0
  const recOk = rec.weighted != null && rec.weighted >= RULES.recentMin && !swept
  add(
    'recency',
    'Recent form (last 15 days first)',
    recOk ? 'pass' : 'fail',
    `${rec.d15.n ? `${rec.d15.hits}/${rec.d15.n} in the last ${RULES.recentDays} days, ` : 'no games in the last 15 days, '}${rec.l5.hits}/${rec.l5.n} last 5${rec.season ? `, ${rec.season.hits}/${rec.season.n} this season` : ''}; weighted ${rec.weighted == null ? 'n/a' : pctTxt(rec.weighted)}${swept ? ' (missed every recent game)' : ''}`,
  )

  // regression: the projection alone has to back the side, and a perfect last five against a
  // middling longer record is a streak the numbers don't support
  const model = Number.isFinite(row.probModel) ? row.probModel : null
  const longer = row.windows?.find((w) => w.key === 'L20') || row.windows?.find((w) => w.key === 'season')
  const hot = rec.l5.n >= 5 && rec.l5.hits === rec.l5.n && longer && longer.n >= 8 && longer.hits / longer.n < 0.55
  const projTxt = row.proj != null ? `projection ${row.proj} vs line ${row.line}` : `line ${row.line}`
  if (model == null) add('regression', 'Regression check', hot ? 'fail' : 'pass', hot ? `Perfect last 5, but ${longer.hits}/${longer.n} over the longer run: expect it to cool` : `${projTxt}; no streak running ahead of the record`)
  else add('regression', 'Regression check', model >= RULES.modelMin && !hot ? 'pass' : 'fail', hot ? `Perfect last 5, but ${longer.hits}/${longer.n} over the longer run: expect it to cool` : `${projTxt}; the projection alone gives ${pctTxt(model)} (needs ${pctTxt(RULES.modelMin)})`)

  const sev = injury?.severity || null
  const role = row.role ?? 1
  const roleOk = role >= RULES.roleMin && !SEVERE.has(sev)
  add('role', 'Role and status', roleOk ? 'pass' : 'fail', SEVERE.has(sev) ? `On the injury report: ${injury.status}` : `Role ${Math.round(role * 100)}/100${role < RULES.roleMin ? ' (snaps or targets not steady)' : ', steady'}${sev === 'probable' ? '; listed probable' : ''}`)

  // a line that moved against the side since it opened: the respected money is on the other side
  let mkt = 'pass'
  let mdetail = 'No move since it opened'
  if (row.move && row.move.delta) {
    const withUs = (row.side === 'u' ? -1 : 1) * Math.sign(row.move.delta) > 0
    const big = Math.abs(row.move.delta) >= Math.max(0.5, Math.abs(row.move.open || row.line) * 0.03)
    if (!withUs && big) mkt = 'fail'
    mdetail = `Opened ${row.move.open}, now ${row.line}: ${withUs ? 'moved toward this side' : big ? 'moved against this side' : 'small move against, inside the noise'}`
  }
  add('market', 'Market move', mkt, mdetail)

  const ok = checks.every((c) => c.state !== 'fail')
  return { ok, checks, price, implied, edge, ev, playable: playableAt(p), recency: rec }
}

function fmt(a) {
  if (a == null) return '-'
  return a > 0 ? `+${a}` : String(a)
}

const sideSign = (r) => (r.side === 'u' ? -1 : 1)
/** How two legs move together as bets (the stat correlation, flipped for unders). */
export function legCorrelation(a, b) {
  return statCorrelation(a, b) * sideSign(a) * sideSign(b)
}

const subjectOf = (r) => r.playerId || `t${r.teamId}`

/**
 * Run the rules over every row. `rows` are full prop rows (board and alternate lines) for games
 * that haven't started; `injuryOf(playerId)` gives { status, severity } or null.
 */
export function findLock(rows, { now = Date.now(), injuryOf = () => null, pool = 60, simulate = 8, iterations = 20_000, seed = 101 } = {}) {
  const funnel = { scanned: rows.length, prob: 0, sample: 0, recency: 0, regression: 0, role: 0, market: 0, edge: 0, certified: 0, priced: 0 }
  const legs = []
  const rejected = []
  for (const r of rows) {
    const c = certifyLeg(r, { now, injury: r.playerId ? injuryOf(r.playerId) : null })
    const st = Object.fromEntries(c.checks.map((x) => [x.key, x.state]))
    // the funnel counts legs still standing after each check, in the order a reader thinks
    if (st.prob !== 'pass') continue
    funnel.prob++
    if (st.sample !== 'pass') continue
    funnel.sample++
    if (st.recency !== 'pass') {
      rejected.push({ r, c })
      continue
    }
    funnel.recency++
    if (st.regression !== 'pass') {
      rejected.push({ r, c })
      continue
    }
    funnel.regression++
    if (st.role !== 'pass') {
      rejected.push({ r, c })
      continue
    }
    funnel.role++
    if (st.market !== 'pass') {
      rejected.push({ r, c })
      continue
    }
    funnel.market++
    if (st.edge === 'fail') {
      rejected.push({ r, c })
      continue
    }
    funnel.edge++
    if (st.edge === 'pass') funnel.priced++
    legs.push({ r, c })
  }
  funnel.certified = legs.length

  // the strongest legs, one line per player and market (the likeliest line wins)
  const best = new Map()
  for (const l of legs) {
    const k = `${subjectOf(l.r)}:${l.r.market}`
    const cur = best.get(k)
    if (!cur || l.r.prob > cur.r.prob || (l.r.prob === cur.r.prob && (l.c.ev ?? -1) > (cur.c.ev ?? -1))) best.set(k, l)
  }
  const top = [...best.values()].sort((a, b) => b.r.prob - a.r.prob).slice(0, pool)

  const combos = []
  let over45 = 0
  let negative = 0
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      if (subjectOf(top[i].r) === subjectOf(top[j].r)) continue
      const cij = legCorrelation(top[i].r, top[j].r)
      for (let k = j + 1; k < top.length; k++) {
        const a = top[i]
        const b = top[j]
        const c = top[k]
        if (subjectOf(c.r) === subjectOf(a.r) || subjectOf(c.r) === subjectOf(b.r)) continue
        const pa = a.r.prob
        const pb = b.r.prob
        const pc = c.r.prob
        const indep = pa * pb * pc
        if (indep < RULES.comboMin) continue
        over45++
        const cik = legCorrelation(a.r, c.r)
        const cjk = legCorrelation(b.r, c.r)
        if (Math.min(cij, cik, cjk) < RULES.corrFloor) {
          negative++
          continue
        }
        // first-order Gaussian-copula adjustment, good enough to rank before simulating
        const approx = indep + cij * dens(pa) * dens(pb) * pc + cik * dens(pa) * dens(pc) * pb + cjk * dens(pb) * dens(pc) * pa
        const priced = [a, b, c].every((x) => x.c.price != null)
        const dec = priced ? [a, b, c].reduce((d, x) => d * americanToDecimal(x.c.price), 1) : null
        const ev = dec ? approx * dec - 1 : null
        if (priced && !(ev > 0)) continue
        combos.push({ legs: [a, b, c], indep, approx, priced, dec, ev, corr: [cij, cik, cjk] })
      }
    }
  }
  funnel.combos = over45
  funnel.negative = negative
  funnel.qualified = combos.length

  // certified (priced, +EV) locks first; otherwise the best one waiting on prices
  const certified = combos.filter((x) => x.priced)
  const pick = (certified.length ? certified : combos).sort((x, y) => y.approx - x.approx || (y.ev ?? 0) - (x.ev ?? 0)).slice(0, simulate)
  let chosen = null
  for (const cand of pick) {
    const rs = cand.legs.map((l) => l.r)
    const sim = simulateSlip(rs, { iterations, seed, price: cand.dec ? decimalToAmerican(cand.dec) : null, bets: 100, bettors: 200 })
    const p = sim.parlay.hitRate
    const ev = cand.dec ? p * cand.dec - 1 : null
    if (cand.priced && !(ev > 0)) continue
    if (!chosen || p > chosen.sim.parlay.hitRate) chosen = { ...cand, sim, ev }
  }

  // close calls: 65%+ legs a single rule kept out, so the reader sees why
  const close = rejected
    .sort((a, b) => b.r.prob - a.r.prob)
    .slice(0, 8)
    .map(({ r, c }) => ({ id: r.id, name: r.name, short: r.short, label: r.label, prob: r.prob, teamAbbr: r.teamAbbr, failed: c.checks.filter((x) => x.state === 'fail').map((x) => ({ key: x.key, label: x.label, detail: x.detail })) }))

  if (!chosen) {
    const near = nearMiss(top.length ? top : legs)
    return { status: 'pass', funnel, lock: null, near, close, reason: passReason(funnel, near) }
  }

  const p = chosen.sim.parlay.hitRate
  const legsOut = chosen.legs.map((l, i) => legOut(l, chosen.sim.legs[i]))
  const pairs = []
  const L = chosen.legs
  const corr = [
    [0, 1, chosen.corr[0]],
    [0, 2, chosen.corr[1]],
    [1, 2, chosen.corr[2]],
  ]
  for (const [a, b, c] of corr) if (Math.abs(c) >= 0.03) pairs.push({ a: a + 1, b: b + 1, corr: round(c, 3), text: `${L[a].r.short || L[a].r.name} and ${L[b].r.short || L[b].r.name} tend to win together` })
  const kelly = chosen.dec ? kellyStake(p, chosen.dec) : null
  return {
    status: chosen.priced ? 'certified' : 'price_needed',
    funnel,
    close,
    lock: {
      id: legsOut.map((l) => l.id).join('~'),
      legs: legsOut,
      independent: round(chosen.indep, 4),
      simulated: round(p, 4),
      iterations: chosen.sim.iterations,
      bonus: round(p - chosen.indep, 4),
      pairs,
      price: chosen.dec ? { decimal: round(chosen.dec, 3), american: decimalToAmerican(chosen.dec), ev: round(chosen.ev, 4) } : null,
      breakEven: decimalToAmerican(1 / p),
      stake: { cap: RULES.stake.lock, kelly: kelly == null ? null : round(kelly, 4), pct: kelly == null ? RULES.stake.lock : round(Math.min(kelly, RULES.stake.lock), 4) },
    },
  }
}

function legOut(l, simLeg) {
  const r = l.r
  return {
    id: r.id,
    kind: r.kind,
    playerId: r.playerId || null,
    teamId: r.teamId || null,
    gameId: r.gameId,
    kickoff: r.kickoff,
    name: r.name,
    short: r.short,
    headshot: r.headshot || r.logo || null,
    pos: r.pos || null,
    teamAbbr: r.teamAbbr,
    oppAbbr: r.oppAbbr,
    market: r.market,
    label: r.label,
    shortLabel: r.shortLabel,
    line: r.line,
    side: r.side,
    oneSided: Boolean(r.oneSided),
    posted: r.posted ?? null,
    prob: r.prob,
    fair: r.fair,
    proj: r.proj ?? null,
    price: l.c.price,
    book: bookOf(r),
    implied: l.c.implied == null ? null : round(l.c.implied, 4),
    edge: l.c.edge == null ? null : round(l.c.edge, 4),
    ev: l.c.ev == null ? null : round(l.c.ev, 4),
    playable: l.c.playable,
    checks: l.c.checks,
    windows: r.windows,
    matchup: r.matchup || null,
    simHit: simLeg ? simLeg.hitRate : null,
  }
}

/** Quarter Kelly for a parlay at decimal odds `dec`, before the cap. */
export function kellyStake(p, dec, fraction = RULES.kelly) {
  const b = dec - 1
  if (!(b > 0)) return 0
  const f = (p * b - (1 - p)) / b
  return Math.max(0, f * fraction)
}

/** The closest thing to a lock when nothing qualifies: the three likeliest legs that fit together. */
function nearMiss(cands) {
  const picked = []
  for (const l of [...cands].sort((a, b) => b.r.prob - a.r.prob)) {
    if (picked.some((x) => subjectOf(x.r) === subjectOf(l.r))) continue
    if (picked.some((x) => legCorrelation(x.r, l.r) < RULES.corrFloor)) continue
    picked.push(l)
    if (picked.length === 3) break
  }
  if (!picked.length) return null
  const indep = picked.reduce((s, l) => s * l.r.prob, 1)
  return { legs: picked.map((l) => ({ id: l.r.id, name: l.r.name, short: l.r.short, label: l.r.label, prob: l.r.prob })), independent: round(indep, 4), short: picked.length < 3 }
}

function passReason(f, near) {
  if (!f.prob) return 'No prop on the board reaches 65% this week.'
  if (f.certified < 3) return `Only ${f.certified} leg${f.certified === 1 ? '' : 's'} passed every check. A lock needs three.`
  if (!f.combos) return `No three certified legs multiply to over 45%${near ? `; the closest is ${Math.round(near.independent * 100)}%` : ''}.`
  if (f.negative >= f.combos) return 'Every combination over 45% has legs that pull against each other.'
  return 'No combination over 45% has positive expected value at the posted prices.'
}

// The Bet Breakdown, the deterministic part: evidence records for a settled pick, the facts of
// each leg (the threshold, the final number, the distance, the status), the parlay's settlement
// under the rules it was graded by, and answers to the common follow-up questions. Code does all
// the grading checks, numbers and settlement; a language model may only re-word this (and is
// checked against it, see validate()).
//
// Three kinds of statement, kept apart everywhere: observed facts (box score, settlement),
// estimates saved when the pick was posted (never rebuilt from later data), and possible
// contributing factors (which the data alone can't prove).

export const RULES = {
  id: 'proppickz-record-v1',
  name: 'PropPickz record rules',
  parlay: 'A parlay wins only if every leg that counts wins. A leg exactly on the line is a push and drops out; a player who doesn’t play voids his leg, which also drops out; the rest pay at the prices saved when it was posted.',
  push: 'A final number exactly on the line is a push.',
  void: 'A player with no stats in the game (didn’t play) voids the leg.',
}

const OPP_LABEL = { min: 'Minutes', pf: 'Personal fouls', passAtt: 'Pass attempts', rushAtt: 'Rush attempts', tgt: 'Targets', rec: 'Receptions', toi: 'Time on ice', ab: 'At-bats', outs: 'Outs recorded', fga: 'Field goal attempts', shots: 'Shots' }
// the playing-time or volume stats worth showing next to each kind of prop
const OPP_KEYS = { basketball: ['min', 'pf', 'fga'], hockey: ['toi', 'shots'], baseball: ['ab', 'outs'], football: ['passAtt', 'rushAtt', 'tgt', 'rec'] }
const familyOf = (sport) => ({ nba: 'basketball', wnba: 'basketball', ncaab: 'basketball', nhl: 'hockey', mlb: 'baseball', nfl: 'football', ncaaf: 'football' })[sport] || 'football'

const r1 = (x) => Math.round(x * 10) / 10
const pctText = (p) => `${Math.round(p * 100)}%`
const fmtOdds = (a) => (a == null ? null : a > 0 ? `+${a}` : `${a}`)
const lineText = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1))

/** What the leg needed to win: "6 or more", "4 or fewer", "more than 24.5". */
export function neededFor(leg) {
  const L = leg.line
  if (leg.side === 'u') {
    const max = Number.isInteger(L) ? L - 1 : Math.floor(L)
    return { op: 'max', n: max, text: `${max} or fewer`, push: Number.isInteger(L) ? L : null }
  }
  const min = Number.isInteger(L) ? L + 1 : Math.floor(L) + 1
  return { op: 'min', n: min, text: `${min} or more`, push: Number.isInteger(L) ? L : null }
}

/** How far the final number was from winning (negative: short) or past it. */
export function distanceOf(leg, value) {
  if (!Number.isFinite(value)) return null
  const need = neededFor(leg)
  if (need.op === 'min') return r1(value - need.n)
  return r1(need.n - value)
}

/**
 * The evidence for a pick: one record per fact, each with where it came from and when.
 * pick: the stored pick (legs carry what was saved at posting, and their grades).
 * games: Map gameId -> { summary, retrievedAt, source, events? }
 * history: Map legIndex -> { key, label, avg, n } (the opportunity stat before this game)
 */
export function buildEvidence({ pick, games = new Map(), history = new Map(), demo = false, rules = RULES }) {
  const recs = []
  let n = 0
  const add = (r) => {
    const id = `e${++n}`
    recs.push({ id, ...r })
    return id
  }
  const src = (s) => (demo ? 'Demo data (made up)' : s)
  const legs = pick.legs.map((leg, i) => {
    const g = games.get(String(leg.gameId)) || null
    const s = g?.summary || null
    const ids = { posted: [], result: [], context: [], game: [] }
    ids.posted.push(add({ kind: 'posted', leg: i, label: 'Saved when posted', value: { line: leg.line, side: leg.side, price: leg.price ?? null, book: leg.book || null, prob: leg.prob ?? null, fair: leg.fair ?? null, proj: leg.proj ?? null, projMin: leg.projMin ?? null, inj: leg.inj?.tag || null }, source: src('PropPickz record at posting'), at: pick.createdAt || null }))
    if (leg.close && (leg.close.price != null || leg.close.line != null)) ids.posted.push(add({ kind: 'close', leg: i, label: 'Closing line', value: { price: leg.close.price ?? null, line: leg.close.line ?? leg.line }, source: src('PropPickz closing snapshot'), at: leg.close.at || null }))
    if (s?.status) {
      const home = s.home || {}
      const away = s.away || {}
      const ot = familyOf(leg.sport) === 'basketball' ? (s.status.period || 0) > 4 : familyOf(leg.sport) === 'football' ? (s.status.period || 0) > 4 : familyOf(leg.sport) === 'hockey' ? (s.status.period || 0) > 3 : (s.status.period || 0) > 9
      ids.game.push(add({ kind: 'game', leg: i, label: 'Final score', value: { home: home.abbr || null, homeScore: home.score ?? null, away: away.abbr || null, awayScore: away.score ?? null, overtime: Boolean(ot), state: s.status.state }, source: src(g.source || 'ESPN game summary'), at: g.retrievedAt || null }))
    }
    if (leg.result) {
      ids.result.push(add({ kind: 'final_stat', leg: i, label: 'Final number', value: { value: leg.value ?? null, result: leg.result }, source: src(g?.source ? `${g.source} box score` : 'ESPN box score'), at: pick.gradedAt || g?.retrievedAt || null }))
    }
    const box = s?.players?.[leg.playerId]?.stats || null
    if (box) {
      for (const k of OPP_KEYS[familyOf(leg.sport)] || []) {
        if (box[k] == null) continue
        ids.context.push(add({ kind: 'opportunity', leg: i, label: OPP_LABEL[k] || k, value: { key: k, value: box[k] }, source: src(g?.source ? `${g.source} box score` : 'ESPN box score'), at: g?.retrievedAt || null }))
      }
    }
    const h = history.get(i)
    if (h && Number.isFinite(h.avg) && h.n >= 3) ids.context.push(add({ kind: 'history', leg: i, label: `${OPP_LABEL[h.key] || h.key} per game before this one`, value: { key: h.key, avg: r1(h.avg), n: h.n }, source: src('ESPN game logs'), at: h.at || null }))
    for (const ev of g?.events?.[leg.playerId] || []) ids.context.push(add({ kind: 'event', leg: i, label: ev.label, value: { text: ev.text, period: ev.period ?? null, clock: ev.clock ?? null }, source: src(g?.source || 'Play-by-play'), at: ev.at || g?.retrievedAt || null }))
    return { leg, ids }
  })
  const settleId = pick.status === 'graded' ? add({ kind: 'settlement', label: 'Recorded settlement', value: { result: pick.result, profit: pick.profit ?? null, units: pick.units ?? null, decimal: pick.decimal ?? null }, source: src('PropPickz grading'), at: pick.gradedAt || null }) : null
  const rulesId = add({ kind: 'rules', label: rules.name, value: { id: rules.id, text: rules.parlay }, source: 'PropPickz', at: null })
  return { records: recs, legs, settleId, rulesId }
}

/** Evidence completeness for a leg, separate from any estimate. */
export function evidenceStatus(leg, ids, hasGame, events = 0) {
  if (!leg.result) return 'awaiting'
  if (leg.result === 'void') return ids.context.length ? 'partial' : 'unavailable'
  if (!hasGame || !ids.result.length) return 'unavailable'
  // a miss is only fully explained with something from the game itself, not just the box score
  if (ids.context.length && (leg.result !== 'loss' || events > 0)) return 'complete'
  return 'partial'
}

const RESULT_WORD = { win: 'won', loss: 'missed', push: 'pushed', void: 'was voided' }

/** One leg's facts and its plain-English explanation (template, no model). */
function legFacts(entry, index, recs) {
  const { leg, ids } = entry
  const rec = (id) => recs.find((r) => r.id === id)
  const need = neededFor(leg)
  const value = Number.isFinite(leg.value) ? leg.value : null
  const dist = distanceOf(leg, value)
  const who = leg.short || leg.name
  const sel = `${who} ${leg.label}`
  const status = leg.result || 'pending'
  const lines = []
  const facts = []
  const factors = []
  if (status === 'pending') lines.push(`${sel} hasn’t been graded yet.`)
  else if (status === 'void') lines.push(`${sel} was voided: ${RULES.void.toLowerCase().replace(/\.$/, '')}.`)
  else if (status === 'push') lines.push(`${sel} landed exactly on ${lineText(leg.line)}, a push, so it dropped out of the parlay.`)
  else {
    const verb = status === 'win' ? 'won' : 'missed'
    const gap = dist == null ? '' : dist >= 0 ? (dist === 0 ? ', right on the number it needed' : `, ${lineText(dist)} past what it needed`) : `, ${lineText(-dist)} short`
    lines.push(`${sel} ${verb}: it needed ${need.text}, and the final number was ${value}${gap}.`)
  }
  for (const id of ids.context) {
    const r = rec(id)
    if (r.kind === 'opportunity') facts.push(`${r.label}: ${r.value.value}`)
    if (r.kind === 'history') facts.push(`${r.label}: ${r.value.avg} (${r.value.n} games)`)
    if (r.kind === 'event') facts.push(r.value.text)
  }
  // a possible factor, said as one: playing time well under what was expected, on a miss
  const mins = ids.context.map(rec).find((r) => r.kind === 'opportunity' && ['min', 'toi'].includes(r.value.key))
  const hist = ids.context.map(rec).find((r) => r.kind === 'history' && mins && r.value.key === mins.value.key)
  const proj = ids.posted.map(rec).find((r) => r.kind === 'posted')?.value
  const events = ids.context.map(rec).filter((r) => r.kind === 'event')
  if (status === 'loss' && events.length) factors.push(`The event log records ${events.map((e) => e.value.text).join('; ')}.`)
  const expected = proj?.projMin != null && mins?.value.key === 'min' ? { n: proj.projMin, text: `the saved ${proj.projMin}-minute projection` } : hist ? { n: hist.value.avg, text: `his ${hist.value.avg}-minute average before this game` } : null
  if (status === 'loss' && mins && expected && Number(mins.value.value) < expected.n * 0.85) {
    const unit = String(leg.label || '').replace(/^(over|under)\s+[\d.]+\s+/i, '').toLowerCase() || 'of the stat'
    const short = dist != null && dist < 0 ? `the ${lineText(-dist)} more ${unit} it needed` : 'a different result'
    factors.push(`He finished with ${mins.value.value} minutes, below ${expected.text}. Less playing time meant fewer chances. The data doesn’t establish that more minutes would have produced ${short}.`)
    if (!events.length) factors.push('Why his minutes were down isn’t in the data: only the box score is available for this game.')
  }
  return {
    index,
    who,
    name: leg.name,
    label: leg.label,
    sport: leg.sport || 'nfl',
    kickoff: Number.isFinite(leg.kickoff) ? leg.kickoff : null,
    headshot: leg.headshot || null,
    market: leg.market,
    line: leg.line,
    side: leg.side,
    price: leg.price ?? null,
    book: leg.book || null,
    status,
    value,
    needed: need.text,
    distance: dist,
    preBet: { prob: proj?.prob ?? null, fair: proj?.fair ?? null, proj: proj?.proj ?? null, inj: proj?.inj ?? null, saved: Boolean(proj && proj.prob != null) },
    explanation: lines.join(' '),
    facts,
    factors,
    evidence: [...ids.result, ...ids.context, ...ids.game, ...ids.posted],
    evidenceStatus: evidenceStatus(leg, ids, ids.game.length > 0, events.length),
  }
}

/** The parlay as a whole: why it settled the way it did, under the rules it was graded by. */
function parlayFacts(pick, legs, settleId, rulesId) {
  const count = (s) => legs.filter((l) => l.status === s).length
  const w = count('win')
  const l = count('loss')
  const p = count('push')
  const v = count('void')
  const pending = count('pending')
  const single = legs.length === 1
  const nWord = (k) => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'][k] || String(k)
  let text
  if (pending || pick.status !== 'graded') text = 'Awaiting confirmation: not every leg is graded yet, so there’s no settlement to explain.'
  else if (single) text = legs[0].status === 'win' ? 'The bet won.' : legs[0].status === 'loss' ? 'The bet lost.' : legs[0].status === 'push' ? 'The bet pushed: stake back.' : 'The bet was voided: stake back.'
  else if (l > 0) {
    const missed = legs.filter((x) => x.status === 'loss').map((x) => `${x.who}’s ${x.label}`)
    text = `${nWord(w)} ${w === 1 ? 'leg' : 'legs'} won and ${nWord(l).toLowerCase()} missed (${missed.join(', ')}). In a parlay every leg that counts has to win, so one miss loses the whole bet.`
  } else if (w > 0) text = `Every leg that counted won${p + v ? `; ${p + v} dropped out (push or void) and the rest paid at their saved prices` : ''}.`
  else text = 'Every leg pushed or was voided, so the stake came back.'
  return {
    type: single ? 'single' : 'parlay',
    counts: { win: w, loss: l, push: p, void: v, pending },
    result: pick.status === 'graded' ? pick.result : 'pending',
    profit: pick.profit ?? null,
    units: pick.units ?? null,
    text,
    rule: RULES.parlay,
    rulesId,
    settlementId: settleId,
    awaiting: pending > 0 || pick.status !== 'graded',
  }
}

/** The report: facts first, then what's uncertain, then what one might take from it. */
export function buildReport({ pick, evidence, demo = false }) {
  const legs = evidence.legs.map((e, i) => legFacts(e, i, evidence.records))
  const parlay = parlayFacts(pick, legs, evidence.settleId, evidence.rulesId)
  const limitations = []
  if (legs.some((l) => l.evidenceStatus !== 'complete')) limitations.push('Some legs only have the final box score, so the cause of a miss can’t be established from the data.')
  if (legs.some((l) => !l.preBet.saved)) limitations.push('No estimate was saved for some legs when the pick was posted, so there’s no pre-bet number to compare with.')
  limitations.push('One result can’t show whether an estimate was good or bad; only many graded picks can.')
  const takeaways = []
  if (parlay.type === 'parlay' && legs.length >= 3) takeaways.push('Each extra leg is one more thing that has to go right; the saved chances multiply only if the legs are independent.')
  if (legs.some((l) => l.factors.length)) takeaways.push('Playing time drives most counting stats. A late lineup or minutes note is worth checking before a game.')
  takeaways.push('Looking back, a result can make a choice look obvious that wasn’t knowable when the pick was made.')
  return {
    v: 1,
    demo,
    pickId: pick.id,
    postedAt: pick.createdAt || null,
    gradedAt: pick.gradedAt || null,
    summary: parlay.text,
    legs,
    parlay,
    limitations,
    takeaways,
    evidence: evidence.records,
    rules: RULES,
  }
}

/** A fingerprint of the settlement: when a correction changes a grade, the report is out of date. */
export function settlementHash(pick) {
  const s = JSON.stringify([pick.status, pick.result, pick.profit, pick.legs.map((l) => [l.id, l.result || null, l.value ?? null])])
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

// ---- checking what a language model wrote ------------------------------------------------------
const BANNED = [
  /\bbad luck\b|\bunlucky\b|\bluck\b.*\d+\s*%|\d+\s*%[^.]*\b(luck|variance|game script|selection)\b/i,
  /\bguarantee/i,
  /\bchase\b|\bwin (it|that|your money) back\b|\brecover (your|the) (loss|money)\b|\bincrease (your )?stakes?\b|\bbet (more|again|bigger)\b|\bnext bet\b/i,
  /\bshould have (bet|taken|removed|left out)\b/i,
]
const UNSUPPORTED = [
  [/\binjur/i, ['injury']],
  [/\bcoach/i, ['coach']],
  [/\bweather|\brain\b|\bwind\b|\bsnow\b/i, ['weather']],
  [/target share/i, ['target share']],
  [/\bdefensive assignment|\bcovered by\b|\bshadow(ed)? by\b/i, ['assignment']],
  [/["“][^"”]{12,}["”]/, ['quote']],
]

// ids and timestamps aren't numbers anyone should quote
const SKIP_KEYS = new Set(['id', 'evidence', 'findingEvidence', 'rulesId', 'settlementId', 'pickId', 'at', 'postedAt', 'gradedAt', 'createdAt', 'index', 'leg', 'v'])

/** Every number a text may use: the ones in the evidence and the report, and small counts. */
export function allowedNumbers(report) {
  const set = new Set()
  const walk = (v) => {
    if (v == null) return
    if (typeof v === 'number' && Number.isFinite(v)) {
      set.add(String(v))
      set.add(String(Math.abs(v)))
      set.add(String(Math.round(v * 100)))
      set.add(String(Math.abs(Math.round(v * 100))))
    } else if (typeof v === 'string') for (const m of v.match(/-?\d+(?:\.\d+)?/g) || []) set.add(m.replace(/^-/, ''))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k)) walk(x)
  }
  walk(report)
  // counting the legs themselves ("1 of 3 legs") is fine
  for (let i = 0; i <= (report.legs?.length || 0); i++) set.add(String(i))
  return set
}

/**
 * Check a model's answer against the report: the shape, every number, every evidence id, no
 * advice to chase, no luck percentages, no claims about things the evidence doesn't have.
 * Returns { ok, reasons }.
 */
export function validate(out, report) {
  const reasons = []
  if (!out || typeof out !== 'object') return { ok: false, reasons: ['not an object'] }
  const texts = []
  if (typeof out.summary !== 'string' || !out.summary.trim()) reasons.push('no summary')
  else texts.push(out.summary)
  const ids = new Set(report.evidence.map((r) => r.id))
  if (!Array.isArray(out.legs)) reasons.push('no legs')
  else
    for (const f of out.legs) {
      if (!Number.isInteger(f?.index) || !report.legs[f.index]) reasons.push('a finding for no leg')
      if (typeof f?.finding !== 'string') reasons.push('a finding without text')
      else texts.push(f.finding)
      const cited = Array.isArray(f?.evidence) ? f.evidence : []
      if (!cited.length) reasons.push(`leg ${f?.index} cites nothing`)
      for (const id of cited) if (!ids.has(id)) reasons.push(`unknown evidence ${id}`)
    }
  for (const k of ['limitations', 'takeaways']) if (Array.isArray(out[k])) texts.push(...out[k].filter((x) => typeof x === 'string'))
  const allowed = allowedNumbers(report)
  const kinds = new Set(report.evidence.map((r) => `${r.kind} ${r.label} ${JSON.stringify(r.value)}`.toLowerCase()))
  const have = (word) => [...kinds].some((k) => k.includes(word))
  for (const t of texts) {
    for (const m of t.match(/\d+(?:\.\d+)?/g) || []) if (!allowed.has(m)) reasons.push(`number ${m} isn’t in the evidence`)
    for (const re of BANNED) if (re.test(t)) reasons.push(`banned: ${re.source.slice(0, 30)}`)
    for (const [re, words] of UNSUPPORTED) if (re.test(t) && !words.some(have)) reasons.push(`unsupported claim (${words[0]})`)
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)].slice(0, 12) }
}

// ---- follow-up questions, answered from the report ------------------------------------------------
const INTENTS = [
  ['missed', /which leg|what leg|by how much|how close|missed by|how far/i],
  ['changed', /what changed|during the game|in.?game|what happened/i],
  ['knowable', /before i (placed|posted|made)|available before|known before|knowable|at the time/i],
  ['calibration', /calibrat|normal variation|variance|was the (estimate|model|number)|poorly|just bad/i],
  ['together', /same game|depend|correlat|together|related|connected/i],
]
export function intentOf(q) {
  for (const [k, re] of INTENTS) if (re.test(q)) return k
  return null
}

/**
 * Answer a follow-up from the report alone. calibration: { band, hit, n } for the legs' estimates
 * over graded history, when there's enough of it. Returns { intent, text, evidence } or null.
 */
export function answer(report, q, { calibration = [] } = {}) {
  const intent = intentOf(String(q || ''))
  const legs = report.legs
  if (intent === 'missed') {
    const missed = legs.filter((l) => l.status === 'loss')
    if (!missed.length) return { intent, text: report.parlay.awaiting ? 'Not every leg is graded yet.' : 'No leg missed.', evidence: [] }
    return { intent, text: missed.map((l) => `${l.who}’s ${l.label} missed: it needed ${l.needed} and finished at ${l.value}${l.distance != null ? `, ${lineText(Math.abs(l.distance))} short` : ''}.`).join(' '), evidence: missed.flatMap((l) => l.evidence.slice(0, 2)) }
  }
  if (intent === 'changed') {
    const withCtx = legs.filter((l) => l.facts.length)
    if (!withCtx.length) return { intent, text: 'Only the final box score is on record for this bet, so how the game unfolded isn’t available.', evidence: [] }
    return { intent, text: withCtx.map((l) => `${l.who}: ${l.facts.join('; ')}.`).join(' '), evidence: withCtx.flatMap((l) => l.evidence) }
  }
  if (intent === 'knowable') {
    const saved = legs.filter((l) => l.preBet.saved)
    const head = report.postedAt ? 'When the pick was posted' : 'When the pick was made'
    const parts = saved.map((l) => `${l.who}: the saved estimate was ${pctText(l.preBet.prob)}${l.preBet.inj ? `, listed ${l.preBet.inj}` : ', not on the injury report'}`)
    const tail = 'Playing time, fouls and the final numbers happened during the game, so they weren’t knowable then.'
    return { intent, text: saved.length ? `${head}: ${parts.join('; ')}. ${tail}` : `No estimate was saved when this pick was posted. ${tail}`, evidence: legs.flatMap((l) => l.evidence.filter((id) => report.evidence.find((r) => r.id === id)?.kind === 'posted')) }
  }
  if (intent === 'calibration') {
    const enough = calibration.filter((c) => c.n >= 100)
    const one = 'One result can’t show whether an estimate was well calibrated.'
    if (!enough.length) return { intent, text: `${one} There aren’t enough graded legs at these estimates yet to say more; the Calibration page tracks it as they come in.`, evidence: [] }
    return { intent, text: `${one} Over graded history, ${enough.map((c) => `legs estimated at ${c.band} won ${pctText(c.hit)} of ${c.n.toLocaleString('en-US')}`).join('; ')}. A miss at those numbers is within what the record shows.`, evidence: [] }
  }
  if (intent === 'together') {
    const byGame = new Map()
    legs.forEach((l, i) => {
      const g = report.evidence.find((r) => r.kind === 'game' && r.leg === i)
      const k = g ? `${g.value.away}@${g.value.home}` : `leg${i}`
      byGame.set(k, [...(byGame.get(k) || []), l])
    })
    const shared = [...byGame.values()].filter((x) => x.length > 1)
    const base = 'No joint estimate for these legs was saved when the pick was posted, so how much they depended on each other isn’t on record.'
    if (!shared.length) return { intent, text: `The legs were in different games. ${base}`, evidence: [] }
    const names = (x) => (x.length > 2 ? `${x.slice(0, -1).map((l) => l.who).join(', ')} and ${x[x.length - 1].who}` : x.map((l) => l.who).join(' and '))
    return { intent, text: `${shared.map((x) => `${names(x)} played in the same game, so the same game conditions could have affected ${x.length > 2 ? 'all of them' : 'both'}`).join('; ')}. ${base}`, evidence: [] }
  }
  return null
}

export const SUGGESTED = ['Which leg missed, and by how much?', 'What changed during the game?', 'Was that information available before I placed the bet?', 'Was the estimate off, or could this be normal variation?', 'Did these legs depend on the same game conditions?']

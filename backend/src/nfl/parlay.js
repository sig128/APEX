// Parlay check: a slip (from the board, typed out, or a screenshot of a betslip) read leg by
// leg. The legs are matched to the Propify board, played out in the simulator, scored, and then
// the AI says which to keep, which to cut and why, grounded in those numbers.
import { MARKETS, FOOTBALL_MARKETS, marketOf } from './markets.js'
import { parsePropId } from './analytics/core.js'
import { simulateSlip } from './analytics/sim.js'
import { _brief } from './ai.js'
import { nameKey } from '../lib/util.js'
import { certifyLeg } from './analytics/lock.js'
import { RULES, RULES_PROMPT } from './rules.js'
import { log, errText } from '../lib/log.js'

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
export const MAX_IMAGE_CHARS = 1_600_000 // base64, about 1.2 MB
export const MAX_TEXT = 4000
const MAX_LEGS = 12

const marketList = (markets) =>
  Object.entries({ ...markets, teamPts: { long: 'Team Total' } })
    .map(([k, m]) => `${k} = ${m.long || m.label}`)
    .join('; ')

const NFL_SPORT = { title: 'NFL', fam: { MARKETS: FOOTBALL_MARKETS } }
const extractSystem = (sport = NFL_SPORT) => `You read sports betslips. Extract every ${sport.title} leg from the user's betslip (a screenshot or pasted text).
Reply with JSON only, no prose, in exactly this shape:
{"legs":[{"player":"Full Name","team":"DET or null","market":"<key>","side":"o or u","line":245.5,"odds":-115}],"parlayOdds":600,"notes":"anything you could not read"}
Rules:
- market must be one of these keys: ${marketList(sport.fam?.MARKETS || MARKETS)}. Use "teamPts" with player = the team name for team totals.
- side "o" for over, more than, or "+" style (e.g. "250+ yards" means over 249.5); "u" for under. Anytime TD is side "o", line 0.5; 2+ TDs is line 1.5.
- line is the number on the slip. For "X+" milestones use X - 0.5.
- odds: the leg's American odds if shown, else null. parlayOdds: the whole slip's American odds if shown, else null.
- Skip moneylines, spreads and game totals; mention them in notes.
- If it isn't a betslip, return {"legs":[],"parlayOdds":null,"notes":"not a betslip"}.`

export const checkSystem = (sport = NFL_SPORT) => `You are Propify ${sport.title} Betting Intelligence (SLCM v1.0) reviewing a parlay before it's placed, leg by leg.

For every leg decide, holding it to the Propify rules and the rule checks you are given:
- KEEP: it passes the rules (65%+ to win, an edge over the price or a price to beat, a real sample, recent form that agrees, a projection that backs it, a steady role, the market not against it).
- CUT: it fails a rule that matters (under 65%, no edge at this price, thin sample, cold recent form, a streak the projection doesn't back, role or injury doubt, the line moving against it, or it pulls against another leg).
- SWAP: the player is fine but this exact bet isn't; name the better bet from the alternatives given (an easier line, the other side, or another prop on him).
Use only the data given plus general football knowledge. Cite the numbers. One reason per leg, under 30 words, plain words a casual bettor understands (say "hits 6 of his last 10", not jargon).

Then:
OVERALL: two sentences: is this parlay worth playing, and what's the biggest risk.
BEST: the version to play, e.g. "Legs 1 + 3 as a 2-leg (Propify 41%, fair +144)". If none, say "Pass".

Answer in exactly this shape, plain text, no markdown:
LEG 1: KEEP | <reason>
LEG 2: CUT | <reason>
...
OVERALL: <text>
BEST: <text>

Sizing in BEST: a 3-leg parlay at most ${RULES.stake.lock * 100}% of bankroll, a single at most ${RULES.stake.single * 100}%.
This is analysis, not advice. Never promise a win.

${RULES_PROMPT}`
export const CHECK_SYSTEM = checkSystem()

function parseJsonLoose(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Screenshot or text -> [{ player, team, market, side, line, odds }], parlayOdds, notes. */
export async function extractLegs({ ai, text, image, sport }) {
  const content = []
  if (image) content.push({ type: 'image', mediaType: image.type, data: image.data })
  content.push({ type: 'text', text: text ? `Betslip text:\n${text}` : 'Extract the legs from this betslip.' })
  const out = await ai.complete({ feature: 'parlay', system: extractSystem(sport || NFL_SPORT), messages: [{ role: 'user', content }], maxTokens: 1200 })
  const json = parseJsonLoose(out.text)
  if (!json || !Array.isArray(json.legs)) return { legs: [], parlayOdds: null, notes: 'Could not read that betslip.' }
  const legs = json.legs
    .slice(0, MAX_LEGS)
    .map((l) => ({
      player: String(l.player || '').slice(0, 60),
      team: l.team ? String(l.team).slice(0, 4).toUpperCase() : null,
      market: marketOf(l.market) && (l.market === 'teamPts' || (sport?.fam?.MARKETS || MARKETS)[l.market]) ? l.market : null,
      side: l.side === 'u' ? 'u' : 'o',
      line: Number(l.line),
      odds: Number.isFinite(Number(l.odds)) && Math.abs(Number(l.odds)) >= 100 ? Math.round(Number(l.odds)) : null,
    }))
    .filter((l) => l.player && l.market && Number.isFinite(l.line))
  const parlayOdds = Number.isFinite(Number(json.parlayOdds)) && Math.abs(Number(json.parlayOdds)) >= 100 ? Math.round(Number(json.parlayOdds)) : null
  return { legs, parlayOdds, notes: json.notes ? String(json.notes).slice(0, 300) : '' }
}

/** Find extracted legs on the board: player by name (and team when given), then the exact line. */
export function matchLegs(extracted, engine) {
  const wh = engine.wh
  const players = [...wh.players.values()]
  const teams = [...wh.teams.values()]
  const out = []
  const unmatched = []
  for (const l of extracted) {
    let subject = null
    if (l.market === 'teamPts') {
      const key = nameKey(l.player)
      const t = teams.find((x) => nameKey(x.name) === key || nameKey(x.short || '') === key || String(x.abbr || '').toUpperCase() === l.team || nameKey(x.name).endsWith(key))
      subject = t ? `t${t.id}` : null
    } else {
      const key = nameKey(l.player)
      const last = key.split(' ').pop()
      let cands = players.filter((p) => nameKey(p.name) === key)
      if (!cands.length) cands = players.filter((p) => nameKey(p.name).endsWith(` ${last}`) && (!l.team || wh.teamAbbr?.(p.teamId) === l.team))
      if (cands.length > 1 && l.team) cands = cands.filter((p) => wh.teamAbbr?.(p.teamId) === l.team)
      subject = cands.length === 1 ? cands[0].id : null
    }
    const mk = marketOf(l.market)
    const line = mk?.oneSided ? mk.fixedLine : Math.round(l.line * 2) / 2
    const id = subject ? `${subject}.${l.market}.${mk?.oneSided ? 'o' : l.side}.${line}` : null
    const row = id && parsePropId(id) ? engine.views.findProp(id) : null
    if (row) out.push({ id: row.id, odds: l.odds })
    else unmatched.push({ ...l, marketLabel: (mk?.long || mk?.label || l.market).toLowerCase(), why: subject ? 'no numbers for that bet on this slate' : 'player not found on this slate' })
  }
  return { matched: out, unmatched }
}

/** The Propify rule checks for one leg at the slip's price, plus a quick lean before the AI weighs in. */
export function scoreLeg(row, odds, sim, { now = Date.now(), injury = null } = {}) {
  const priced = Number.isFinite(odds) ? { ...row, price: row.oneSided ? { yes: odds } : row.side === 'u' ? { under: odds } : { over: odds } } : row
  const c = certifyLeg(priced, { now, injury })
  const failed = c.checks.filter((x) => x.state === 'fail')
  const lean = c.ok ? 'keep' : row.prob < 0.5 || failed.some((f) => f.key === 'edge') || failed.length >= 3 ? 'cut' : 'risky'
  return { lean, flags: failed.map((f) => f.label), checks: c.checks, implied: c.implied, edge: c.edge, ev: c.ev, playable: c.playable, killsAlone: sim?.onlyMiss ?? null }
}

function legBrief(i, ctx, odds, s, sim) {
  const r = ctx.prop
  const alts = (ctx.others || []).slice(0, 3).map((o) => `${o.label} (Propify ${(o.prob * 100).toFixed(0)}%)`)
  const altLines = (ctx.alts || []).slice(0, 3).map((a) => `line ${a.line} (Propify ${(a.prob * 100).toFixed(0)}%)`)
  return [
    `LEG ${i + 1}`,
    _brief(ctx),
    odds != null && s.implied != null ? `SLIP PRICE: ${odds > 0 ? `+${odds}` : odds} (implies ${(s.implied * 100).toFixed(1)}%, Propify edge ${(s.edge * 100).toFixed(1)} pts)` : 'SLIP PRICE: none shown',
    `SIMULATED: hits ${(sim.hitRate * 100).toFixed(1)}% of runs; the only miss that sinks the parlay in ${(sim.onlyMiss * 100).toFixed(1)}%`,
    `PROPIFY RULE CHECKS: ${s.checks.map((c) => `${c.label} ${c.state.toUpperCase()} (${c.detail})`).join('; ')}`,
    alts.length || altLines.length ? `ALTERNATIVES: ${[...altLines, ...alts].join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Stream the check as NDJSON: { type:'legs' } (cards with a quick lean) and { type:'sim' } right
 * away, then the AI's text. Returns { produced } for the allowance refund.
 */
export async function streamParlayCheck({ engine, matched, unmatched = [], parlayOdds = null, notes = '', res, ai }) {
  const sport = engine.sport || NFL_SPORT
  // each leg is read on its own league's board (a slip can mix leagues)
  const legs = matched.map((m) => ({ m, eng: m.eng || engine })).map((x) => ({ ...x, c: x.eng.views.propContext(x.m.id) })).filter((x) => x.c)
  const ctxs = legs.map((x) => x.c)
  const rows = ctxs.map((c) => c.prop)
  matched = legs.map((x) => x.m)
  const leagues = new Set(legs.map((x) => x.m.key || sport.key || 'nfl'))
  // games, teams and players are told apart by league, so legs from two leagues never share a factor
  const tag = (k, v) => (v == null || leagues.size < 2 ? v : `${k}:${v}`)
  const simRows = rows.map((r, i) => {
    const k = legs[i].m.key || sport.key || 'nfl'
    return leagues.size < 2 ? r : { ...r, gameId: tag(k, r.gameId), teamId: tag(k, r.teamId), oppId: tag(k, r.oppId), playerId: tag(k, r.playerId) }
  })
  const write = (o) => {
    try {
      res.write(`${JSON.stringify(o)}\n`)
    } catch {
      /* client left */
    }
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  let text = ''
  try {
    const sim = rows.length ? simulateSlip(simRows, { iterations: 20_000, price: parlayOdds, bets: 100, seed: 17 }) : null
    const scores = rows.map((r, i) => scoreLeg(r, matched[i].odds, sim?.legs[i], { injury: r.playerId ? legs[i].eng.wh.injuryOf?.(r.playerId) : null }))
    write({
      type: 'legs',
      legs: rows.map((r, i) => ({ n: i + 1, id: r.id, sport: matched[i].key || sport.key || 'nfl', name: r.name, short: r.short, headshot: r.headshot || null, teamAbbr: r.teamAbbr, oppAbbr: r.oppAbbr, label: r.label, prob: r.prob, fair: r.fair, odds: matched[i].odds, l10: r.windows?.find((w) => w.key === 'L10') || null, ...scores[i] })),
      unmatched,
      notes,
    })
    if (sim) write({ type: 'sim', parlay: sim.parlay, price: sim.price, iterations: sim.iterations, legs: sim.legs.map((l) => ({ id: l.id, hitRate: l.hitRate, onlyMiss: l.onlyMiss })) })
    if (!rows.length) {
      write({ type: 'complete', text: '' })
      return { produced: false }
    }
    if (!ai?.ready()) {
      write({ type: 'error', error: 'AI is not configured on this server (OPENAI_API_KEY).' })
      return { produced: false }
    }
    const brief = [
      `PARLAY: ${rows.length} legs${parlayOdds != null ? ` at ${parlayOdds > 0 ? `+${parlayOdds}` : parlayOdds} (implies ${(sim.price.implied * 100).toFixed(1)}%)` : ''}.`,
      `SIMULATED ${sim.iterations} times: cashes ${(sim.parlay.hitRate * 100).toFixed(1)}% (legs multiplied: ${(sim.parlay.independent * 100).toFixed(1)}%; the lock rule wants every leg at 65%+ and three legs over 45% multiplied).`,
      sim.parlay.correlated.length ? `LEGS THAT MOVE TOGETHER: ${sim.parlay.correlated.map((c) => `leg ${rows.findIndex((r) => r.id === c.a) + 1} & leg ${rows.findIndex((r) => r.id === c.b) + 1} ${c.together > 0 ? 'win together' : 'pull against each other'}`).join('; ')}` : '',
      unmatched.length ? `NOT ON THE BOARD (mention briefly, no verdict): ${unmatched.map((u) => `${u.player} ${u.market} ${u.side} ${u.line}`).join('; ')}` : '',
      '',
      ...ctxs.map((c, i) => legBrief(i, c, matched[i].odds, scores[i], sim.legs[i])),
    ]
      .filter((x) => x !== '')
      .join('\n\n')
    write({ type: 'start', model: ai.model('parlay') })
    const stop = new AbortController()
    res.on?.('close', () => stop.abort())
    const out = await ai.stream({
      feature: 'parlay',
      system: checkSystem(sport),
      messages: [{ role: 'user', content: brief }],
      maxTokens: 1400,
      signal: stop.signal,
      onText: (d) => {
        text += d
        write({ type: 'text_delta', text: d })
      },
    })
    write({ type: 'complete', text, stop_reason: out.stop ?? null })
    return { produced: text.trim().length > 0 }
  } catch (e) {
    log.warn('parlay check failed', { err: errText(e) })
    write({ type: 'error', error: 'The parlay check failed. Your allowance was not used.' })
    return { produced: text.trim().length > 0 }
  } finally {
    try {
      res.end()
    } catch {
      /* gone */
    }
  }
}

export function cleanImage(img) {
  if (!img || typeof img !== 'object') return null
  const type = String(img.type || '').toLowerCase()
  const data = String(img.data || '').replace(/^data:[^,]+,/, '')
  if (!IMAGE_TYPES.has(type) || !data || data.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=\s]+$/.test(data)) return null
  return { type, data: data.replace(/\s+/g, '') }
}

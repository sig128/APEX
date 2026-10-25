// Parlay check: a slip (from the board, typed out, or a screenshot of a betslip) read leg by
// leg. The legs are matched to the APEX board, played out in the simulator, scored, and then
// the AI says which to keep, which to cut and why, grounded in those numbers.
import Anthropic from '@anthropic-ai/sdk'
import { MARKETS, marketOf } from './markets.js'
import { parsePropId } from './analytics/core.js'
import { simulateSlip } from './analytics/sim.js'
import { _brief } from './ai.js'
import { nameKey } from '../lib/util.js'
import { log, errText } from '../lib/log.js'

const MODEL = () => process.env.ANTHROPIC_PARLAY_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
export const MAX_IMAGE_CHARS = 1_600_000 // base64, about 1.2 MB
export const MAX_TEXT = 4000
const MAX_LEGS = 12

const MARKET_LIST = Object.entries({ ...MARKETS, teamPts: { long: 'Team Total Points' } })
  .map(([k, m]) => `${k} = ${m.long || m.label}`)
  .join('; ')

const EXTRACT_SYSTEM = `You read sports betslips. Extract every NFL leg from the user's betslip (a screenshot or pasted text).
Reply with JSON only, no prose, in exactly this shape:
{"legs":[{"player":"Full Name","team":"DET or null","market":"<key>","side":"o or u","line":245.5,"odds":-115}],"parlayOdds":600,"notes":"anything you could not read"}
Rules:
- market must be one of these keys: ${MARKET_LIST}. Use "teamPts" with player = the team name for team totals.
- side "o" for over, more than, or "+" style (e.g. "250+ yards" means over 249.5); "u" for under. Anytime TD is side "o", line 0.5; 2+ TDs is line 1.5.
- line is the number on the slip. For "X+" milestones use X - 0.5.
- odds: the leg's American odds if shown, else null. parlayOdds: the whole slip's American odds if shown, else null.
- Skip moneylines, spreads and game totals; mention them in notes.
- If it isn't a betslip, return {"legs":[],"parlayOdds":null,"notes":"not a betslip"}.`

export const CHECK_SYSTEM = `You are APEX NFL Betting Intelligence (SLCM v1.0) reviewing a parlay before it's placed, leg by leg.

For every leg decide:
- KEEP: the numbers back it (APEX probability, hit rates, role, matchup, price).
- CUT: it drags the parlay down (low probability for its price, thin sample, bad matchup, injury risk, role in doubt, or it fights another leg).
- SWAP: the player is fine but this exact bet isn't; name the better bet from the alternatives given (other side, other line, or another prop on him).
Use only the data given plus general football knowledge. Cite the numbers. One reason per leg, under 30 words, plain words a casual bettor understands (say "hits 6 of his last 10", not jargon).

Then:
OVERALL: two sentences: is this parlay worth playing, and what's the biggest risk.
BEST: the version to play, e.g. "Legs 1 + 3 as a 2-leg (APEX 41%, fair +144)". If none, say "Pass".

Answer in exactly this shape, plain text, no markdown:
LEG 1: KEEP | <reason>
LEG 2: CUT | <reason>
...
OVERALL: <text>
BEST: <text>

This is analysis, not advice. Never promise a win.`

const anthropicClient = (apiKey) => new Anthropic({ apiKey })

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
export async function extractLegs({ apiKey, text, image }) {
  const content = []
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } })
  content.push({ type: 'text', text: text ? `Betslip text:\n${text}` : 'Extract the legs from this betslip.' })
  const msg = await anthropicClient(apiKey).messages.create({ model: MODEL(), max_tokens: 1200, system: EXTRACT_SYSTEM, messages: [{ role: 'user', content }] })
  const raw = (msg?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  const json = parseJsonLoose(raw)
  if (!json || !Array.isArray(json.legs)) return { legs: [], parlayOdds: null, notes: 'Could not read that betslip.' }
  const legs = json.legs
    .slice(0, MAX_LEGS)
    .map((l) => ({
      player: String(l.player || '').slice(0, 60),
      team: l.team ? String(l.team).slice(0, 4).toUpperCase() : null,
      market: marketOf(l.market) ? l.market : null,
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
    else unmatched.push({ ...l, marketLabel: (mk?.long || mk?.label || l.market).toLowerCase(), why: subject ? 'no numbers for that bet this week' : 'player not found on this week’s slate' })
  }
  return { matched: out, unmatched }
}

/** A quick read before the AI weighs in: lean, flags, and the numbers behind them. */
export function scoreLeg(row, odds, sim) {
  const flags = []
  const implied = Number.isFinite(odds) ? (odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100)) : (row.implied ?? null)
  const edge = implied != null ? row.prob - implied : null
  if ((row.sample ?? 0) < 6) flags.push('thin sample')
  // matchup rank 1 = allows the most; an over wants a low rank, an under a high one
  if (row.matchup) {
    const bad = row.side === 'u' ? row.matchup.rank <= 6 : row.matchup.rank > row.matchup.of - 6
    if (bad) flags.push('tough matchup')
  }
  // a line that went up on an over (down on an under) is a harder number than the opener
  if (row.move && row.move.delta !== 0 && Math.sign(row.move.delta) === (row.side === 'u' ? -1 : 1)) flags.push('line moved against this number')
  if ((row.role ?? 1) < 0.6) flags.push('limited role')
  if (edge != null && edge < -0.03) flags.push('priced worse than its chance')
  const lean = row.prob >= 0.6 && (edge == null || edge >= 0) && flags.length <= 1 ? 'keep' : row.prob < 0.5 || (edge != null && edge < -0.05) || flags.length >= 3 ? 'cut' : 'risky'
  return { lean, flags, implied, edge, killsAlone: sim?.onlyMiss ?? null }
}

function legBrief(i, ctx, odds, s, sim) {
  const r = ctx.prop
  const alts = (ctx.others || []).slice(0, 3).map((o) => `${o.label} (APEX ${(o.prob * 100).toFixed(0)}%)`)
  const altLines = (ctx.alts || []).slice(0, 3).map((a) => `line ${a.line} (APEX ${(a.prob * 100).toFixed(0)}%)`)
  return [
    `LEG ${i + 1}`,
    _brief(ctx),
    odds != null && s.implied != null ? `SLIP PRICE: ${odds > 0 ? `+${odds}` : odds} (implies ${(s.implied * 100).toFixed(1)}%, APEX edge ${(s.edge * 100).toFixed(1)} pts)` : 'SLIP PRICE: none shown',
    `SIMULATED: hits ${(sim.hitRate * 100).toFixed(1)}% of runs; the only miss that sinks the parlay in ${(sim.onlyMiss * 100).toFixed(1)}%`,
    s.flags.length ? `FLAGS: ${s.flags.join(', ')}` : 'FLAGS: none',
    alts.length || altLines.length ? `ALTERNATIVES: ${[...altLines, ...alts].join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Stream the check as NDJSON: { type:'legs' } (cards with a quick lean) and { type:'sim' } right
 * away, then the AI's text. Returns { produced } for the allowance refund.
 */
export async function streamParlayCheck({ engine, matched, unmatched = [], parlayOdds = null, notes = '', res, apiKey }) {
  const views = engine.views
  const ctxs = matched.map((m) => views.propContext(m.id)).filter(Boolean)
  const rows = ctxs.map((c) => c.prop)
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
    const sim = rows.length ? simulateSlip(rows, { iterations: 20_000, price: parlayOdds, bets: 100, seed: 17 }) : null
    const scores = rows.map((r, i) => scoreLeg(r, matched[i].odds, sim?.legs[i]))
    write({
      type: 'legs',
      legs: rows.map((r, i) => ({ n: i + 1, id: r.id, name: r.name, short: r.short, headshot: r.headshot || null, teamAbbr: r.teamAbbr, oppAbbr: r.oppAbbr, label: r.label, prob: r.prob, fair: r.fair, odds: matched[i].odds, l10: r.windows?.find((w) => w.key === 'L10') || null, ...scores[i] })),
      unmatched,
      notes,
    })
    if (sim) write({ type: 'sim', parlay: sim.parlay, price: sim.price, iterations: sim.iterations, legs: sim.legs.map((l) => ({ id: l.id, hitRate: l.hitRate, onlyMiss: l.onlyMiss })) })
    if (!rows.length) {
      write({ type: 'complete', text: '' })
      return { produced: false }
    }
    if (!apiKey) {
      write({ type: 'error', error: 'AI is not configured on this server (ANTHROPIC_API_KEY).' })
      return { produced: false }
    }
    const brief = [
      `PARLAY: ${rows.length} legs${parlayOdds != null ? ` at ${parlayOdds > 0 ? `+${parlayOdds}` : parlayOdds} (implies ${(sim.price.implied * 100).toFixed(1)}%)` : ''}.`,
      `SIMULATED ${sim.iterations} times: cashes ${(sim.parlay.hitRate * 100).toFixed(1)}% (legs multiplied: ${(sim.parlay.independent * 100).toFixed(1)}%).`,
      sim.parlay.correlated.length ? `LEGS THAT MOVE TOGETHER: ${sim.parlay.correlated.map((c) => `leg ${rows.findIndex((r) => r.id === c.a) + 1} & leg ${rows.findIndex((r) => r.id === c.b) + 1} ${c.together > 0 ? 'win together' : 'pull against each other'}`).join('; ')}` : '',
      unmatched.length ? `NOT ON THE BOARD (mention briefly, no verdict): ${unmatched.map((u) => `${u.player} ${u.market} ${u.side} ${u.line}`).join('; ')}` : '',
      '',
      ...ctxs.map((c, i) => legBrief(i, c, matched[i].odds, scores[i], sim.legs[i])),
    ]
      .filter((x) => x !== '')
      .join('\n\n')
    write({ type: 'start', model: MODEL() })
    const stream = anthropicClient(apiKey).messages.stream({ model: MODEL(), max_tokens: 1400, system: CHECK_SYSTEM, messages: [{ role: 'user', content: brief }] })
    stream.on('text', (d) => {
      text += d
      write({ type: 'text_delta', text: d })
    })
    const final = await stream.finalMessage()
    write({ type: 'complete', text, stop_reason: final?.stop_reason ?? null })
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

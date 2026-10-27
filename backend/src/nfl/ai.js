// "AI picks": a short Propify read of one prop, streamed as NDJSON (same framing as /api/chat/stream).
import { log, errText } from '../lib/log.js'
import { RULES, RULES_PROMPT } from './rules.js'
import { certifyLeg } from './analytics/lock.js'

const LENS = {
  football: `- Role first: snaps, targets, carries, red-zone usage. Volume beats talent.
- Matchup: how this defense treats the position (rank and per-game allowed), scheme and pass/rush funnel.
- Script: spread and total imply the game flow. Favorites run late, trailing teams throw.`,
  basketball: `- Role first: minutes, usage and who's out. Minutes beat talent.
- Matchup: how this defense treats the position (rank and per-game allowed), pace and size.
- Script: spread and total imply pace and blowout risk (starters sit in blowouts).`,
  hockey: `- Role first: ice time, power-play unit, line placement; for goalies, whether he starts.
- Matchup: shots and goals the opponent allows, and their pace.
- Script: the total and moneyline imply how many shots and how much pressure each side gets.`,
  baseball: `- Role first: lineup spot and plate appearances for hitters; pitch count and leash for pitchers.
- Matchup: the opposing pitcher or lineup, handedness, park and weather.
- Script: the total implies run environment; bullpens decide late innings.`,
}

/** The Propify read of one prop, in the sport's terms. */
export function propSystem(sport = { title: 'NFL', family: 'football' }) {
  return `You are Propify ${sport.title} Betting Intelligence (SLCM v1.0), reading ONE player or team prop.

Use only the data you are given plus general ${sport.family === 'football' ? 'football' : sport.family} knowledge. Apply the Propify ruleset:
${LENS[sport.family] || LENS.football}
- Injuries: teammates out change usage (say who and how much the numbers moved without them).
- Line: compare the line to the player's recent median and projection; note line moves from open.
- Correlation and risk: what has to go right, what breaks it.

Answer in this exact shape, plain text, no markdown headings, under 170 words:
VERDICT: PRIME | STANDARD | MONITOR | NO PLAY — <side and line>
WHY: 3 short bullets starting with "• "
RISKS: 2 short bullets starting with "• "
SIZING: one line. If a book price is given: no edge over the vig means "Pass at this price"; otherwise quarter Kelly on the Propify probability, capped at ${RULES.stake.single * 100}% of bankroll for a single. With no price, say "no price: playable at <fair minus 2 points> or better".

Never promise a win. This is analysis, not advice.

${RULES_PROMPT}`
}
export const PROP_SYSTEM = propSystem()

function brief(ctx) {
  const r = ctx.prop
  const lines = []
  lines.push(`PROP: ${r.name} (${r.pos || 'team'}, ${r.teamAbbr}) ${r.label}${r.home === true ? ' at home' : r.home === false ? ' on the road' : ''} vs ${r.oppAbbr || '?'}`)
  if (ctx.game) lines.push(`GAME: ${ctx.game.shortName} ${ctx.game.date}${ctx.game.odds ? ` | ${ctx.game.odds.details || ''} total ${ctx.game.odds.total ?? '?'}` : ''}`)
  lines.push(`Propify: probability ${(r.prob * 100).toFixed(1)}%, fair ${r.fair > 0 ? `+${r.fair}` : r.fair}, score ${r.score}/100, projection ${r.proj ?? '?'}, recent average ${r.avg ?? '?'}, median ${r.median ?? '?'}`)
  if (r.price) lines.push(`PRICE (${r.price.book || 'book'}): over ${r.price.over ?? '-'} / under ${r.price.under ?? '-'}${r.price.yes != null ? ` / yes ${r.price.yes}` : ''}${r.edge != null ? ` | edge ${(r.edge * 100).toFixed(1)} pts` : ''}`)
  else lines.push('PRICE: none (DraftKings line, no price)')
  lines.push(`HIT RATES: ${r.windows.map((w) => `${w.label} ${w.hits}/${w.n}`).join(', ')}${r.streak ? ` | current streak ${r.streak}` : ''}`)
  if (r.matchup) lines.push(`MATCHUP: ${r.matchup.text} (${r.matchup.perGame} per game vs ${r.matchup.avg} league average)`)
  if (r.boost) lines.push(`INJURY CONTEXT: ${r.boost.teammate} (${r.boost.status}). In ${r.boost.games} games without him this player averaged ${r.boost.withoutAvg} vs ${r.boost.avg}.`)
  if (r.move) lines.push(`LINE MOVE: opened ${r.move.open}, now ${r.line} (${r.move.delta > 0 ? '+' : ''}${r.move.delta})`)
  if (r.notes?.length) lines.push(`PROPIFY NOTES (hit rate weighed against this matchup): ${r.notes.map((n) => `[${n.tone}] ${n.text}`).join(' ')}`)
  if (ctx.injury) lines.push(`PLAYER STATUS: ${ctx.injury.status}`)
  if (ctx.logs?.length) lines.push(`LAST GAMES (newest last): ${ctx.logs.map((l) => `${l.date} ${l.home ? 'vs' : '@'}${l.opp}: ${l.v}`).join(' | ')}`)
  const cert = certifyLeg(r, { now: Date.now(), injury: ctx.injury })
  lines.push(`PROPIFY RULE CHECKS: ${cert.checks.map((c) => `${c.label} ${c.state.toUpperCase()} (${c.detail})`).join('; ')}`)
  return lines.join('\n')
}

/** Returns { ok, produced } so the caller can refund the allowance when nothing came out. */
export async function streamPropInsight({ propId, views, res, ai, sport, maxTokens = 700 }) {
  const ctx = views.propContext(propId)
  if (!ctx) {
    res.status(404).set('Cache-Control', 'no-store').json({ error: 'That prop is not on the board.', code: 'not_found' })
    return { ok: false, produced: false }
  }
  if (!ai?.ready()) {
    res.status(503).set('Cache-Control', 'no-store').json({ error: 'AI is not configured on this server (OPENAI_API_KEY).', code: 'ai_off' })
    return { ok: false, produced: false }
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const write = (o) => {
    try {
      res.write(`${JSON.stringify(o)}\n`)
    } catch {
      /* client left */
    }
  }
  let text = ''
  let closed = false
  // a reader who leaves stops the answer too (nobody pays for words no one sees)
  const stop = new AbortController()
  res.on?.('close', () => {
    closed = true
    stop.abort()
  })
  try {
    write({ type: 'start', model: ai.model('insight'), prop: ctx.prop.id })
    const out = await ai.stream({
      feature: 'insight',
      system: sport ? propSystem(sport) : PROP_SYSTEM,
      messages: [{ role: 'user', content: brief(ctx) }],
      maxTokens,
      signal: stop.signal,
      onText: (d) => {
        text += d
        if (!closed) write({ type: 'text_delta', text: d })
      },
    })
    write({ type: 'complete', text, stop_reason: out.stop ?? null })
    return { ok: true, produced: text.trim().length > 0 }
  } catch (e) {
    log.warn('prop insight failed', { prop: propId, err: errText(e) })
    write({ type: 'error', error: 'The AI read failed. Your allowance was not used.' })
    return { ok: false, produced: text.trim().length > 0 }
  } finally {
    try {
      res.end()
    } catch {
      /* gone */
    }
  }
}

export { brief as _brief }

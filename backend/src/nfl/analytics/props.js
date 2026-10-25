// Prop rows: everything a card needs (hit rates, APEX probability and score, fair odds,
// matchup, injury boosts, line moves), plus parlays and cheatsheets built from them.
import { MARKETS, marketOf, propLabel, shortLabel, POS_GROUP } from '../markets.js'
import { marketRows, windows, bestWindow, apexOverProb, apexScore, fairOdds, propId, streakOf, outcome, summarize, marketAnchor } from './core.js'
import { matchupFor, ordinal } from './defense.js'
import { injurySeverity } from '../../providers/espn/normalize.js'
import { noVig, americanToProb } from '../../lib/odds.js'
import { normalOver } from '../../lib/stats.js'
import { round, clamp, mean } from '../../lib/util.js'
import { teamPointRows } from './teams.js'
import * as football from '../../sports/football.js'

/** Teammates who are out (or doubtful) and actually mattered: they show up in recent games. */
export function keyAbsences(player, ctx) {
  const out = []
  const fam = ctx.fam || football
  const group = fam.posGroup(player.pos)
  const peers = fam.PEERS[group]
  if (!peers?.length) return out
  const myRows = ctx.logs.get(player.id) || []
  const myEvents = new Map(myRows.map((r) => [r.eventId, r]))
  for (const inj of ctx.injuriesByTeam.get(player.teamId) || []) {
    if (inj.athleteId === player.id) continue
    const sev = injurySeverity(inj.status)
    if (sev !== 'out' && sev !== 'doubtful') continue
    const mate = ctx.players.get(inj.athleteId)
    if (!mate || !peers.includes(fam.posGroup(mate.pos || inj.pos))) continue
    const mateRows = ctx.logs.get(inj.athleteId)
    if (!mateRows || mateRows.filter((r) => r.season === ctx.season || r.season === ctx.lastSeason).length < 3) continue
    const mateEvents = new Set(mateRows.map((r) => r.eventId))
    // games the player played for this team while the teammate didn't
    const missed = [...myEvents.values()].filter((r) => (r.season === ctx.season || r.season === ctx.lastSeason) && !mateEvents.has(r.eventId) && (!mate.teamId || r.teamId === mate.teamId)).map((r) => r.eventId)
    if (missed.length < 2) continue
    out.push({ id: inj.athleteId, name: mate.name || inj.name, short: mate.short || inj.short || inj.name, pos: mate.pos || inj.pos, status: inj.status, missed })
  }
  return out
}

/** How big the player's role is, 0..1 (football's rule; each sport brings its own). */
export const roleOf = football.roleOf

/**
 * Lines far from what the player usually does are the ones books price with heavy juice
 * (Over 0.5 rush yards for a QB who scrambles every week). Without prices, rank them lower.
 */
export function lineFit(avg, line, side, oneSided) {
  if (oneSided || !(line > 0) || avg == null) return 1
  const ratio = avg / line
  if (side === 'o') return ratio <= 1.35 ? 1 : Math.max(0.55, 1 - (ratio - 1.35) * 0.45)
  return ratio >= 0.7 ? 1 : Math.max(0.55, 1 - (0.7 - ratio) * 0.9)
}

/**
 * Books set main lines near 50/50, so a 90% hit rate on one is mostly noise and recent form.
 * Pull the estimate 40% of the way back to the market (the no-vig price when we have one,
 * else even money). One-sided markets (anytime TD) lean on the count model instead.
 */
export function calibrate(raw, { implied = null, anchor = null, oneSided = false, model = null, keep = 0.6 } = {}) {
  if (oneSided) {
    const a = implied ?? model ?? raw
    return clamp(a + (raw - a) * keep, 0.02, 0.97)
  }
  // a price beats everything; an alternate line leans on where the main line sits; a posted
  // main line without a price is even money
  const a = implied ?? anchor ?? 0.5
  return clamp(a + (raw - a) * keep, 0.03, 0.97)
}

function priceFor(ctx, playerId, market, line) {
  const p = ctx.prices?.get?.(`${playerId}:${market}:${line}`)
  if (!p) return null
  return p
}

/**
 * One prop row. side: 'o' | 'u' | undefined (pick the likelier side).
 * Returns null when there isn't enough history to say anything honest.
 */
export function buildPropRow({ player, market, line, side, game, ctx, meta = {} }) {
  const mk = MARKETS[market]
  if (!mk || !player) return null
  const logs = ctx.logs.get(player.id)
  if (!logs) return { pending: true, playerId: player.id, market, line }
  const rows = marketRows(logs, market)
  if (rows.length < 3) return null
  const isHome = game ? game.home?.id === player.teamId : null
  const opp = game ? (isHome ? game.away : game.home) : null
  const fam = ctx.fam || football
  const matchup = opp ? matchupFor(ctx.dvp, opp.id, player.pos, market, fam) : null
  const absences = keyAbsences(player, ctx)
  // injury boost: how this player produced in games the teammate missed
  let boost = null
  for (const a of absences) {
    const sub = rows.filter((r) => a.missed.includes(r.eventId))
    if (sub.length < 2) continue
    const withoutAvg = mean(sub.map((r) => r.v))
    const allAvg = mean(rows.slice(-16).map((r) => r.v))
    if (!(allAvg > 0)) continue
    const lift = withoutAvg / allAvg - 1
    if (lift > 0.05 && (!boost || lift > boost.lift)) boost = { teammateId: a.id, teammate: a.name, short: a.short, status: a.status, games: sub.length, withoutAvg: round(withoutAvg, 1), avg: round(allAvg, 1), lift: round(lift, 3) }
  }
  const prob = apexOverProb(rows, market, line, { matchup: matchup?.nudge || 0, boost: boost ? clamp(boost.lift * 0.5, 0, 0.15) : 0 })
  if (!prob) return null
  let s = side
  if (mk.oneSided) s = 'o'
  if (!s) s = prob.p >= 0.5 ? 'o' : 'u'
  const raw = s === 'o' ? prob.p : 1 - prob.p
  const price = priceFor(ctx, player.id, market, line)
  let implied = null
  if (price && price.over != null && price.under != null) {
    const nv = noVig(price.over, price.under)
    if (nv) implied = s === 'o' ? nv[0] : nv[1]
  } else if (price && price.yes != null) {
    implied = americanToProb(price.yes)
  }
  // Lines other than the posted main one: anchor on the main line (or, with nothing posted,
  // on the model) instead of even money, or alternates get dragged toward 50%.
  const main = Number.isFinite(meta.main) ? meta.main : null
  let anchor = null
  if (!mk.oneSided && implied == null && line !== main) {
    const over = main != null ? marketAnchor(prob.proj, market, main, line) : prob.pModel
    if (over != null) anchor = s === 'o' ? over : 1 - over
  }
  const p = calibrate(raw, { implied, anchor, oneSided: mk.oneSided, model: s === 'o' ? prob.pModel : 1 - prob.pModel })
  const edge = implied != null ? p - implied : 0
  const ws = windows(rows, line, s, {
    season: ctx.season,
    lastSeason: ctx.lastSeason,
    oppId: opp?.id,
    oppAbbr: opp?.abbr,
    home: isHome,
    without: absences,
  })
  const best = bestWindow(ws)
  const recent = rows.slice(-20).map((r) => ({ v: r.v, date: r.date, opp: r.oppAbbr, home: r.home, id: r.eventId, o: outcome(r.v, line, s) }))
  const sum = summarize(rows.slice(-20))
  const score = apexScore(p, prob.sample, edge)
  const role = fam.roleOf(player, logs, ctx.season)
  const fit = lineFit(sum.avg, line, s, mk.oneSided)
  const id = propId(player.id, market, s, line)
  const move = meta.open != null && meta.open !== line ? { open: meta.open, delta: round(line - meta.open, 1) } : null
  return {
    id,
    kind: 'player',
    playerId: player.id,
    name: player.name,
    short: player.short,
    pos: player.pos,
    headshot: player.headshot || null,
    teamId: player.teamId,
    teamAbbr: ctx.teamAbbr?.(player.teamId) || '',
    gameId: game?.id || null,
    oppId: opp?.id || null,
    oppAbbr: opp?.abbr || '',
    home: isHome,
    kickoff: game?.date || null,
    market,
    marketLabel: mk.label,
    label: propLabel(market, s, line),
    shortLabel: shortLabel(market, s, line),
    line,
    side: s,
    oneSided: Boolean(mk.oneSided),
    prob: round(p, 4),
    probRaw: round(raw, 4),
    probModel: round(s === 'o' ? prob.pModel : 1 - prob.pModel, 4),
    fair: fairOdds(p),
    score,
    role,
    fit: round(fit, 2),
    rank: Math.round(score * (0.55 + 0.45 * role) * fit),
    proj: prob.proj ? round(prob.proj.mean ?? prob.proj.lambda, 1) : null,
    // spread of the projection (normal markets); the parlay simulator draws from it
    sd: prob.proj?.sd ? round(prob.proj.sd, 2) : null,
    avg: sum.avg,
    median: sum.median,
    sample: prob.sample,
    windows: ws.map((w) => ({ key: w.key, label: w.label, hits: w.hits, n: w.n })),
    best: best ? { key: best.key, label: best.label, hits: best.hits, n: best.n } : null,
    streak: streakOf(rows.map((r) => r.v), line, s),
    recent,
    matchup: matchup ? { rank: matchup.rank, of: matchup.of, perGame: round(matchup.perGame, 1), avg: round(matchup.avg, 1), group: matchup.group, stat: matchup.stat, text: `${opp.abbr} allows the ${ordinal(matchup.rank)}-most ${fam.NOUN[matchup.stat] || MARKETS[matchup.stat]?.long?.toLowerCase() || matchup.stat} to ${fam.GROUP_NAMES?.[matchup.group] || `${matchup.group}s`}` } : null,
    boost,
    move,
    alts: meta.alts || [],
    main,
    // 'main' and 'alt' are lines a sportsbook posted; null is a line typed in for research
    posted: main == null ? null : line === main ? 'main' : (meta.alts || []).includes(line) ? 'alt' : null,
    book: meta.book || null,
    price: price ? { over: price.over ?? null, under: price.under ?? null, yes: price.yes ?? null, book: price.book || null, books: price.books || null, best: price.best || null } : null,
    implied: implied != null ? round(implied, 4) : null,
    edge: implied != null ? round(edge, 4) : null,
    updated: meta.updated || null,
  }
}

/** Team total row from the schedule (points scored per game). */
export function buildTeamRow({ team, market = 'teamPts', line, side, game, schedule, ctx, meta = {} }) {
  const rows = teamPointRows(schedule)
  if (rows.length < 3) return null
  const sub = rows.slice(-16)
  const m = 0.7 * sub.slice(-6).reduce((s, r) => s + r.v, 0) / Math.min(6, sub.length) + 0.3 * mean(sub.map((r) => r.v))
  const sdv = Math.max(4, Math.sqrt(sub.reduce((s, r) => s + (r.v - m) ** 2, 0) / Math.max(1, sub.length - 1)))
  const pOverModel = normalOver(m, sdv, line)
  const hitsO = rows.slice(-20).filter((r) => r.v > line).length
  const nO = rows.slice(-20).filter((r) => r.v !== line).length
  const emp = (hitsO + pOverModel * 3) / (nO + 3)
  const pOver = clamp(0.55 * emp + 0.45 * pOverModel, 0.02, 0.98)
  const s = side || (pOver >= 0.5 ? 'o' : 'u')
  const main = Number.isFinite(meta.main) ? meta.main : null
  let anchor = null
  if (line !== main) {
    const over = main != null ? normalOver(main, sdv, line) : pOverModel
    anchor = s === 'o' ? over : 1 - over
  }
  const p = calibrate(s === 'o' ? pOver : 1 - pOver, { anchor })
  const isHome = game ? game.home?.id === team.id : null
  const opp = game ? (isHome ? game.away : game.home) : null
  const ws = windows(rows, line, s, { season: ctx.season, lastSeason: ctx.lastSeason, oppId: opp?.id, oppAbbr: opp?.abbr, home: isHome })
  const best = bestWindow(ws)
  return {
    id: propId(`t${team.id}`, market, s, line),
    kind: 'team',
    teamId: team.id,
    teamAbbr: team.abbr,
    name: team.name,
    short: team.abbr,
    logo: team.logo,
    gameId: game?.id || null,
    oppId: opp?.id || null,
    oppAbbr: opp?.abbr || '',
    home: isHome,
    kickoff: game?.date || null,
    market,
    marketLabel: 'Team Total',
    label: `${s === 'u' ? 'Under' : 'Over'} ${line} ${(ctx.fam || football).TEAM_LABEL}`,
    shortLabel: `${s === 'u' ? 'U' : 'O'} ${line} ${{ Points: 'Pts', Runs: 'Runs', Goals: 'Goals' }[(ctx.fam || football).TEAM_LABEL] || 'Pts'}`,
    line,
    side: s,
    prob: round(p, 4),
    fair: fairOdds(p),
    score: apexScore(p, nO),
    rank: apexScore(p, nO),
    role: 1,
    fit: 1,
    proj: round(m, 1),
    sd: round(sdv, 2),
    avg: round(mean(rows.slice(-20).map((r) => r.v)), 1),
    sample: nO,
    windows: ws.map((w) => ({ key: w.key, label: w.label, hits: w.hits, n: w.n })),
    best: best ? { key: best.key, label: best.label, hits: best.hits, n: best.n } : null,
    streak: streakOf(rows.map((r) => r.v), line, s),
    recent: rows.slice(-20).map((r) => ({ v: r.v, date: r.date, opp: r.oppAbbr, home: r.home, id: r.eventId, o: outcome(r.v, line, s) })),
    move: meta.open != null && meta.open !== line ? { open: meta.open, delta: round(line - meta.open, 1) } : null,
    alts: meta.alts || [],
    main,
    posted: main == null ? null : line === main ? 'main' : (meta.alts || []).includes(line) ? 'alt' : null,
    updated: meta.updated || null,
  }
}

// ---- lists -----------------------------------------------------------------------------------

/** Best props first, but no more than `perPlayer` per player and `perGame` per game. */
export function diverse(rows, { limit = 30, perPlayer = 2, perGame = 4, key = (r) => r.rank ?? r.score } = {}) {
  const sorted = [...rows].sort((a, b) => key(b) - key(a))
  const byPlayer = new Map()
  const byGame = new Map()
  const out = []
  for (const r of sorted) {
    const pk = r.playerId || r.teamId
    if ((byPlayer.get(pk) || 0) >= perPlayer) continue
    if (r.gameId && (byGame.get(r.gameId) || 0) >= perGame) continue
    byPlayer.set(pk, (byPlayer.get(pk) || 0) + 1)
    if (r.gameId) byGame.set(r.gameId, (byGame.get(r.gameId) || 0) + 1)
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}

function windowOf(r, key) {
  return r.windows.find((w) => w.key === key)
}

export function cheatsheets(rows) {
  const pre = rows.filter((r) => r.kind === 'player' && !r.pending && (r.role ?? 1) >= 0.6 && (r.fit ?? 1) >= 0.85)
  const perfect = (key, min) => pre.filter((r) => {
    const w = windowOf(r, key)
    return w && w.n >= min && w.hits === w.n
  })
  const recent = perfect('L10', 6)
    .concat(perfect('L5', 5).filter((r) => !windowOf(r, 'L10') || windowOf(r, 'L10').n < 6))
  const sheets = [
    { key: 'form', title: '100% Recent Form', sub: 'Hit in every recent game', rows: diverse(recent, { limit: 8, perPlayer: 1, perGame: 3, key: (r) => r.streak * 10 + r.score }) },
    { key: 'h2h', title: '100% Versus Opponent', sub: 'Hit every time against this team', rows: diverse(perfect('h2h', 2), { limit: 8, perPlayer: 1, perGame: 3, key: (r) => (windowOf(r, 'h2h')?.n || 0) * 10 + r.score }) },
    { key: 'venue', title: '100% Home/Away', sub: 'Hit every game at this venue split', rows: diverse(perfect('venue', 4), { limit: 8, perPlayer: 1, perGame: 3 }) },
    { key: 'season', title: '100% This Season', sub: 'Hit in every game this season', rows: diverse(perfect('season', 4), { limit: 8, perPlayer: 1, perGame: 3 }) },
  ]
  return sheets.filter((s) => s.rows.length)
}

/**
 * Parlays from the strongest legs: different players, at most two legs from one game.
 * Probability assumes independence, minus a small haircut per extra leg.
 */
export function parlays(rows, { sizes = [2, 3, 4], count = 3, minScore = 80, gameId = null } = {}) {
  const legs = diverse(
    rows.filter((r) => !r.pending && r.score >= minScore && r.prob >= 0.6 && (r.role ?? 1) >= 0.7 && (r.fit ?? 1) >= 0.9 && (!gameId || r.gameId === gameId)),
    { limit: 24, perPlayer: 1, perGame: gameId ? 12 : 2 },
  )
  const out = []
  for (const size of sizes) {
    const used = new Set()
    for (let k = 0; k < count && legs.length >= size; k++) {
      const pick = []
      const games = new Map()
      for (const r of legs) {
        if (used.has(r.id)) continue
        if (!gameId && (games.get(r.gameId) || 0) >= 2) continue
        pick.push(r)
        games.set(r.gameId, (games.get(r.gameId) || 0) + 1)
        if (pick.length === size) break
      }
      if (pick.length < size) break
      pick.forEach((r) => used.add(r.id))
      const p = pick.reduce((s, r) => s * r.prob, 1) * (1 - 0.02 * (size - 1))
      out.push({ id: pick.map((r) => r.id).join('~'), size, legs: pick.map((r) => r.id), prob: round(p, 4), fair: fairOdds(p), score: Math.round(pick.reduce((s, r) => s + r.score, 0) / size), title: `${size}-leg ${gameId ? 'same game' : 'slate'} parlay` })
    }
  }
  return out
}

export { POS_GROUP, marketOf }

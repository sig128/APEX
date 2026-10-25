// Turn ESPN's public API payloads into small, stable shapes the engine works with.
import { num } from '../../lib/util.js'
import { americanToProb } from '../../lib/odds.js'

/** ESPN prop bet type ids -> our market keys. */
export const ESPN_PROP_TYPES = {
  8: 'passYds',
  9: 'passCmp',
  10: 'passTd',
  11: 'rushAtt',
  12: 'rushYds',
  13: 'recYds',
  14: 'rec',
  15: 'passInt',
  16: 'passAtt',
  17: 'longPass',
  18: 'passRushYds',
  19: 'longRec',
  20: 'rushRecYds',
  21: 'longRush',
  22: 'kickPts',
  24: 'fgMade',
  26: 'tackles',
  27: 'tacklesAst',
  28: 'sacks',
  31: 'anyTd',
  32: 'td2',
  98: 'teamPts',
  104: 'teamTds',
}

const logoSmall = (abbr) => (abbr ? `https://a.espncdn.com/i/teamlogos/nfl/500/${String(abbr).toLowerCase()}.png` : null)

export function normTeam(t) {
  if (!t) return null
  return {
    id: String(t.id),
    abbr: t.abbreviation || '',
    name: t.displayName || [t.location, t.name].filter(Boolean).join(' '),
    short: t.shortDisplayName || t.name || t.abbreviation || '',
    nick: t.name || t.shortDisplayName || '',
    location: t.location || '',
    color: t.color ? `#${t.color}` : null,
    alt: t.alternateColor ? `#${t.alternateColor}` : null,
    logo: t.logo || t.logos?.[0]?.href || logoSmall(t.abbreviation),
  }
}

export function normStatus(st) {
  const type = st?.type || {}
  const state = type.state === 'in' || type.state === 'post' ? type.state : 'pre'
  let clock = st?.displayClock || null
  if (!clock && Number.isFinite(st?.clock)) {
    const s = Math.max(0, Math.round(st.clock))
    clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  return {
    state,
    completed: Boolean(type.completed),
    name: type.name || '',
    detail: type.detail || type.description || '',
    short: type.shortDetail || type.detail || '',
    period: Number(st?.period) || 0,
    clock,
    halftime: type.name === 'STATUS_HALFTIME',
    delayed: /DELAY|POSTPONED|CANCELED|SUSPENDED/.test(type.name || ''),
  }
}

function sideOdds(o, side) {
  const s = o?.[`${side}TeamOdds`] || {}
  const ml = o?.moneyline?.[side]
  const ps = o?.pointSpread?.[side]
  return {
    ml: num(ml?.close?.odds) ?? num(s.moneyLine),
    mlOpen: num(ml?.open?.odds),
    spread: num(ps?.close?.line),
    spreadOpen: num(ps?.open?.line),
    spreadOdds: num(ps?.close?.odds) ?? num(s.spreadOdds),
    favorite: Boolean(s.favorite),
  }
}

/** Game odds from a scoreboard competition or a summary pickcenter entry. */
export function normOdds(o, homeAbbr) {
  if (!o) return null
  const home = sideOdds(o, 'home')
  const away = sideOdds(o, 'away')
  const totalClose = o.total?.over?.close?.line
  const totalOpen = o.total?.over?.open?.line
  const total = num(String(totalClose || '').replace(/^[ou]/, '')) ?? num(o.overUnder)
  let homeSpread = home.spread
  if (homeSpread == null && Number.isFinite(o.spread)) {
    // The bare `spread` is the home team's line on pickcenter and the favorite's magnitude on the scoreboard.
    homeSpread = typeof o.details === 'string' && homeAbbr && o.details.startsWith(homeAbbr) ? -Math.abs(o.spread) : o.spread
  }
  return {
    provider: o.provider?.name || null,
    details: o.details || null,
    total,
    totalOpen: num(String(totalOpen || '').replace(/^[ou]/, '')),
    overOdds: num(o.total?.over?.close?.odds) ?? num(o.overOdds),
    underOdds: num(o.total?.under?.close?.odds) ?? num(o.underOdds),
    homeSpread,
    homeSpreadOpen: home.spreadOpen,
    homeMl: home.ml,
    awayMl: away.ml,
    homeMlOpen: home.mlOpen,
    awayMlOpen: away.mlOpen,
    homeSpreadOdds: home.spreadOdds,
    awaySpreadOdds: away.spreadOdds,
  }
}

function record(c) {
  const recs = c.records || c.record || []
  const pick = (t) => recs.find((r) => r.type === t || r.name === t)?.summary || null
  return { total: pick('total') || pick('overall'), home: pick('home'), away: pick('road') || pick('away') }
}

function normSituation(s, home, away) {
  if (!s) return null
  return {
    down: Number(s.down) || 0,
    distance: Number(s.distance) || 0,
    yardLine: Number(s.yardLine) || 0,
    text: s.shortDownDistanceText || s.downDistanceText || null,
    possessionText: s.possessionText || null,
    possession: s.possession ? String(s.possession) : null,
    possessionAbbr: s.possession ? (String(s.possession) === home?.id ? home.abbr : String(s.possession) === away?.id ? away.abbr : null) : null,
    redZone: Boolean(s.isRedZone),
    lastPlay: s.lastPlay?.text || null,
    timeouts: { home: s.homeTimeouts ?? null, away: s.awayTimeouts ?? null },
  }
}

function normCompetitor(c) {
  if (!c) return null
  const team = normTeam(c.team)
  return {
    ...team,
    score: num(c.score?.displayValue ?? c.score),
    winner: Boolean(c.winner),
    record: record(c),
    linescores: (c.linescores || []).map((l) => num(l.value ?? l.displayValue)).filter((x) => x != null),
  }
}

export function normEvent(e) {
  const comp = e.competitions?.[0] || {}
  const cs = comp.competitors || []
  const home = normCompetitor(cs.find((c) => c.homeAway === 'home'))
  const away = normCompetitor(cs.find((c) => c.homeAway === 'away'))
  const status = normStatus(comp.status || e.status)
  return {
    id: String(e.id),
    date: e.date || comp.date,
    name: e.name || '',
    shortName: e.shortName || (away && home ? `${away.abbr} @ ${home.abbr}` : ''),
    season: e.season?.year || null,
    seasonType: e.season?.type || null,
    week: e.week?.number || null,
    status,
    home,
    away,
    neutral: Boolean(comp.neutralSite),
    venue: comp.venue ? { name: comp.venue.fullName || '', city: comp.venue.address?.city || '', state: comp.venue.address?.state || '', indoor: Boolean(comp.venue.indoor) } : null,
    broadcast: comp.broadcast || comp.broadcasts?.[0]?.names?.[0] || null,
    weather: e.weather ? { text: e.weather.displayValue || '', temp: num(e.weather.temperature) } : null,
    odds: normOdds(comp.odds?.[0], home?.abbr),
    situation: status.state === 'in' ? normSituation(comp.situation, home, away) : null,
  }
}

export function normScoreboard(j) {
  const events = (j?.events || []).map(normEvent)
  const season = j?.season?.year || j?.leagues?.[0]?.season?.year || events[0]?.season || null
  return {
    season,
    seasonType: j?.season?.type || events[0]?.seasonType || null,
    week: j?.week?.number || events[0]?.week || null,
    games: events.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id)),
  }
}

// ---- box scores -----------------------------------------------------------------------------

/** Turn one box score category row into named numbers. Handles "24/31" and "2-11" style cells. */
function statCells(keys, stats) {
  const out = {}
  keys.forEach((k, i) => {
    const v = stats?.[i]
    if (v == null) return
    if (k.includes('/')) {
      const [a, b] = k.split('/')
      const [x, y] = String(v).split('/')
      out[a] = num(x)
      out[b] = num(y)
    } else if (k.includes('-') && /^\d+-\d+$/.test(String(v))) {
      const [a, b] = k.split('-')
      const [x, y] = String(v).split('-')
      out[a] = num(x)
      out[b] = num(y)
    } else {
      out[k] = num(v)
    }
  })
  return out
}

// Box score keys per category -> the same stat names the game logs use.
const BOX_KEYS = {
  passing: { completions: 'passCmp', passingAttempts: 'passAtt', passingYards: 'passYds', passingTouchdowns: 'passTd', interceptions: 'passInt', sacks: 'sacksTaken', longPassing: 'longPass' },
  rushing: { rushingAttempts: 'rushAtt', rushingYards: 'rushYds', rushingTouchdowns: 'rushTd', longRushing: 'longRush' },
  receiving: { receptions: 'rec', receivingYards: 'recYds', receivingTouchdowns: 'recTd', longReception: 'longRec', receivingTargets: 'targets' },
  fumbles: { fumbles: 'fum', fumblesLost: 'fumLost' },
  defensive: { totalTackles: 'tackles', soloTackles: 'solo', sacks: 'sacks', tacklesForLoss: 'tfl', passesDefended: 'pd', QBHits: 'qbHits', defensiveTouchdowns: 'defTd' },
  interceptions: { interceptions: 'defInt', interceptionTouchdowns: 'defIntTd' },
  kickReturns: { kickReturnTouchdowns: 'krTd' },
  puntReturns: { puntReturnTouchdowns: 'prTd' },
  kicking: { fieldGoalsMade: 'fgMade', fieldGoalAttempts: 'fgAtt', extraPointsMade: 'xpMade', totalKickingPoints: 'kickPts', longFieldGoalMade: 'longFg' },
}

/** { [athleteId]: { id, name, short, jersey, teamId, stats: {...} } } from a summary boxscore. */
export function normBoxPlayers(box) {
  const players = {}
  for (const side of box?.players || []) {
    const teamId = String(side.team?.id || '')
    for (const cat of side.statistics || []) {
      const map = BOX_KEYS[cat.name]
      if (!map) continue
      for (const row of cat.athletes || []) {
        const a = row.athlete || {}
        if (!a.id) continue
        const p = (players[a.id] ||= { id: String(a.id), name: a.displayName || '', short: a.shortName || '', jersey: a.jersey || '', teamId, stats: {} })
        const cells = statCells(cat.keys || [], row.stats)
        for (const [k, v] of Object.entries(cells)) {
          const key = map[k]
          if (key && v != null) p.stats[key] = v
        }
      }
    }
  }
  return players
}

function normDrive(d) {
  if (!d) return null
  const last = (d.plays || [])[d.plays?.length - 1]
  return {
    id: String(d.id || ''),
    teamId: d.team?.id ? String(d.team.id) : null,
    teamAbbr: d.team?.abbreviation || null,
    description: d.description || '',
    start: d.start?.text || null,
    result: d.displayResult || d.result || null,
    yards: num(d.yards),
    plays: num(d.offensivePlays),
    elapsed: d.timeElapsed?.displayValue || null,
    isScore: Boolean(d.isScore),
    lastPlay: last ? { text: last.text || '', clock: last.clock?.displayValue || null, period: last.period?.number || null, down: last.end?.downDistanceText || null } : null,
  }
}

export function normInjuries(list) {
  const out = []
  for (const t of list || []) {
    for (const i of t.injuries || []) {
      const a = i.athlete || {}
      if (!a.id) continue
      out.push({
        athleteId: String(a.id),
        name: a.displayName || '',
        short: a.shortName || '',
        pos: a.position?.abbreviation || '',
        teamId: String(t.team?.id || ''),
        teamAbbr: t.team?.abbreviation || '',
        status: i.status || i.type?.description || '',
        code: i.type?.abbreviation || '',
        detail: [i.details?.type, i.details?.side && i.details.side !== 'Not Specified' ? i.details.side : null].filter(Boolean).join(', '),
        returnDate: i.details?.returnDate || null,
        date: i.date || null,
      })
    }
  }
  return out
}

/** "Out", "Injured Reserve", "Doubtful", "Questionable" -> how likely the player sits. */
export function injurySeverity(status) {
  const s = String(status || '').toLowerCase()
  if (/out|injured reserve|ir|suspend|pup|nfi|reserve/.test(s)) return 'out'
  if (/doubt/.test(s)) return 'doubtful'
  if (/question/.test(s)) return 'questionable'
  if (/probable/.test(s)) return 'probable'
  return s ? 'other' : null
}

export function normSummary(j) {
  const comp = j?.header?.competitions?.[0] || {}
  const cs = comp.competitors || []
  const home = normCompetitor(cs.find((c) => c.homeAway === 'home'))
  const away = normCompetitor(cs.find((c) => c.homeAway === 'away'))
  const status = normStatus(comp.status)
  const wp = (j?.winprobability || []).map((w) => ({ playId: String(w.playId || ''), home: Math.round(num(w.homeWinPercentage) * 1000) / 10 })).filter((w) => Number.isFinite(w.home))
  const pred = j?.predictor
  let predictor = null
  if (pred?.homeTeam && pred?.awayTeam) {
    const h = num(pred.homeTeam.gameProjection)
    const a = num(pred.awayTeam.gameProjection)
    if (h != null && a != null) predictor = { home: h, away: a }
  }
  const teamStats = {}
  for (const t of j?.boxscore?.teams || []) {
    const s = {}
    for (const st of t.statistics || []) s[st.name] = { label: st.label || st.name, value: st.displayValue }
    teamStats[String(t.team?.id || '')] = s
  }
  const lastFive = {}
  for (const t of j?.lastFiveGames || []) {
    lastFive[String(t.team?.id || '')] = (t.events || []).map((e) => ({
      id: String(e.id),
      date: e.gameDate,
      result: e.gameResult || null,
      score: e.score || null,
      opp: e.opponent?.abbreviation || '',
      oppId: e.opponent?.id ? String(e.opponent.id) : null,
      home: e.atVs === 'vs',
    }))
  }
  const leaders = {}
  for (const t of j?.leaders || []) {
    leaders[String(t.team?.id || '')] = (t.leaders || []).map((l) => ({
      stat: l.name,
      label: l.displayName,
      value: l.leaders?.[0]?.displayValue || '',
      athleteId: l.leaders?.[0]?.athlete?.id ? String(l.leaders[0].athlete.id) : null,
      name: l.leaders?.[0]?.athlete?.displayName || '',
      short: l.leaders?.[0]?.athlete?.shortName || '',
      pos: l.leaders?.[0]?.athlete?.position?.abbreviation || '',
    }))
  }
  return {
    id: String(j?.header?.id || comp.id || ''),
    date: comp.date || null,
    status,
    home,
    away,
    players: normBoxPlayers(j?.boxscore),
    teamStats,
    drive: normDrive(j?.drives?.current),
    lastDrive: normDrive((j?.drives?.previous || []).slice(-1)[0]),
    winProb: wp,
    homeWinPct: wp.length ? wp[wp.length - 1].home : predictor ? predictor.home : null,
    predictor,
    odds: normOdds((j?.pickcenter || [])[0], home?.abbr),
    injuries: normInjuries(j?.injuries),
    lastFive,
    leaders,
    venue: j?.gameInfo?.venue ? { name: j.gameInfo.venue.fullName || '', city: j.gameInfo.venue.address?.city || '', state: j.gameInfo.venue.address?.state || '', grass: j.gameInfo.venue.grass ?? null, indoor: j.gameInfo.venue.indoor ?? null } : null,
    weather: j?.gameInfo?.weather ? { temp: num(j.gameInfo.weather.temperature), gust: num(j.gameInfo.weather.gust), precip: num(j.gameInfo.weather.precipitation), text: j.gameInfo.weather.displayValue || '' } : null,
    scoring: (j?.scoringPlays || []).map((p) => ({ id: String(p.id), text: p.text || '', type: p.type?.abbreviation || p.type?.text || '', period: p.period?.number || null, clock: p.clock?.displayValue || null, teamId: p.team?.id ? String(p.team.id) : null, home: num(p.homeScore), away: num(p.awayScore) })),
  }
}

// ---- rosters, teams, schedules ------------------------------------------------------------

export function normTeams(j) {
  const list = j?.sports?.[0]?.leagues?.[0]?.teams || []
  return list.map((t) => normTeam(t.team)).filter(Boolean)
}

export function normRoster(j, teamId) {
  const tid = String(j?.team?.id || teamId || '')
  const out = []
  for (const g of j?.athletes || []) {
    const group = g.position || ''
    for (const a of g.items || []) {
      if (!a.id) continue
      out.push({
        id: String(a.id),
        name: a.displayName || a.fullName || '',
        short: a.shortName || '',
        pos: a.position?.abbreviation || '',
        jersey: a.jersey || '',
        teamId: tid,
        group,
        active: group !== 'injuredReserveOrOut' && group !== 'suspended' && group !== 'practiceSquad' && (a.status?.type || 'active') === 'active',
        injury: a.injuries?.[0]?.status || null,
        headshot: `https://a.espncdn.com/i/headshots/nfl/players/full/${a.id}.png`,
      })
    }
  }
  return out
}

export function normSchedule(j, teamId) {
  const tid = String(teamId || j?.team?.id || '')
  return (j?.events || [])
    .map((e) => {
      const c = e.competitions?.[0] || {}
      const me = (c.competitors || []).find((x) => String(x.team?.id || x.id) === tid)
      const opp = (c.competitors || []).find((x) => String(x.team?.id || x.id) !== tid)
      if (!me || !opp) return null
      const done = Boolean(c.status?.type?.completed)
      const pf = num(me.score?.value ?? me.score?.displayValue ?? me.score)
      const pa = num(opp.score?.value ?? opp.score?.displayValue ?? opp.score)
      return {
        id: String(e.id),
        date: e.date,
        week: e.week?.number || null,
        seasonType: e.seasonType?.type || null,
        home: me.homeAway === 'home',
        oppId: String(opp.team?.id || opp.id),
        oppAbbr: opp.team?.abbreviation || '',
        completed: done,
        pf: done ? pf : null,
        pa: done ? pa : null,
        result: done && pf != null && pa != null ? (pf > pa ? 'W' : pf < pa ? 'L' : 'T') : null,
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
}

// ---- game logs -------------------------------------------------------------------------------

const LOG_KEYS = {
  completions: 'passCmp',
  passingAttempts: 'passAtt',
  passingYards: 'passYds',
  passingTouchdowns: 'passTd',
  interceptions: 'passInt',
  longPassing: 'longPass',
  sacks: 'sacks',
  rushingAttempts: 'rushAtt',
  rushingYards: 'rushYds',
  rushingTouchdowns: 'rushTd',
  longRushing: 'longRush',
  receptions: 'rec',
  receivingTargets: 'targets',
  receivingYards: 'recYds',
  receivingTouchdowns: 'recTd',
  longReception: 'longRec',
  totalTackles: 'tackles',
  soloTackles: 'solo',
  fieldGoalsMade: 'fgMade',
  extraPointsMade: 'xpMade',
  totalKickingPoints: 'kickPts',
  fumblesLost: 'fumLost',
}

/**
 * One row per game played: { eventId, date, season, week, home, oppId, oppAbbr, teamId, result, score, s: {stat: n} }.
 * Regular season and postseason both count; preseason is skipped.
 */
export function normGamelog(j, season) {
  const names = j?.names || []
  const rows = []
  const meta = j?.events || {}
  for (const st of j?.seasonTypes || []) {
    const label = String(st.displayName || '')
    if (/pre/i.test(label)) continue
    const post = /post/i.test(label)
    for (const cat of st.categories || []) {
      if (cat.type && cat.type !== 'event') continue
      for (const ev of cat.events || []) {
        const m = meta[ev.eventId] || {}
        const s = {}
        names.forEach((n, i) => {
          const k = LOG_KEYS[n] || n
          const v = num(ev.stats?.[i])
          if (v != null) s[k] = v
        })
        // A sack stat on a QB log means sacks taken; defenders' logs use the same name for sacks made.
        rows.push({
          eventId: String(ev.eventId),
          date: m.gameDate || null,
          season: Number(season) || null,
          post,
          week: m.week || null,
          home: m.atVs ? m.atVs === 'vs' : String(m.homeTeamId) === String(m.team?.id),
          oppId: m.opponent?.id ? String(m.opponent.id) : null,
          oppAbbr: m.opponent?.abbreviation || '',
          teamId: m.team?.id ? String(m.team.id) : null,
          result: m.gameResult || null,
          score: m.score || null,
          s,
        })
      }
    }
  }
  // dedupe (ESPN sometimes repeats an event across categories) and sort oldest -> newest
  const seen = new Map()
  for (const r of rows) seen.set(r.eventId, { ...(seen.get(r.eventId) || {}), ...r, s: { ...(seen.get(r.eventId)?.s || {}), ...r.s } })
  return [...seen.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
}

// ---- prop lines -------------------------------------------------------------------------------

/** ESPN prop bets (DraftKings lines, no prices). Keeps one main line per player and market. */
export function normPropBets(j) {
  const grouped = new Map()
  for (const it of j?.items || []) {
    const typeId = Number(it.type?.id)
    const market = ESPN_PROP_TYPES[typeId]
    if (!market) continue
    const athleteId = it.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1] || null
    const teamId = it.team?.$ref?.match(/teams\/(\d+)/)?.[1] || null
    if (!athleteId && !teamId) continue
    let line = num(it.current?.target?.value)
    if (market === 'anyTd') line = 0.5
    if (market === 'td2') line = 1.5
    if (line == null) continue
    const key = `${athleteId || `t${teamId}`}:${market}`
    const g = grouped.get(key) || { athleteId, teamId, market, lines: [], open: num(it.open?.target?.value), updated: it.lastUpdated || null }
    g.lines.push(line)
    if (it.lastUpdated && (!g.updated || it.lastUpdated > g.updated)) g.updated = it.lastUpdated
    grouped.set(key, g)
  }
  const out = []
  for (const g of grouped.values()) {
    // Several targets for one market = main line plus alternates. The median is the main line.
    const sorted = [...new Set(g.lines)].sort((a, b) => a - b)
    const main = sorted[Math.floor((sorted.length - 1) / 2)]
    out.push({
      athleteId: g.athleteId,
      teamId: g.teamId,
      market: g.market,
      line: main,
      alts: sorted.filter((x) => x !== main),
      open: g.market === 'anyTd' || g.market === 'td2' ? null : g.open,
      updated: g.updated,
      book: 'DraftKings',
    })
  }
  return out
}

/** Implied probability helpers re-exported for callers that only import the normalizer. */
export { americanToProb }

// ESPN's public JSON APIs (unofficial, no key). site.api for scores and summaries,
// site.web.api for game logs, sports.core.api for prop lines.
import { normScoreboard, normSummary, normTeams, normRoster, normSchedule, normGamelog, normPropBets } from './normalize.js'
import * as football from '../../sports/football.js'

/** 'YYYYMMDD-YYYYMMDD' (or one day) -> every day in it, at most 14. */
export function daysIn(range) {
  const [a, b = a] = String(range).split('-')
  const at = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
  const out = []
  for (let t = at(a); t <= at(b) && out.length < 14; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10).replace(/-/g, ''))
  return out
}

// A refusal (not a timeout, an outage or a rate limit): asking the same thing again won't help
const refused = (e) => e?.status >= 400 && e?.status < 500 && e?.status !== 429

export function createEspnClient({ http, sport = 'football', league = 'nfl', propProvider = 100, fam = football, headshots = 'nfl' } = {}) {
  const SITE = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}`
  // the same scoreboards from ESPN's web host, which answers where the main one refuses
  const SITE_WEB = `https://site.web.api.espn.com/apis/site/v2/sports/${sport}/${league}`
  const WEB = `https://site.web.api.espn.com/apis/common/v3/sports/${sport}/${league}`
  const CORE = `https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${league}`
  const get = (url, opts) => http.getJson(url, opts)

  // ESPN's main host has refused some leagues' scoreboards outright (HTTP 400 for the Premier
  // League, Serie A and the Bundesliga in November 2026, whatever the query); its web host answers
  // one day at a time. After a refusal this league reads day by day for an hour, then tries again.
  let dayByDayUntil = 0
  async function scoreboardJson(params, opts) {
    const q = new URLSearchParams()
    if (params.week) q.set('week', String(params.week))
    if (params.seasonType) q.set('seasontype', String(params.seasonType))
    if (params.dates) q.set('dates', String(params.dates))
    if (params.limit) q.set('limit', String(params.limit))
    const qs = q.toString()
    if (Date.now() >= dayByDayUntil) {
      try {
        return await get(`${SITE}/scoreboard${qs ? `?${qs}` : ''}`, opts)
      } catch (e) {
        if (!refused(e) || params.week) throw e
        dayByDayUntil = Date.now() + 60 * 60_000
      }
    }
    const days = params.dates ? daysIn(params.dates) : [null]
    const parts = await Promise.all(days.map((d) => get(`${SITE_WEB}/scoreboard${d ? `?dates=${d}` : ''}`, opts).catch((e) => ({ failed: e }))))
    const ok = parts.filter((p) => !p.failed)
    if (!ok.length) throw parts[0].failed
    const seen = new Set()
    const events = []
    for (const p of ok) {
      for (const ev of p.events || []) {
        if (seen.has(ev.id)) continue
        seen.add(ev.id)
        events.push(ev)
      }
    }
    return { ...ok[0], events }
  }

  async function propBets(eventId, opts) {
    const base = `${CORE}/events/${eventId}/competitions/${eventId}/odds/${propProvider}/propBets?lang=en&region=us&limit=1000`
    const first = await get(base, opts)
    let items = first.items || []
    const pages = Math.min(Number(first.pageCount) || 1, 5)
    for (let p = 2; p <= pages; p++) {
      const more = await get(`${base}&page=${p}`, opts)
      items = items.concat(more.items || [])
    }
    return normPropBets({ items }, fam)
  }

  // ---- soccer: no game logs on ESPN; a player's log comes from his team's match lineups ----
  const matches = new Map() // eventId -> parsed final summary (a finished match never changes)
  const schedules = new Map() // `${teamId}:${season}` -> { at, p }
  const teamLogs = new Map() // `${teamId}:${season}:${last finished match}` -> Promise<Map>
  const MAX_MATCHES = { current: 15, earlier: 8 }

  async function finalMatch(eventId, opts) {
    if (matches.has(eventId)) return matches.get(eventId)
    const s = normSummary(await get(`${SITE}/summary?event=${eventId}`, opts), fam)
    if (s.status?.state === 'post') {
      matches.set(eventId, s)
      if (matches.size > 2500) matches.delete(matches.keys().next().value)
    }
    return s
  }
  async function teamSchedule(teamId, season, opts) {
    const key = `${teamId}:${season}`
    const hit = schedules.get(key)
    if (hit && Date.now() - hit.at < 2 * 60_000) return hit.p
    const p = get(`${SITE}/teams/${teamId}/schedule?season=${season}`, opts).then((j) => normSchedule(j, teamId))
    schedules.set(key, { at: Date.now(), p })
    p.catch(() => schedules.delete(key))
    return p
  }
  /** Every player's rows for one team and season, from its finished league matches. */
  async function buildTeamLog(teamId, season, done, opts) {
    const out = new Map()
    const queue = [...done]
    const work = async () => {
      while (queue.length) {
        const g = queue.shift()
        let m
        try {
          m = await finalMatch(g.id, opts)
        } catch {
          continue
        }
        for (const p of Object.values(m.players || {})) {
          if (String(p.teamId) !== String(teamId)) continue
          const rows = out.get(p.id) || []
          rows.push({ eventId: g.id, date: g.date, season: Number(season) || null, post: false, week: null, home: g.home, oppId: g.oppId, oppAbbr: g.oppAbbr, teamId: String(teamId), result: g.result, score: g.pf != null && g.pa != null ? `${g.pf}-${g.pa}` : null, s: p.stats })
          out.set(p.id, rows)
        }
      }
    }
    await Promise.all(Array.from({ length: 4 }, work))
    for (const rows of out.values()) rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
    return out
  }
  async function soccerLog(athleteId, season, opts = {}) {
    const teamId = opts.teamId
    if (!teamId) return []
    const sched = await teamSchedule(teamId, season, opts)
    const finished = sched.filter((g) => g.completed)
    // the season on now gets its last 15 matches; an earlier one its last 8, for a longer sample
    const done = finished.slice(-(opts.current === false ? MAX_MATCHES.earlier : MAX_MATCHES.current))
    // keyed by the last finished match, so a new result builds a new log and an old one is reused
    const key = `${teamId}:${season}:${done.length ? done[done.length - 1].id : 'none'}`
    let p = teamLogs.get(key)
    if (!p) {
      p = buildTeamLog(teamId, season, done, opts)
      teamLogs.set(key, p)
      p.catch(() => teamLogs.delete(key))
      if (teamLogs.size > 400) teamLogs.delete(teamLogs.keys().next().value)
    }
    return (await p).get(String(athleteId)) || []
  }

  return {
    urls: { SITE, WEB, CORE },
    scoreboard: async (params = {}, opts) => normScoreboard(await scoreboardJson(params, opts)),
    summary: async (eventId, opts) => normSummary(await get(`${SITE}/summary?event=${eventId}`, opts), fam),
    teams: async (opts) => normTeams(await get(`${SITE}/teams`, opts)),
    roster: async (teamId, opts) => normRoster(await get(`${SITE}/teams/${teamId}/roster`, opts), teamId, headshots),
    schedule: async (teamId, season, opts) => normSchedule(await get(`${SITE}/teams/${teamId}/schedule?season=${season}`, opts), teamId),
    gamelog: async (athleteId, season, opts) => (fam.LOGS_FROM_SUMMARIES ? soccerLog(athleteId, season, opts) : normGamelog(await get(`${WEB}/athletes/${athleteId}/gamelog?season=${season}`, opts), season, fam)),
    propBets,
  }
}

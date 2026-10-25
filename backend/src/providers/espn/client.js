// ESPN's public JSON APIs (unofficial, no key). site.api for scores and summaries,
// site.web.api for game logs, sports.core.api for prop lines.
import { normScoreboard, normSummary, normTeams, normRoster, normSchedule, normGamelog, normPropBets } from './normalize.js'
import * as football from '../../sports/football.js'

export function createEspnClient({ http, sport = 'football', league = 'nfl', propProvider = 100, fam = football, headshots = 'nfl' } = {}) {
  const SITE = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}`
  const WEB = `https://site.web.api.espn.com/apis/common/v3/sports/${sport}/${league}`
  const CORE = `https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${league}`
  const get = (url, opts) => http.getJson(url, opts)

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

  return {
    urls: { SITE, WEB, CORE },
    scoreboard: async (params = {}, opts) => {
      const q = new URLSearchParams()
      if (params.week) q.set('week', String(params.week))
      if (params.seasonType) q.set('seasontype', String(params.seasonType))
      if (params.dates) q.set('dates', String(params.dates))
      const qs = q.toString()
      return normScoreboard(await get(`${SITE}/scoreboard${qs ? `?${qs}` : ''}`, opts))
    },
    summary: async (eventId, opts) => normSummary(await get(`${SITE}/summary?event=${eventId}`, opts), fam),
    teams: async (opts) => normTeams(await get(`${SITE}/teams`, opts)),
    roster: async (teamId, opts) => normRoster(await get(`${SITE}/teams/${teamId}/roster`, opts), teamId, headshots),
    schedule: async (teamId, season, opts) => normSchedule(await get(`${SITE}/teams/${teamId}/schedule?season=${season}`, opts), teamId),
    gamelog: async (athleteId, season, opts) => normGamelog(await get(`${WEB}/athletes/${athleteId}/gamelog?season=${season}`, opts), season, fam),
    propBets,
  }
}

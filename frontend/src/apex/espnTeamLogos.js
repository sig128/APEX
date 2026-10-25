/**
 * Load ESPN team → logo URL maps (public API, CORS open).
 * Used to show real logos for carousel matchups (Odds API only provides team names).
 */

const ESPN_TEAM_ENDPOINTS = {
  icehockey_nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams',
  basketball_nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams',
  americanfootball_nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams',
  baseball_mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams',
}

/** @type {Record<string, Map<string, string>> | null} */
let cachedMaps = null
/** @type {Promise<Record<string, Map<string, string>>> | null} */
let loadPromise = null

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
}

function pickLogoHref(team) {
  const logos = team?.logos
  if (!Array.isArray(logos) || logos.length === 0) return null
  const def = logos.find((l) => Array.isArray(l.rel) && l.rel.includes('default') && l.rel.includes('full'))
  return def?.href || logos[0]?.href || null
}

function collectNameKeys(team) {
  const s = new Set()
  if (team.displayName) s.add(team.displayName)
  if (team.name) s.add(team.name)
  if (team.shortDisplayName) s.add(team.shortDisplayName)
  if (team.nickname) s.add(team.nickname)
  if (team.location && team.name) s.add(`${team.location} ${team.name}`)
  if (team.abbreviation) s.add(team.abbreviation)
  if (team.abbreviation) s.add(team.abbreviation.toLowerCase())
  return [...s].filter(Boolean)
}

/**
 * @returns {Promise<Record<string, Map<string, string>>>}
 */
export function loadEspnTeamLogos() {
  if (cachedMaps) return Promise.resolve(cachedMaps)
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    /** @type {Record<string, Map<string, string>>} */
    const empty = () => ({
      icehockey_nhl: new Map(),
      basketball_nba: new Map(),
      americanfootball_nfl: new Map(),
      baseball_mlb: new Map(),
    })

    try {
      const out = empty()

      await Promise.all(
        Object.entries(ESPN_TEAM_ENDPOINTS).map(async ([sportKey, url]) => {
          try {
            const res = await fetch(url, { cache: 'force-cache' })
            if (!res.ok) return
            const j = await res.json()
            const teams = j?.sports?.[0]?.leagues?.[0]?.teams
            if (!Array.isArray(teams)) return
            const map = out[sportKey]
            for (const row of teams) {
              const team = row?.team
              const href = pickLogoHref(team)
              if (!href) continue
              for (const raw of collectNameKeys(team)) {
                map.set(normalize(raw), href)
              }
            }
          } catch {
            /* keep empty map for this league */
          }
        }),
      )

      cachedMaps = out
      return out
    } catch {
      cachedMaps = empty()
      return cachedMaps
    }
  })()

  return loadPromise
}

/**
 * @param {Record<string, Map<string, string>>} maps
 * @param {string} sportKey - Odds API sport_key e.g. icehockey_nhl
 * @param {string} teamName - full name from Odds e.g. "Toronto Maple Leafs"
 * @returns {string | null}
 */
export function resolveTeamLogoUrl(maps, sportKey, teamName) {
  const map = maps?.[sportKey]
  if (!map || !teamName) return null

  const n = normalize(teamName)
  if (map.has(n)) return map.get(n) ?? null

  const words = n.split(/\s+/).filter(Boolean)
  for (let len = Math.min(4, words.length); len >= 1; len--) {
    const tail = words.slice(-len).join(' ')
    if (map.has(tail)) return map.get(tail) ?? null
    const head = words.slice(0, len).join(' ')
    if (map.has(head)) return map.get(head) ?? null
  }

  for (const [k, href] of map) {
    if (k.length < 12) continue
    if (n.endsWith(k) || k.endsWith(n)) return href
  }

  return null
}

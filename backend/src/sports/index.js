// The sports Propify covers. Each league runs its own engine on the same analytics; a family holds
// what's specific to the sport (markets, positions, roles, how ESPN writes its stats).
import * as football from './football.js'
import * as basketball from './basketball.js'
import * as hockey from './hockey.js'
import * as baseball from './baseball.js'

export const FAMILIES = { football, basketball, hockey, baseball }

/**
 * key: our URL and API prefix. espn: ESPN's sport/league path. calendar: 'week' slates (the
 * scoreboard is the week) or 'day' slates (today and tomorrow). headshots: ESPN's image folder.
 * offseason: months (1-12) when there's usually nothing on the board.
 */
export const SPORTS = {
  nfl: { key: 'nfl', name: 'NFL', title: 'NFL', family: 'football', espn: { sport: 'football', league: 'nfl' }, calendar: 'week', headshots: 'nfl', offseason: [3, 4, 5, 6, 7] },
  nba: { key: 'nba', name: 'NBA', title: 'NBA', family: 'basketball', espn: { sport: 'basketball', league: 'nba' }, calendar: 'day', headshots: 'nba', offseason: [7, 8, 9] },
  mlb: { key: 'mlb', name: 'MLB', title: 'MLB', family: 'baseball', espn: { sport: 'baseball', league: 'mlb' }, calendar: 'day', headshots: 'mlb', offseason: [11, 12, 1, 2] },
  nhl: { key: 'nhl', name: 'NHL', title: 'NHL', family: 'hockey', espn: { sport: 'hockey', league: 'nhl' }, calendar: 'day', headshots: 'nhl', offseason: [7, 8, 9] },
  ncaaf: { key: 'ncaaf', name: 'NCAAF', title: 'College Football', family: 'football', espn: { sport: 'football', league: 'college-football' }, calendar: 'week', headshots: 'college-football', offseason: [2, 3, 4, 5, 6, 7] },
  ncaab: { key: 'ncaab', name: 'NCAAB', title: 'College Basketball', family: 'basketball', espn: { sport: 'basketball', league: 'mens-college-basketball' }, calendar: 'day', headshots: 'mens-college-basketball', offseason: [5, 6, 7, 8, 9, 10] },
  wnba: { key: 'wnba', name: 'WNBA', title: 'WNBA', family: 'basketball', espn: { sport: 'basketball', league: 'wnba' }, calendar: 'day', headshots: 'wnba', offseason: [11, 12, 1, 2, 3, 4] },
}
export const SPORT_KEYS = Object.keys(SPORTS)

/** The sport config with its family attached: sportOf('nba').fam.MARKETS. */
export function sportOf(key) {
  const s = SPORTS[key] || SPORTS.nfl
  return { ...s, fam: FAMILIES[s.family] }
}

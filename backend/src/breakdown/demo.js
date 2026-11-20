// The Bet Breakdown's demo: a made-up three-leg parlay (two legs won, one missed), labelled as
// demo data everywhere. Two versions: one with an event feed, one with only the box score, to
// show how the explanation changes when there's less evidence.
const T_POSTED = Date.parse('2026-11-14T22:05:00Z')
const T_FINAL = Date.parse('2026-11-15T03:10:00Z')
const T_GRADED = Date.parse('2026-11-15T03:40:00Z')

export function demoPick() {
  const leg = (x) => ({ sport: 'nba', gameId: 'demo-game', kickoff: Date.parse('2026-11-15T00:30:00Z'), book: 'Demo book', teamAbbr: 'HOME', oppAbbr: 'AWAY', ...x })
  return {
    id: 'demo',
    demo: true,
    createdAt: T_POSTED,
    gradedAt: T_GRADED,
    status: 'graded',
    result: 'loss',
    profit: -1,
    units: 1,
    decimal: 6.24,
    legs: [
      leg({ id: 'demoA.pts.o.24.5', playerId: 'demoA', name: 'Player A', short: 'Player A', market: 'pts', label: 'Over 24.5 Points', line: 24.5, side: 'o', price: -115, prob: 0.56, fair: -127, proj: 26.8, result: 'win', value: 29 }),
      leg({ id: 'demoB.reb.o.7.5', playerId: 'demoB', name: 'Player B', short: 'Player B', market: 'reb', label: 'Over 7.5 Rebounds', line: 7.5, side: 'o', price: -110, prob: 0.58, fair: -138, proj: 8.6, result: 'win', value: 10 }),
      leg({ id: 'demoC.ast.o.5.5', playerId: 'demoC', name: 'Player C', short: 'Player C', market: 'ast', label: 'Over 5.5 Assists', line: 5.5, side: 'o', price: -105, prob: 0.55, fair: -122, proj: 6.4, projMin: 34, result: 'loss', value: 4 }),
    ],
  }
}

/** The demo game: a box score, and (in the 'events' version) the event that mattered. */
export function demoGames(mode = 'events') {
  const summary = {
    status: { state: 'post', period: 4 },
    home: { abbr: 'HOME', score: 112 },
    away: { abbr: 'AWAY', score: 108 },
    players: {
      demoA: { stats: { min: 36, pf: 2, pts: 29 } },
      demoB: { stats: { min: 33, pf: 3, reb: 10 } },
      demoC: { stats: { min: 24, pf: 5, ast: 4 } },
    },
  }
  const events = mode === 'events' ? { demoC: [{ label: 'Foul trouble', text: 'his fourth foul early in the third quarter', period: 3, clock: '10:48', at: T_FINAL - 80 * 60_000 }] } : {}
  return new Map([['demo-game', { summary, retrievedAt: T_FINAL + 15 * 60_000, source: 'Demo game feed', events }]])
}

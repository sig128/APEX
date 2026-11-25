// The lineup view: ESPN's depth charts and match lineups, laid out per sport with the player in
// focus marked and the opponents he faces picked out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normDepth, normMatchLineups, normBoxStarters, probablesOf } from '../src/providers/espn/lineups.js'
import { buildView, chartFromStarters, rowOf } from '../src/lineups/build.js'
import { createLineups } from '../src/lineups/service.js'

const ath = (id, name, inj) => ({ id: String(id), displayName: name, shortName: name.replace(/^(\w)\w* /, '$1. '), injuries: inj ? [{ status: inj, shortComment: `${inj} (knee)` }] : [] })
const pos = (abbr, ...athletes) => ({ position: { abbreviation: abbr, displayName: abbr }, athletes })

function nflCharts(p) {
  return normDepth({
    depthchart: [
      {
        id: '21',
        name: '3WR 1TE',
        positions: {
          wr1: pos('WR', ath(`${p}01`, 'Will One')),
          wr2: pos('WR', ath(`${p}02`, 'Will Two')),
          wr3: pos('WR', ath(`${p}03`, 'Sly Slot'), ath(`${p}04`, 'Ben Backup')),
          lt: pos('LT', ath(`${p}10`, 'Lee Tackle')),
          lg: pos('LG', ath(`${p}11`, 'Leo Guard')),
          c: pos('C', ath(`${p}12`, 'Cal Center')),
          rg: pos('RG', ath(`${p}13`, 'Rob Guard')),
          rt: pos('RT', ath(`${p}14`, 'Rex Tackle')),
          te: pos('TE', ath(`${p}20`, 'Ty End')),
          qb: pos('QB', ath(`${p}30`, 'Quinn Back')),
          rb: pos('RB', ath(`${p}40`, 'Ray Runner'), ath(`${p}41`, 'Rudy Second')),
        },
      },
      {
        id: '15',
        name: 'Base 3-4 D',
        positions: {
          lde: pos('DE', ath(`${p}50`, 'Lou End')),
          nt: pos('NT', ath(`${p}51`, 'Ned Tackle')),
          rde: pos('DE', ath(`${p}52`, 'Ron End')),
          wlb: pos('OLB', ath(`${p}60`, 'Wes Backer')),
          lilb: pos('ILB', ath(`${p}61`, 'Liam Inside')),
          rilb: pos('ILB', ath(`${p}62`, 'Ryan Inside')),
          slb: pos('OLB', ath(`${p}63`, 'Sam Backer')),
          lcb: pos('CB', ath(`${p}70`, 'Lane Corner')),
          rcb: pos('CB', ath(`${p}71`, 'Ross Corner', 'Out'), ath(`${p}72`, 'Rick Fill')),
          nb: pos('NB', ath(`${p}73`, 'Nick Nickel')),
          fs: pos('FS', ath(`${p}80`, 'Fred Free')),
          ss: pos('SS', ath(`${p}81`, 'Stan Strong')),
        },
      },
      { id: '18', name: 'Special Teams', positions: { pk: pos('PK', ath(`${p}90`, 'Kip Kicker')) } },
    ],
  })
}

const GB = { id: '9', abbr: 'GB', name: 'Packers' }
const SEA = { id: '26', abbr: 'SEA', name: 'Seahawks' }

test('ESPN depth charts normalize: position keys, depth order and injury notes', () => {
  const charts = nflCharts('9')
  assert.equal(charts.length, 3)
  assert.equal(charts[0].name, '3WR 1TE')
  assert.deepEqual(Object.keys(charts[0].slots).slice(0, 3), ['wr1', 'wr2', 'wr3'])
  const rcb = charts[1].slots.rcb
  assert.equal(rcb.pos, 'CB')
  assert.deepEqual(rcb.players.map((x) => [x.id, x.rank]), [['971', 1], ['972', 2]])
  assert.deepEqual(rcb.players[0].inj, { status: 'Out', note: 'Out (knee)' })
  assert.deepEqual(normDepth(null), [])
})

test('football: a receiver gets the opponent defense above his offense, the corner on his side and a safety', () => {
  const v = buildView('football', { mine: nflCharts('9'), theirs: nflCharts('26'), myTeam: GB, oppTeam: SEA, focusId: '901', focusPos: 'WR' })
  assert.equal(v.top.team.abbr, 'SEA')
  assert.equal(v.top.label, 'Defense')
  assert.equal(v.top.formation, 'Base 3-4 D')
  assert.equal(v.bottom.team.abbr, 'GB')
  assert.equal(v.bottom.slots.length, 11)
  assert.deepEqual(v.focus, { key: 'wr1', pos: 'WR', rank: 1 })
  assert.equal(v.bottom.slots.find((s) => s.key === 'wr1').focus, true)
  // the listed right corner is out: the next one stands in, and the page says for whom
  const rcb = v.top.slots.find((s) => s.key === 'rcb')
  assert.equal(rcb.player.name, 'Rick Fill')
  assert.equal(rcb.out.name, 'Ross Corner')
  assert.equal(v.matchups[0].title, 'Likely in coverage')
  assert.deepEqual(v.matchups[0].players.map((x) => x.name), ['Rick Fill'])
  assert.deepEqual(v.matchups[1].players.map((x) => x.name), ['Fred Free'])
  assert.equal(rcb.match, 2)
  // the special teams chart and its kicker stay off the field
  assert.ok(!v.top.slots.concat(v.bottom.slots).some((s) => s.key === 'pk'))
})

test('football: the slot receiver draws the nickel, a backup is noted behind the starter, a defender flips the view', () => {
  const slot = buildView('football', { mine: nflCharts('9'), theirs: nflCharts('26'), myTeam: GB, oppTeam: SEA, focusId: '903', focusPos: 'WR' })
  assert.deepEqual(slot.matchups[0].players.map((x) => x.name), ['Nick Nickel'])
  const backup = buildView('football', { mine: nflCharts('9'), theirs: nflCharts('26'), myTeam: GB, oppTeam: SEA, focusId: '941', focusPos: 'RB' })
  assert.equal(backup.focus.rank, 2)
  assert.equal(backup.focus.behind.name, 'Ray Runner')
  assert.equal(backup.bottom.slots.find((s) => s.key === 'rb').focus, 'behind')
  const corner = buildView('football', { mine: nflCharts('9'), theirs: nflCharts('26'), myTeam: GB, oppTeam: SEA, focusId: '970', focusPos: 'CB' })
  assert.equal(corner.top.team.abbr, 'GB', 'his own defense on top')
  assert.equal(corner.bottom.team.abbr, 'SEA')
  assert.equal(corner.matchups[0].title, 'Receivers he likely covers')
  assert.deepEqual(corner.matchups[0].players.map((x) => x.name), ['Will Two'])
  const nickel = buildView('football', { mine: nflCharts('9'), theirs: nflCharts('26'), myTeam: GB, oppTeam: SEA, focusId: '973', focusPos: 'CB' })
  assert.deepEqual(nickel.matchups[0].players.map((x) => x.name), ['Sly Slot', 'Ty End'])
  const qb = buildView('football', { mine: nflCharts('9'), theirs: nflCharts('26'), myTeam: GB, oppTeam: SEA, focusId: '930', focusPos: 'QB' })
  assert.deepEqual(qb.matchups.map((m) => m.title), ['Pass rush', 'Secondary'])
  assert.equal(qb.matchups[0].players.length, 3)
})

function nbaChart(p, out) {
  return normDepth({ depthchart: [{ id: '1', name: 'Depth Chart', positions: { pg: pos('PG', ath(`${p}1`, 'Pat Point'), ath(`${p}6`, 'Paul Second')), sg: pos('SG', ath(`${p}2`, 'Sid Shoot')), sf: pos('SF', ath(`${p}3`, 'Sal Small')), pf: pos('PF', ath(`${p}4`, 'Pete Power', out), ath(`${p}7`, 'Phil Bench')), c: pos('C', ath(`${p}4`, 'Pete Power', out), ath(`${p}5`, 'Cy Center')) } }] })
}

test('basketball: each starter over his counterpart; a player on two spots starts once', () => {
  const v = buildView('basketball', { mine: nbaChart('18'), theirs: nbaChart('2', 'Out'), myTeam: { id: '18', abbr: 'NY' }, oppTeam: { id: '2', abbr: 'BOS' }, focusId: '182' })
  assert.deepEqual(v.bottom.slots.map((s) => s.player.name), ['Pat Point', 'Sid Shoot', 'Sal Small', 'Pete Power', 'Cy Center'])
  // their power forward is out: the next healthy players start, and nobody starts twice
  assert.deepEqual(v.top.slots.map((s) => s.player.name), ['Pat Point', 'Sid Shoot', 'Sal Small', 'Phil Bench', 'Cy Center'])
  assert.equal(v.top.slots[3].out.name, 'Pete Power')
  assert.equal(v.matchups[0].title, 'Opposing SG')
  assert.deepEqual(v.matchups[0].players.map((x) => x.name), ['Sid Shoot'])
  const bench = buildView('basketball', { mine: nbaChart('18'), theirs: nbaChart('2'), myTeam: { id: '18' }, oppTeam: { id: '2' }, focusId: '186' })
  assert.equal(bench.focus.rank, 2)
  assert.equal(bench.focus.key, 'pg')
})

test('basketball: five box-score starters make a chart, guards to center', () => {
  const box = normBoxStarters({ boxscore: { players: [{ team: { id: '7' }, statistics: [{ athletes: [{ starter: true, athlete: { id: '1', displayName: 'Ana C', position: { abbreviation: 'C' } } }, { starter: true, athlete: { id: '2', displayName: 'Bea G', position: { abbreviation: 'G' } } }, { starter: false, athlete: { id: '9', displayName: 'Bench', position: { abbreviation: 'F' } } }, { starter: true, athlete: { id: '3', displayName: 'Cat F', position: { abbreviation: 'F' } } }, { starter: true, athlete: { id: '4', displayName: 'Di G', position: { abbreviation: 'G' } } }, { starter: true, athlete: { id: '5', displayName: 'Eve F', position: { abbreviation: 'F' } } }] }] }] } })
  assert.equal(box['7'].length, 5)
  const chart = chartFromStarters(box['7'])
  assert.deepEqual(Object.fromEntries(Object.entries(chart.slots).map(([k, s]) => [k, s.players[0].name])), { pg: 'Bea G', sg: 'Di G', sf: 'Cat F', pf: 'Eve F', c: 'Ana C' })
})

test('hockey: a second-line center gets his line, the goalie he shoots at and the center he faces off against', () => {
  const chart = (p) => normDepth({ depthchart: [{ id: '1', name: 'Default', positions: { c: pos('C', ath(`${p}1`, 'Cee One'), ath(`${p}2`, 'Cee Two')), lw: pos('LW', ath(`${p}3`, 'Lefty One'), ath(`${p}4`, 'Lefty Two')), rw: pos('RW', ath(`${p}5`, 'Righty One'), ath(`${p}6`, 'Righty Two')), ld: pos('LD', ath(`${p}7`, 'Dee Left')), rd: pos('RD', ath(`${p}8`, 'Dee Right')), g: pos('G', ath(`${p}9`, 'Gil Goalie'), ath(`${p}0`, 'Gus Backup')) } }] })
  const v = buildView('hockey', { mine: chart('21'), theirs: chart('8'), myTeam: { id: '21' }, oppTeam: { id: '8' }, focusId: '212' })
  assert.equal(v.bottom.label, 'Line 2')
  assert.deepEqual(v.bottom.slots.filter((s) => ['lw', 'c', 'rw'].includes(s.key)).map((s) => s.player.name), ['Lefty Two', 'Cee Two', 'Righty Two'])
  assert.deepEqual(v.matchups.map((m) => [m.title, m.players[0].name]), [['In goal against him', 'Gil Goalie'], ['Faceoffs against', 'Cee One']])
  // they face down: their left wing is drawn on the right
  assert.ok(v.top.slots.find((s) => s.key === 'lw').x > v.top.slots.find((s) => s.key === 'rw').x)
})

test('baseball: the probable starter takes the mound; a hitter faces him, a pitcher faces the lineup', () => {
  const chart = (p) => normDepth({ depthchart: [{ id: '1', name: 'Depth Chart', positions: { p: pos('SP', ath(`${p}1`, 'Ace Arm')), c: pos('C', ath(`${p}2`, 'Cat Cher')), '1b': pos('1B', ath(`${p}3`, 'First Base')), ss: pos('SS', ath(`${p}4`, 'Shorty Stop')), cf: pos('CF', ath(`${p}5`, 'Center Field')) } }] })
  const probables = probablesOf([{ team: { id: '10' }, probables: [{ athlete: { id: '109', displayName: 'Today Starter', shortName: 'T. Starter' } }] }, { team: { id: '1' } }])
  assert.deepEqual(Object.keys(probables), ['10'])
  const hitter = buildView('baseball', { mine: chart('1'), theirs: chart('10'), myTeam: { id: '1' }, oppTeam: { id: '10' }, focusId: '14', focusPos: 'SS', probables })
  assert.deepEqual(hitter.matchups.map((m) => [m.title, m.players[0].name]), [['On the mound against him', 'Today Starter']])
  // no probable for his own side: the top of the rotation stands on his mound
  assert.equal(hitter.bottom.slots.find((s) => s.key === 'sp').player.name, 'Ace Arm')
  const arm = buildView('baseball', { mine: chart('10'), theirs: chart('1'), myTeam: { id: '10' }, oppTeam: { id: '1' }, focusId: '109', focusPos: 'SP', probables })
  assert.equal(arm.focus.key, 'sp')
  assert.equal(arm.matchups[0].title, 'Lineup he faces')
  assert.equal(arm.matchups[0].players.length, 4)
})

const XI = (p, formation) => ({
  team: { id: p },
  formation,
  roster: [
    ['G', 'Keeper'],
    ['RB', 'Right Back'],
    ['CD-R', 'Cee Right'],
    ['CD-L', 'Cee Left'],
    ['LB', 'Left Back'],
    ['CM-R', 'Mid Right'],
    ['DM', 'Holder'],
    ['CM-L', 'Mid Left'],
    ['RW', 'Right Wing'],
    ['F', 'Striker'],
    ['LW', 'Left Wing'],
    ['SUB', 'Sub One', false],
  ].map(([abbr, name, starter = true], i) => ({ starter, jersey: String(i + 1), formationPlace: String(i + 1), position: { abbreviation: abbr }, athlete: { id: `${p}${i}`, displayName: `${name} ${p}`, shortName: `${name[0]}. ${p}` } })),
})

test('soccer: both elevens in formation rows; a left winger is matched with their right back', () => {
  const m = normMatchLineups({ rosters: [XI('359', '4-3-3'), XI('363', '4-2-3-1')] })
  assert.equal(m['359'].formation, '4-3-3')
  assert.equal(m['359'].players.length, 11, 'starters only')
  assert.deepEqual(['G', 'CD-L', 'LB', 'DM', 'CM-R', 'AM', 'LW', 'F', 'M'].map(rowOf), ['gk', 'def', 'def', 'dm', 'mid', 'am', 'fw', 'fw', 'mid'])
  const v = buildView('soccer', { myLineup: m['359'], theirLineup: m['363'], myTeam: { id: '359' }, oppTeam: { id: '363' }, focusId: '35910' })
  const rows = (u) => [...new Set(u.slots.map((s) => s.row))]
  assert.deepEqual(rows(v.bottom), ['gk', 'def', 'dm', 'mid', 'fw'])
  const lw = v.bottom.slots.find((s) => s.focus)
  assert.equal(lw.player.name, 'Left Wing 359')
  assert.ok(lw.x < 0.5, 'his left wing is on the left')
  assert.equal(v.matchups[0].title, 'Defenders on him')
  assert.equal(v.matchups[0].players[0].name, 'Right Back 363')
})

// ---- the service: caching and fallbacks ---------------------------------------------------------

function fakeEngine({ family = 'football', key = 'nfl', row, games, schedules = {}, injuries = {} }) {
  return {
    sport: { key, family },
    views: { prop: (id) => (id === row.id ? { prop: row } : null) },
    wh: {
      games: new Map(games.map((g) => [g.id, g])),
      players: new Map([[row.playerId, { pos: row.pos }]]),
      schedules: new Map(Object.entries(schedules)),
      injuryOf: (id) => injuries[id] || null,
    },
  }
}

test('service: a prop gets its game\'s lineups, cached; fresher injury news overrides the chart', async () => {
  const calls = []
  const provider = { depthChart: async (tid) => (calls.push(tid), nflCharts(tid)), gameLineups: async () => null, probables: async () => ({}) }
  const row = { id: '901.recYds.o.55.5', kind: 'player', playerId: '901', teamId: '9', gameId: '401', short: 'W. One', name: 'Will One', pos: 'WR' }
  const engine = fakeEngine({ row, games: [{ id: '401', date: '2026-11-29T18:00:00Z', status: { state: 'pre' }, home: { id: '9', abbr: 'GB', name: 'Packers' }, away: { id: '26', abbr: 'SEA', name: 'Seahawks' } }], injuries: { 2672: { status: 'Questionable', detail: 'hamstring' } } })
  const l = createLineups({ engine, provider })
  const a = await l.forProp(row.id)
  assert.equal(a.view.top.team.abbr, 'SEA')
  assert.deepEqual(a.notes, ['Projected from each team’s depth chart. A starter listed as out is replaced by the next player on it.'])
  assert.equal(a.focusNote, null)
  assert.equal(a.focusName, 'W. One')
  // the stand-in corner's injury report entry is newer than the chart's empty one
  assert.deepEqual(a.view.top.slots.find((s) => s.key === 'rcb').player.inj, { status: 'Questionable', note: 'hamstring' })
  await l.forProp(row.id)
  assert.deepEqual(calls.sort(), ['26', '9'], 'each depth chart fetched once')
  assert.equal(await l.forProp('nope'), null)
})

test('service: basketball without a depth chart uses the last game\'s starters; soccer falls back to the last match', async () => {
  const box = { boxscore: { players: [{ team: { id: '5' }, statistics: [{ athletes: [1, 2, 3, 4, 5].map((i) => ({ starter: true, athlete: { id: `5${i}`, displayName: `Five ${i}`, position: { abbreviation: i < 3 ? 'G' : i < 5 ? 'F' : 'C' } } })) }] }, { team: { id: '6' }, statistics: [{ athletes: [1, 2, 3, 4, 5].map((i) => ({ starter: true, athlete: { id: `6${i}`, displayName: `Six ${i}`, position: { abbreviation: 'G' } } })) }] }] } }
  const provider = { depthChart: async () => [], gameLineups: async (id) => (id === '700' ? { match: {}, starters: normBoxStarters(box), probables: {} } : { match: {}, starters: {}, probables: {} }), probables: async () => ({}) }
  const row = { id: '53.pts.o.20.5', kind: 'player', playerId: '53', teamId: '5', gameId: '800', short: 'F. 3', pos: 'F' }
  const schedules = { 5: { games: [{ id: '700', date: '2026-11-20T00:00:00Z', completed: true }, { id: '800', date: '2026-11-26T00:00:00Z', completed: false }] }, 6: { games: [{ id: '700', date: '2026-11-20T00:00:00Z', completed: true }] } }
  const engine = fakeEngine({ family: 'basketball', key: 'ncaab', row, schedules, games: [{ id: '800', date: '2026-11-26T00:00:00Z', status: { state: 'pre' }, home: { id: '5', abbr: 'AAA' }, away: { id: '6', abbr: 'BBB' } }] })
  const v = await createLineups({ engine, provider }).forProp(row.id)
  assert.deepEqual(v.notes, ['No depth chart for this league: each team’s five starters from its last game.'])
  assert.equal(v.view.bottom.slots.find((s) => s.focus).player.name, 'Five 3')

  const lastXI = { rosters: [XI('359', '4-3-3'), XI('363', '4-4-2')] }
  const soccerProvider = { depthChart: async () => [], gameLineups: async (id) => (id === '1' ? { match: normMatchLineups(lastXI), starters: {}, probables: {} } : { match: {}, starters: {}, probables: {} }), probables: async () => ({}) }
  const srow = { id: '3599.anyGoalS.o.0.5', kind: 'player', playerId: '3599', teamId: '359', gameId: '2', short: 'S. 359', pos: 'F' }
  const sengine = fakeEngine({ family: 'soccer', key: 'epl', row: srow, schedules: { 359: { games: [{ id: '1', date: '2026-11-21T15:00:00Z', completed: true }] }, 363: { games: [{ id: '1', date: '2026-11-21T15:00:00Z', completed: true }] } }, games: [{ id: '2', date: '2026-11-29T15:00:00Z', status: { state: 'pre' }, home: { id: '359', abbr: 'ARS' }, away: { id: '363', abbr: 'CHE' } }] })
  const s = await createLineups({ engine: sengine, provider: soccerProvider }).forProp(srow.id)
  assert.deepEqual(s.notes, ['Each team’s lineup from its last match. Today’s are announced about an hour before kickoff.'])
  assert.equal(s.view.bottom.label, 'Last match’s lineup')
  assert.equal(s.view.bottom.formation, '4-3-3')
  assert.equal(s.view.matchups[0].title, 'Defenders on him')
})

test('service: nothing to draw is a reason, not an error', async () => {
  const provider = { depthChart: async () => { throw new Error('ESPN 500') }, gameLineups: async () => null, probables: async () => ({}) }
  const row = { id: '901.recYds.o.55.5', kind: 'player', playerId: '901', teamId: '9', gameId: '401', pos: 'WR' }
  const engine = fakeEngine({ row, games: [{ id: '401', date: '2026-11-29T18:00:00Z', status: { state: 'pre' }, home: { id: '9' }, away: { id: '26' } }] })
  const v = await createLineups({ engine, provider }).forProp(row.id)
  assert.equal(v.view, null)
  assert.equal(v.reason, 'No depth chart for these teams yet.')
})

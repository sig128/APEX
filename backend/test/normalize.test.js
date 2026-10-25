import test from 'node:test'
import assert from 'node:assert/strict'
import { fixtureHttp } from './helpers.js'
import { createEspnClient } from '../src/providers/espn/client.js'

const { http } = fixtureHttp()
const espn = createEspnClient({ http })

test('scoreboard: week 7 slate with odds', async () => {
  const sb = await espn.scoreboard()
  assert.equal(sb.week, 7)
  assert.equal(sb.season, 2026)
  assert.equal(sb.games.length, 14)
  const g = sb.games.find((x) => x.id === '401873017')
  assert.equal(g.shortName, 'SF @ ATL')
  assert.equal(g.status.state, 'pre')
  assert.equal(g.home.abbr, 'ATL')
  assert.equal(g.away.abbr, 'SF')
  assert.equal(g.odds.total, 50.5)
  assert.equal(g.odds.homeSpread, 2.5)
  assert.equal(g.odds.homeMl, 124)
  assert.equal(g.odds.awayMl, -148)
  assert.equal(g.odds.totalOpen, 47.5)
  assert.equal(g.home.record.total, '2-4')
  const final = sb.games.find((x) => x.id === '401873010')
  assert.equal(final.status.state, 'post')
})

test('summary: final box score parses split cells', async () => {
  const s = await espn.summary('401873010')
  assert.equal(s.status.state, 'post')
  assert.equal(s.home.abbr, 'CHI')
  const maye = s.players['4431452']
  assert.equal(maye.name, 'Drake Maye')
  assert.equal(maye.stats.passCmp, 24)
  assert.equal(maye.stats.passAtt, 31)
  assert.equal(maye.stats.passYds, 321)
  assert.equal(maye.stats.sacksTaken, 2)
  assert.ok(s.winProb.length > 50)
  assert.ok(s.homeWinPct > 90, 'home won, final win prob near 100')
  assert.ok(s.lastDrive)
})

test('summary: pre-game sections', async () => {
  const s = await espn.summary('401873020')
  assert.equal(s.status.state, 'pre')
  assert.equal(s.odds.homeSpread, -3.5)
  assert.equal(s.odds.homeMl, -180)
  assert.ok(s.injuries.length > 3)
  assert.ok(s.injuries.every((i) => i.athleteId && i.teamId))
  assert.equal(Object.keys(s.lastFive).length, 2)
  assert.ok(s.predictor.home > 50)
})

test('live college summary has a current drive and live box', async () => {
  const s = await espn.summary.call(null, '401856732').catch(() => null)
  assert.equal(s, null, 'nfl client does not see college fixtures')
  const cfb = createEspnClient({ http, league: 'college-football' })
  const live = await cfb.summary('401856732')
  assert.equal(live.status.state, 'in')
  assert.ok(Object.keys(live.players).length > 10)
  assert.ok(live.drive || live.lastDrive)
})

test('roster, schedule, teams', async () => {
  const roster = await espn.roster('8')
  assert.ok(roster.find((p) => p.name === 'Jared Goff' && p.pos === 'QB'))
  const sched = await espn.schedule('8', 2026)
  assert.equal(sched.length, 17)
  assert.equal(sched[0].result, 'W')
  assert.equal(sched[0].pf, 31)
  assert.equal(sched[sched.length - 1].completed, false)
  const teams = await espn.teams()
  assert.equal(teams.length, 32)
})

test('game logs: one row per game with named stats', async () => {
  const log = await espn.gamelog('3046779', 2026)
  assert.ok(log.length >= 5)
  const first = log[0]
  assert.equal(first.oppAbbr, 'NO')
  assert.equal(first.home, true)
  assert.ok(first.s.passYds > 0)
  assert.ok(log.every((r, i) => i === 0 || r.date >= log[i - 1].date))
})

test('prop bets: one main line per player and market', async () => {
  const props = await espn.propBets('401873020')
  const goff = props.find((p) => p.athleteId === '3046779' && p.market === 'passYds')
  assert.equal(goff.line, 291.5)
  assert.equal(goff.open, 279.5)
  const td = props.filter((p) => p.market === 'anyTd')
  assert.ok(td.length > 10 && td.every((p) => p.line === 0.5))
  const team = props.filter((p) => p.market === 'teamPts')
  assert.ok(team.length >= 1 && team.every((p) => p.teamId))
})

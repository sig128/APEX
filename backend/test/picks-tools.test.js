// The tools built on picks: closing prices and CLV, limits and breaks, the tilt check, subscriber
// picks, injury alerts, the coach, live slips, and the availability badges they lean on.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createPicks } from '../src/picks/service.js'
import { coach, THRESHOLD } from '../src/picks/coach.js'
import { nextLimits, effectiveLimits, checkLimits, tiltCheck, RAISE_WAIT_MS } from '../src/picks/rg.js'
import { legClv, pickClv, closeProb, FRESH_MS } from '../src/picks/clv.js'
import { liveChance, slipChance } from '../src/picks/live.js'
import { absences, statusTag, returnRecord, returnRule } from '../src/nfl/analytics/availability.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { ApiError } from '../src/lib/router.js'
import { noVig, americanToDecimal } from '../src/lib/odds.js'
import { MARKETS } from '../src/nfl/markets.js'
import { fullEngine, clock, withEnv, TREASURY, fakeChain } from './support.js'

const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, APEX_USAGE_TZ: 'America/New_York', K_SERVICE: null, APEX_BOARD_MIN: null })
after(() => restoreEnv())

async function rejectsWith(p, code) {
  await assert.rejects(p, (e) => e instanceof ApiError && e.code === code, `expected ${code}`)
}

// ---- pure pieces ---------------------------------------------------------------------------------

test('availability: absences need a long enough run, trades are not absences, returns are counted', () => {
  const sched = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, date: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, oppAbbr: `T${i}`, home: i % 2 === 0, completed: true }))
  const row = (i, pts) => ({ eventId: `g${i}`, s: { pts } })
  // played 0-3, missed 4-6, back for 7-11
  const log = [0, 1, 2, 3, 7, 8, 9, 10, 11].map((i) => row(i, 20 + i))
  const rule = returnRule('basketball', 'G')
  const a = absences({ schedule: sched, log, rule })
  assert.equal(a.returns.length, 5)
  assert.deepEqual(a.returns.map((r) => r.k), [1, 2, 3, 4, 5])
  assert.equal(a.returns[0].missed, 3)
  assert.equal(a.current, null, 'five games back: no longer returning')
  // still in his first games back
  const b = absences({ schedule: sched.slice(0, 9), log: log.filter((r) => Number(r.eventId.slice(1)) < 9), rule })
  assert.deepEqual(b.current, { back: 2, missed: 3 })
  assert.equal(statusTag(null, b).tag, 'returning')
  assert.equal(statusTag({ status: 'Questionable', severity: 'questionable' }, b).tag, 'questionable', 'the injury report wins')
  assert.equal(statusTag({ status: 'Day-To-Day', severity: 'other' }, null).label, 'Day-to-day')
  // one missed game isn't an absence in basketball
  const c = absences({ schedule: sched, log: sched.filter((g) => g.id !== 'g5').map((g, i) => row(Number(g.id.slice(1)), i)), rule })
  assert.equal(c.returns.length, 0)
  // joined the team at game 6: the first five team games aren't an absence
  const d = absences({ schedule: sched, log: [6, 7, 8].map((i) => row(i, 10)), rule })
  assert.equal(d.returns.length, 0)
  // starting pitchers aren't tracked
  assert.equal(returnRule('baseball', 'SP'), null)
  // a game after the log was fetched isn't counted as missed
  const e = absences({ schedule: sched, log: log.filter((r) => r.eventId !== 'g11'), rule, asOf: Date.parse('2026-01-11T12:00:00Z') })
  assert.equal(e.current?.out, undefined)
  // the record against a line, and the panel hiding under three games
  const rec = returnRecord(a.returns, { market: 'pts', line: 28.5, side: 'o' })
  assert.equal(rec.n, 5)
  assert.equal(rec.hits, 3, 'return games scored 27 to 31: 29, 30 and 31 clear 28.5')
  assert.equal(rec.show, true)
  const few = returnRecord(a.returns.slice(0, 2), { market: 'pts', line: 28.5, side: 'o' })
  assert.equal(few.show, false)
})

test('CLV: no-vig closing chance at the same line, fresh closes only, parlays multiply', () => {
  const kick = 1_800_000_000_000
  const leg = { line: 24.5, price: -110, kickoff: kick, close: { price: -130, other: 110, line: 24.5, at: kick - 10 * 60_000 } }
  const p = noVig(-130, 110)[0]
  assert.equal(closeProb(leg.close), p)
  assert.equal(legClv(leg), Math.round((p * americanToDecimal(-110) - 1) * 1e4) / 1e4)
  assert.ok(legClv(leg) > 0, 'took -110 on a side that closed -130: beat the close')
  assert.equal(legClv({ ...leg, close: { ...leg.close, line: 25.5 } }), null, 'line moved: not measured')
  assert.equal(legClv({ ...leg, price: null }), null, 'no real price: not measured')
  assert.equal(legClv({ ...leg, close: { ...leg.close, at: kick - FRESH_MS - 1 } }), null, 'stale close')
  const two = [leg, { ...leg, price: 120, close: { price: 100, other: -120, line: 24.5, at: kick - 60_000 } }]
  const q = noVig(100, -120)[0]
  assert.equal(pickClv(two), Math.round((p * q * americanToDecimal(-110) * americanToDecimal(120) - 1) * 1e4) / 1e4)
  assert.equal(pickClv([leg, { ...leg, close: null }]), null, 'every live leg needs a close')
  assert.equal(pickClv([leg, { ...leg, close: null, result: 'void' }]), legClv(leg), 'a voided leg drops out')
})

test('limits: tighter now, looser after a day; breaks and the tilt check', () => {
  const t = 1_800_000_000_000
  const a = nextLimits(null, { picksDay: 3, unitsDay: null, unitsWeek: null, lossWeek: 10 }, t)
  assert.deepEqual(effectiveLimits(a, t), { picksDay: 3, unitsDay: null, unitsWeek: null, lossWeek: 10 })
  assert.equal(a.pending, null)
  const b = nextLimits(a, { picksDay: 6, unitsDay: null, unitsWeek: null, lossWeek: 5 }, t + 1000)
  assert.equal(effectiveLimits(b, t + 2000).picksDay, 3, 'a raise waits')
  assert.equal(effectiveLimits(b, t + 2000).lossWeek, 5, 'a cut is immediate')
  assert.equal(effectiveLimits(b, t + 1000 + RAISE_WAIT_MS).picksDay, 6)
  const c = nextLimits(b, { picksDay: null, unitsDay: null, unitsWeek: null, lossWeek: 5 }, t + 3000)
  assert.equal(effectiveLimits(c, t + 4000).picksDay, 3, 'removing a limit waits too')
  assert.throws(() => checkLimits({ picksDay: 3 }, { picksToday: 3, unitsToday: 0, unitsWeek: 0, netWeek: 0 }, { picks: 1, units: 1 }), (e) => e.code === 'limit_picks')
  assert.throws(() => checkLimits({ unitsDay: 5 }, { picksToday: 0, unitsToday: 4.5, unitsWeek: 0, netWeek: 0 }, { picks: 1, units: 1 }), (e) => e.code === 'limit_units_day')
  assert.throws(() => checkLimits({ lossWeek: 5 }, { picksToday: 0, unitsToday: 0, unitsWeek: 0, netWeek: -5.5 }, { picks: 1, units: 1 }), (e) => e.code === 'limit_loss')
  checkLimits({ lossWeek: 5 }, { picksToday: 0, unitsToday: 0, unitsWeek: 0, netWeek: -4 }, { picks: 1, units: 1 })
  const stats = { all: { wins: 4, losses: 6, risked: 10 }, recent: ['L', 'L', 'L', 'W'] }
  assert.equal(tiltCheck(stats, 1.5), null, 'a normal stake is fine')
  assert.deepEqual(tiltCheck(stats, 2), { streak: 3, usual: 1, units: 2, ratio: 2 })
  assert.equal(tiltCheck({ ...stats, recent: ['L', 'L', 'W'] }, 5), null, 'two losses is not a streak')
})

test('coach: only patterns with enough picks, each traced to its picks', () => {
  const t0 = Date.parse('2026-10-01T18:00:00Z')
  let i = 0
  const mk = (legs, result, units = 1, hourUtc = 18) => {
    i++
    const createdAt = t0 + i * 3 * 3600_000
    const at = new Date(createdAt)
    at.setUTCHours(hourUtc)
    return { id: `pk_${String(i).padStart(20, '0')}`, status: 'graded', result, units, profit: result === 'win' ? units * 0.9 : -units, createdAt: at.getTime(), gradedAt: at.getTime() + 3600_000, legs: Array.from({ length: legs }, () => ({ sport: 'nba', market: 'pts' })), tz: 'America/New_York' }
  }
  const few = [mk(1, 'win'), mk(5, 'loss'), mk(5, 'loss')]
  assert.equal(coach(few).insights.length, 0, 'nothing under the threshold')
  const picks = []
  for (let k = 0; k < THRESHOLD + 2; k++) picks.push(mk(1, k % 3 === 0 ? 'loss' : 'win'))
  for (let k = 0; k < THRESHOLD + 2; k++) picks.push(mk(5, k % 6 === 0 ? 'win' : 'loss'))
  const out = coach(picks, { now: t0 + 400 * 3600_000 })
  const legs = out.insights.find((x) => x.id === 'legs')
  assert.ok(legs, JSON.stringify(out.insights))
  assert.match(legs.text, /5\+ leg parlays are at −\d+% ROI/)
  assert.equal(legs.picks.length, THRESHOLD + 2, 'traced to every pick in the losing group')
  assert.ok(legs.picks.every((id) => picks.find((p) => p.id === id).legs.length === 5))
  for (const ins of out.insights) for (const g of ins.groups) if (g.n != null && ins.id !== 'clv') assert.ok(g.n >= THRESHOLD, `${ins.id} ${g.name} ${g.n}`)
  // late-night picks (midnight-5am New York = 04:00-09:00 UTC)
  const late = []
  for (let k = 0; k < THRESHOLD; k++) late.push(mk(1, 'loss', 1, 6))
  for (let k = 0; k < THRESHOLD; k++) late.push(mk(1, 'win', 1, 20))
  const lo = coach(late, { now: t0 + 900 * 3600_000 })
  assert.ok(lo.insights.find((x) => x.id === 'late'), JSON.stringify(lo.insights.map((x) => x.id)))
  // CLV week by week
  const withClv = picks.slice(0, 4).map((p, k) => ({ ...p, clv: k % 2 ? 0.02 : -0.01 }))
  const tr = coach(withClv, { now: Math.max(...withClv.map((p) => p.gradedAt)) + 3600_000 }).clvTrend
  assert.equal(tr.reduce((s, w) => s + w.n, 0), 4)
  assert.ok(tr.every((w) => w.weeksAgo >= 0 && w.weeksAgo < 12))
})

test('live chance: settled legs, time left, and the slip', () => {
  const row = { market: 'pts', side: 'o', line: 20.5, proj: 22, sd: 6 }
  assert.equal(liveChance(row, { cur: 21, line: 20.5, side: 'o', elapsed: 0.5 }), 1, 'already over')
  const early = liveChance(row, { cur: 5, line: 20.5, side: 'o', elapsed: 0.25 })
  const late = liveChance(row, { cur: 5, line: 20.5, side: 'o', elapsed: 0.75 })
  assert.ok(early > late, `${early} vs ${late}: less time, less chance`)
  assert.ok(late < 0.1)
  const under = liveChance({ ...row, side: 'u' }, { cur: 5, line: 20.5, side: 'u', elapsed: 0.75 })
  assert.ok(Math.abs(under - (1 - late)) < 0.002)
  assert.equal(liveChance(row, { cur: 18, line: 20.5, side: 'o', elapsed: 1, final: true, status: 'miss' }), 0)
  assert.equal(slipChance([{ chance: 0.5 }, { chance: 0.5 }, { result: 'win' }]), 0.25)
  assert.equal(slipChance([{ chance: 0.5 }, { result: 'loss' }]), 0)
  assert.ok(MARKETS.pts, 'markets load')
})

// ---- on the recorded slate ----------------------------------------------------------------------

let engine
let now
let billing
let picks
let docs
const fan = { uid: 'u_fan', email: 'fan@example.com', name: 'Fan Club' }
const capper = { uid: 'u_cap', email: 'cap@example.com', name: 'Top Capper', picture: 'https://lh3.googleusercontent.com/a/abcdefghijklmnop=s96-c' }
const other = { uid: 'u_other', email: 'other@example.com', name: 'Other One' }
const admin = { uid: 'boss', admin: true, email: 'boss@example.com' }
const GAME = '401873020'

before(async () => {
  now = clock()
  engine = await fullEngine({ now })
  docs = createStoreDocs(createStore({ driver: 'memory' }))
  billing = createBilling({ docs, chainFor: () => fakeChain(), now })
  picks = createPicks({ docs, engine, billing, now })
  await picks.saveProfile(fan, { handle: 'fanclub' })
  await picks.saveProfile(other, { handle: 'otherone' })
  await billing.grant(admin, { uid: capper.uid, plan: 'elite', days: 60 })
  await picks.saveProfile(capper, { handle: 'topcap' })
})
after(() => engine?.stop())

const mainLines = () => engine.views.game(GAME).props.filter((p) => p.kind === 'player' && !p.oneSided && p.posted === 'main')

test('board cards and prop pages carry the player status', () => {
  const p = mainLines()[0]
  const row = engine.views.findProp(p.id)
  const team = row.teamId
  const list = engine.wh.injuries.get(team) || []
  engine.wh.injuries.set(team, [...list.filter((i) => i.athleteId !== p.playerId), { athleteId: p.playerId, status: 'Questionable', name: p.name, teamId: team }])
  engine.wh.bump('core')
  const card = engine.views.game(GAME).props.find((x) => x.id === p.id)
  assert.equal(card.inj?.tag, 'questionable')
  assert.equal(engine.views.prop(p.id).status.label, 'Questionable')
  const chk = picks.check({ legs: [p.id] })
  assert.equal(chk.ok, true)
  assert.equal(chk.warnings[0].tag, 'questionable')
  engine.wh.injuries.set(team, list)
  engine.wh.bump('core')
})

test('limits, breaks and the tilt check on posting', async () => {
  const t0 = now()
  // back to before the game so posting is open
  const kick = Date.parse(engine.wh.games.get(GAME).date)
  now.set(kick - 6 * 3600_000)
  const ids = mainLines().map((p) => p.id)
  const lim = await picks.rgLimits(fan, { picksDay: 1 })
  assert.equal(lim.limits.picksDay, 1)
  await picks.post(fan, { legs: [ids[1]] })
  await rejectsWith(picks.post(fan, { legs: [ids[2]] }), 'limit_picks')
  const raised = await picks.rgLimits(fan, { picksDay: 5 })
  assert.equal(raised.limits.picksDay, 1, 'raising waits a day')
  assert.equal(raised.pending.limits.picksDay, 5)
  await rejectsWith(picks.rgLimits(fan, { picksDay: 99 }), 'bad_limit')
  // a break: no posting, no tailing, can't be shortened
  const brk = await picks.rgPause(fan, { kind: 'cool', days: 7 })
  assert.ok(brk.coolUntil > now())
  await rejectsWith(picks.post(fan, { legs: [ids[3]] }), 'cooling_off')
  const someone = (await picks.post(other, { legs: [ids[4]] })).picks[0]
  await rejectsWith(picks.tail(someone.id, `u:${fan.uid}`, fan), 'cooling_off')
  const again = await picks.rgPause(fan, { kind: 'cool', days: 1 })
  assert.equal(again.coolUntil, brk.coolUntil, 'a shorter break does not end the longer one')
  await rejectsWith(picks.rgPause(fan, { kind: 'cool', days: 3 }), 'bad_pause')
  assert.equal((await picks.pauseOf(fan.uid)).error.code, 'cooling_off')
  assert.equal(await picks.pauseOf(other.uid), null)
  // tilt: three straight losses and twice the usual stake
  await docs.patch('profiles', other.uid, { stats: { all: { wins: 3, losses: 5, pushes: 0, voids: 0, units: -2.3, risked: 8 }, days: {}, recent: ['L', 'L', 'L', 'W'] } })
  await rejectsWith(picks.post(other, { legs: [ids[5]], units: 2.5 }), 'tilt')
  const ok = await picks.post(other, { legs: [ids[5]], units: 2.5, ackTilt: true })
  assert.equal(ok.picks.length, 1)
  now.set(t0)
})

test('subscriber picks: legs hidden from others until kickoff', async () => {
  const kick = Date.parse(engine.wh.games.get(GAME).date)
  now.set(kick - 5 * 3600_000)
  const ids = mainLines().map((p) => p.id)
  await rejectsWith(picks.post(other, { legs: [ids[6]], subs: true }), 'upgrade')
  const sp = (await picks.post(capper, { legs: [ids[6]], subs: true })).picks[0]
  assert.equal(sp.subs, true)
  assert.equal(sp.legs.length, 1, 'the owner sees it')
  const anon = await picks.page('topcap')
  const hidden = anon.open.find((x) => x.id === sp.id)
  assert.equal(hidden.hidden, true)
  assert.equal(hidden.legs.length, 0)
  assert.equal(hidden.legCount, 1)
  assert.equal((await picks.pickFor(sp.id, other)).pick.legs.length, 0)
  await rejectsWith(picks.tail(sp.id, `u:${other.uid}`, other), 'subscribers')
  await picks.setSubscriber(capper, { handle: 'otherone' })
  assert.deepEqual((await picks.subscribers(capper)).subscribers.map((x) => x.handle), ['otherone'])
  const asSub = await picks.page('topcap', { viewer: other })
  assert.equal(asSub.subscriber, true)
  assert.equal(asSub.open.find((x) => x.id === sp.id).legs.length, 1)
  assert.equal((await picks.pickFor(sp.id, other)).pick.legs.length, 1)
  await picks.tail(sp.id, `u:${other.uid}`, other)
  await picks.setSubscriber(capper, { handle: 'otherone', remove: true })
  assert.equal((await picks.pickFor(sp.id, other)).pick.legs.length, 0)
  now.add(25_000)
  const feed = await picks.feed()
  const inFeed = feed.picks.find((x) => x.id === sp.id)
  if (inFeed) assert.equal(inFeed.legs.length, 0, 'the shared feed never shows them early')
  now.set(kick + 60_000)
  assert.equal((await picks.pickFor(sp.id, null)).pick.legs.length, 1, 'public once it locks')
})

test('injury alerts on open picks, and ruled-out players refused', async () => {
  const kick = Date.parse(engine.wh.games.get(GAME).date)
  now.set(kick - 4 * 3600_000)
  const p = mainLines()[8]
  const pk = (await picks.post(capper, { legs: [p.id] })).picks[0]
  assert.equal(pk.legs[0].inj, null)
  const team = engine.views.findProp(p.id).teamId
  const list = engine.wh.injuries.get(team) || []
  engine.wh.injuries.set(team, [...list, { athleteId: p.playerId, status: 'Doubtful', name: p.name, teamId: team }])
  engine.wh.bump('core')
  await picks.watchOpen()
  const a1 = await picks.alertsFor(capper)
  const mine = a1.items.filter((x) => x.pickId === pk.id)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].to, 'Doubtful')
  assert.equal(mine[0].from, 'No status')
  assert.ok(a1.unread >= 1)
  await picks.watchOpen()
  assert.equal((await picks.alertsFor(capper)).items.filter((x) => x.pickId === pk.id).length, 1, 'one alert per change')
  // ruled out: off the board, alert, and no new picks on him
  engine.wh.injuries.set(team, [...list, { athleteId: p.playerId, status: 'Out', name: p.name, teamId: team }])
  engine.wh.bump('core')
  await picks.watchOpen()
  const a2 = (await picks.alertsFor(capper)).items.filter((x) => x.pickId === pk.id)
  assert.equal(a2[0].to, 'Out')
  await rejectsWith(picks.post(other, { legs: [p.id] }), 'player_out')
  await picks.seenAlerts(capper)
  assert.equal((await picks.alertsFor(capper)).unread, 0)
  engine.wh.injuries.set(team, list)
  engine.wh.bump('core')
})

test('live slips: each leg where it stands and the slip chance', async () => {
  const wh = engine.wh
  const game = wh.games.get(GAME)
  const kick = Date.parse(game.date)
  now.set(kick - 3 * 3600_000)
  const p = mainLines()[9]
  const pk = (await picks.post(other, { legs: [p.id], units: 2, ackTilt: true })).picks[0]
  const live = { ...game.status, state: 'in', completed: false, name: 'STATUS_IN_PROGRESS', period: 3, clock: '7:30', detail: '3rd' }
  const sb = await engine.espn.scoreboard()
  const mid = structuredClone(sb)
  mid.games.find((g) => g.id === GAME).status = live
  now.set(kick + 90 * 60_000)
  wh.setScoreboard(mid, now())
  const mk = MARKETS[p.market]
  const stats = {}
  for (const k of mk.keys || []) stats[k] = 0
  const pre = wh.summaries.get(GAME)?.data || {}
  wh.setSummary(GAME, { ...pre, status: live, players: { [p.playerId]: { id: p.playerId, teamId: engine.views.findProp(p.id).teamId, stats } } }, now())
  let out
  try {
    out = await picks.liveFor(other)
  } finally {
    wh.setScoreboard(sb, now())
    wh.setSummary(GAME, pre, now())
  }
  const mine = out.picks.find((x) => x.id === pk.id)
  assert.ok(mine, JSON.stringify(out.picks.map((x) => x.id)))
  assert.equal(mine.units, 2)
  assert.ok(mine.payout > 2)
  const leg = mine.legs[0]
  assert.ok(leg.live, 'progress is there')
  assert.ok(Number.isFinite(leg.chance) && leg.chance >= 0 && leg.chance <= 1)
  assert.equal(mine.chance, leg.chance)
  assert.equal(out.refreshMs, 20_000)
})

test('closing prices are kept before kickoff and CLV lands on the pick and the record', async () => {
  const wh = engine.wh
  now.set(Date.parse(wh.games.get(GAME).date) - 6 * 3600_000)
  const p = mainLines().find((x) => x.playerId) || mainLines()[0]
  const key = `${p.playerId}:${p.market}:${p.line}`
  const saved = wh.prices
  wh.prices = new Map([[key, { over: -115, under: -105, book: 'draftkings' }]])
  wh.bump('core')
  const posted = (await picks.post(capper, { legs: [p.id], units: 1, tz: 'Europe/Oslo' })).picks[0]
  const taken = p.side === 'u' ? -105 : -115
  assert.equal(posted.legs[0].price, taken)
  const kick = Date.parse(wh.games.get(GAME).date)
  // the market moves toward the pick, then the game nears
  wh.prices = new Map([[key, p.side === 'u' ? { over: 115, under: -135, book: 'draftkings' } : { over: -135, under: 115, book: 'draftkings' }]])
  wh.bump('core')
  now.set(kick - 20 * 60_000)
  wh.lines.get(GAME).at = now()
  const w = await picks.watchOpen()
  assert.ok(w.watched >= 1)
  const doc = await docs.get('picks', posted.id)
  const close = doc.legs[0].close
  assert.equal(close.price, -135, 'the pick\'s side closed shorter than it was taken')
  assert.equal(close.line, p.line)
  assert.ok(close.at <= kick && kick - close.at <= 20 * 60_000)
  assert.equal(doc.tz, 'Europe/Oslo')
  // final: make the leg win, grade, read CLV
  const game = wh.games.get(GAME)
  const finalStatus = { ...game.status, state: 'post', completed: true, name: 'STATUS_FINAL', detail: 'Final', short: 'Final', period: 4, clock: '0:00' }
  const sb = await engine.espn.scoreboard()
  const fin = structuredClone(sb)
  fin.games.find((g) => g.id === GAME).status = finalStatus
  wh.setScoreboard(fin, now())
  const mk = MARKETS[p.market]
  const stats = {}
  for (const k of mk.keys || []) stats[k] = 0
  stats[(mk.keys || [])[0]] = p.side === 'o' ? Math.floor(p.line) + 1 : Math.max(0, Math.ceil(p.line) - 1)
  const pre = wh.summaries.get(GAME)?.data || {}
  wh.setSummary(GAME, { ...pre, status: finalStatus, players: { [p.playerId]: { id: p.playerId, teamId: engine.views.findProp(p.id).teamId, stats } } }, now())
  now.set(kick + 4 * 3600_000)
  await picks.gradeOpen()
  const graded = await docs.get('picks', posted.id)
  assert.equal(graded.result, 'win')
  const pc = noVig(close.price, close.other)[0]
  assert.equal(graded.clv, Math.round((pc * americanToDecimal(taken) - 1) * 1e4) / 1e4)
  assert.ok(graded.clv > 0)
  assert.equal(graded.legs[0].clv, graded.clv)
  const page = await picks.page('topcap')
  assert.equal(page.profile.record.all.clv, graded.clv)
  assert.equal(page.profile.record.all.clvN, 1)
  // leaderboard: below the minimum nobody shows; the minimum is the setting
  now.add(70_000)
  assert.equal((await picks.leaderboard({ range: '30d' })).rows.length, 0)
  assert.equal((await picks.leaderboard({ range: '30d' })).min, 20)
  const r = withEnv({ APEX_BOARD_MIN: '1' })
  try {
    now.add(70_000)
    const board = await picks.leaderboard({ range: '30d' })
    assert.equal(board.rows[0].profile.handle, 'topcap')
    assert.equal(board.rows[0].record.clv, graded.clv)
    assert.equal(board.rankBy, 'roi')
  } finally {
    r()
  }
  wh.setScoreboard(sb, now())
  wh.setSummary(GAME, pre, now())
  wh.prices = saved
  wh.bump('core')
})

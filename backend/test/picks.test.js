import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { socialHandle, gradeLeg, settle, recordOf, applyGraded, recordFromStats, createPicks } from '../src/picks/service.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { ApiError } from '../src/lib/router.js'
import { DAY_MS } from '../src/billing/config.js'
import { fullEngine, clock, withEnv, TREASURY, fakeChain } from './support.js'

const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, APEX_USAGE_TZ: 'America/New_York', K_SERVICE: null })
after(() => restoreEnv())

async function rejectsWith(p, code) {
  await assert.rejects(p, (e) => e instanceof ApiError && e.code === code, `expected ${code}`)
}

test('social handles: @name, bare, or profile links', () => {
  assert.equal(socialHandle('@apex_picks', 'x'), 'apex_picks')
  assert.equal(socialHandle('https://twitter.com/apex_picks?s=20', 'x'), 'apex_picks')
  assert.equal(socialHandle('x.com/ApexPicks', 'x'), 'ApexPicks')
  assert.equal(socialHandle('https://www.instagram.com/apex.picks/', 'ig'), 'apex.picks')
  assert.equal(socialHandle('', 'x'), null)
  assert.throws(() => socialHandle('this-handle-is-way-too-long', 'x'), ApiError)
  assert.throws(() => socialHandle('javascript:alert(1)', 'x'), ApiError)
  assert.throws(() => socialHandle('.dots.', 'ig'), ApiError)
  assert.throws(() => socialHandle('a..b', 'ig'), ApiError)
})

test('settling parlays: a loss sinks it, voids drop out, all-push is a push', () => {
  const pick = { units: 2, legs: [{ price: -110 }, { price: 150 }, { price: null }] }
  const win = settle(pick, [{ result: 'win' }, { result: 'win' }, { result: 'win' }])
  assert.equal(win.result, 'win')
  const d110 = 1 + 100 / 110
  assert.equal(win.decimal, Math.round(d110 * 2.5 * d110 * 1e4) / 1e4)
  assert.equal(win.profit, Math.round(2 * (win.decimal - 1) * 100) / 100)
  assert.equal(settle(pick, [{ result: 'win' }, { result: 'loss' }, { result: 'win' }]).profit, -2)
  const voided = settle(pick, [{ result: 'win' }, { result: 'void' }, { result: 'push' }])
  assert.equal(voided.result, 'win')
  assert.equal(voided.decimal, 1.9091, 'only the live leg pays')
  assert.equal(settle(pick, [{ result: 'void' }, { result: 'void' }, { result: 'void' }]).result, 'void')
  assert.equal(settle(pick, [{ result: 'push' }, { result: 'void' }, { result: 'push' }]).result, 'push')
  assert.equal(settle(pick, [{ result: 'win' }, null, { result: 'win' }]), null, 'not done until every leg is')
})

test('records: running totals match a full recount, 30-day window rolls', () => {
  const tz = 'America/New_York'
  const t0 = Date.parse('2026-09-10T18:00:00Z')
  const picks = []
  let stats = null
  const results = ['win', 'win', 'loss', 'push', 'win', 'void', 'loss', 'win', 'win', 'win', 'loss', 'win']
  results.forEach((result, i) => {
    const gradedAt = t0 + i * 4 * DAY_MS
    const p = { status: 'graded', result, units: 1 + (i % 3), profit: result === 'win' ? 0.91 * (1 + (i % 3)) : result === 'loss' ? -(1 + (i % 3)) : 0, gradedAt, createdAt: gradedAt - 3600e3 }
    picks.push(p)
    stats = applyGraded(stats, p, new Date(gradedAt).toISOString().slice(0, 10))
  })
  const t = t0 + 11 * 4 * DAY_MS + 3600e3
  const fromStats = recordFromStats(stats, t, tz)
  const full = recordOf(picks)
  for (const k of ['wins', 'losses', 'pushes', 'voids', 'units', 'roi', 'hitRate', 'streak']) assert.deepEqual(fromStats.all[k], full[k], k)
  assert.deepEqual(fromStats.all.last10, full.last10)
  const recent = recordOf(picks.filter((p) => p.gradedAt >= t - 29 * DAY_MS - 12 * 3600e3))
  assert.equal(fromStats.d30.wins + fromStats.d30.losses, recent.wins + recent.losses)
  const later = recordFromStats(stats, t + 60 * DAY_MS, tz)
  assert.equal(later.d30.graded, 0, 'nothing in the last 30 days')
  assert.equal(later.all.graded, full.graded, 'all-time stays')
})

// ---- the full flow on the recorded slate --------------------------------------------------------

let engine
let now
let billing
let picks
const free = { uid: 'u_free', email: 'free@example.com', name: 'Free Fan' }
const elite = { uid: 'u_elite', email: 'elite@example.com', name: 'Elite Capper', picture: 'https://lh3.googleusercontent.com/a/abcdefghijklmnop=s96-c' }
const admin = { uid: 'boss', admin: true, email: 'boss@example.com' }
const GAME = '401873020'

before(async () => {
  now = clock()
  engine = await fullEngine({ now })
  const docs = createStoreDocs(createStore({ driver: 'memory' }))
  billing = createBilling({ docs, chainFor: () => fakeChain(), now })
  picks = createPicks({ docs, engine, billing, now })
  billing.onChange((uid) => picks.syncPlan(uid))
})
after(() => engine?.stop())

test('profiles: handles, reserved names, socials only show for Elite', async () => {
  const me0 = await picks.me(free)
  assert.equal(me0.profile, null)
  assert.equal(me0.suggested, 'free_fan')
  await rejectsWith(picks.saveProfile(free, { handle: 'ab' }), 'bad_handle')
  await rejectsWith(picks.saveProfile(free, { handle: 'admin' }), 'reserved')
  await rejectsWith(picks.saveProfile(free, { handle: 'freefan', x: 'not a handle!' }), 'bad_social')
  const a = await picks.saveProfile(free, { handle: '@FreeFan', name: 'Free\u0000 Fan', bio: 'x'.repeat(500), x: '@freefan', avatar: 'https://evil.example.com/a.png' })
  assert.equal(a.profile.handle, 'freefan')
  assert.equal(a.profile.name, 'Free Fan')
  assert.equal(a.profile.bio.length, 160)
  assert.equal(a.profile.avatar, null, 'only Google profile pictures')
  assert.equal(a.profile.elite, false)
  const pub = await picks.page('freefan')
  assert.equal(pub.profile.x, null, 'socials are an Elite feature')
  await rejectsWith(picks.saveProfile(elite, { handle: 'freefan' }), 'taken')
  await billing.grant(admin, { uid: elite.uid, plan: 'elite', days: 30 })
  await picks.saveProfile(elite, { handle: 'cappr' })
  const e = await picks.saveProfile(elite, { handle: 'capper', x: 'https://x.com/capper', ig: 'capper.picks' })
  assert.equal(e.profile.handle, 'capper', 'one quick fix of a typo is fine')
  assert.equal(e.profile.elite, true)
  assert.equal(e.profile.avatar, elite.picture)
  await rejectsWith(picks.page('cappr'), 'not_found')
  const ep = await picks.page('capper')
  assert.equal(ep.profile.x, 'capper')
  assert.equal(ep.profile.ig, 'capper.picks')
  await rejectsWith(picks.saveProfile(elite, { handle: 'capper2' }), 'handle_cooldown')
  assert.equal((await picks.saveProfile(elite, { handle: 'capper', bio: 'Props only.' })).profile.bio, 'Props only.', 'other edits are fine')
  await rejectsWith(picks.page('nobody_here'), 'not_found')
  await rejectsWith(picks.page('../etc'), 'not_found')
})

test('posting: frozen prices, limits, duplicates, conflicts, kickoff lock', async () => {
  const g = engine.views.game(GAME)
  const ids = g.props.filter((p) => p.kind === 'player').map((p) => p.id)
  await rejectsWith(picks.post({ uid: 'u_nobody' }, { legs: [ids[0]] }), 'no_profile')
  await rejectsWith(picks.post(free, { legs: [] }), 'bad_legs')
  await rejectsWith(picks.post(free, { legs: ids.slice(0, 7) }), 'bad_legs')
  await rejectsWith(picks.post(free, { legs: [ids[0], ids[0]] }), 'dup_legs')
  await rejectsWith(picks.post(free, { legs: ['1.passYds.o.250.5'] }), 'no_prop')
  await rejectsWith(picks.post(free, { legs: ['junk'] }), 'bad_leg')
  const p = g.props[0]
  const flip = `${p.playerId}.${p.market}.${p.side === 'o' ? 'u' : 'o'}.${p.line}`
  if (!p.oneSided) await rejectsWith(picks.post(free, { legs: [p.id, flip] }), 'conflict')
  const out = await picks.post(free, { legs: [ids[0], ids[1]], units: 2.34, note: 'two-leg special' })
  assert.equal(out.picks.length, 1)
  const pk = out.picks[0]
  assert.equal(pk.units, 2.3)
  assert.equal(pk.legs.length, 2)
  assert.equal(pk.locked, false)
  assert.equal(pk.legs[0].prob, g.props[0].prob, 'the APEX read is frozen at posting time')
  assert.ok(Number.isInteger(pk.price))
  await rejectsWith(picks.post(free, { legs: [ids[1], ids[0]] }), 'dup_pick')
  const sep = await picks.post(free, { legs: ids.slice(2, 5), mode: 'separate' })
  assert.equal(sep.picks.length, 3, 'separate mode: one pick per leg')
  const page = await picks.page('freefan', { viewer: free })
  assert.equal(page.owner, true)
  assert.equal(page.open.length, 4)
  const kick = Date.parse(engine.wh.games.get(GAME).date)
  const t = now()
  now.set(kick - 30_000)
  await rejectsWith(picks.post(free, { legs: [ids[6]] }).finally(() => now.set(t)), 'started')
  now.set(kick + 1000)
  await rejectsWith(picks.remove(free, pk.id).finally(() => now.set(t)), 'locked')
  assert.deepEqual(await picks.remove(free, sep.picks[2].id), { ok: true })
  await rejectsWith(picks.remove(elite, sep.picks[1].id), 'not_found')
})

test('feed and hidden pages: Elite only, hidden pages disappear', async () => {
  const g = engine.views.game(GAME)
  const ids = g.props.filter((p) => p.kind === 'player').map((p) => p.id)
  await picks.post(elite, { legs: ids.slice(0, 6), mode: 'separate', units: 1 })
  now.add(25_000) // past the feed memo
  const feed = await picks.feed()
  assert.ok(feed.picks.length >= 6)
  assert.ok(feed.picks.every((p) => p.profile.handle === 'capper'), 'free users are not in the feed')
  await picks.setHidden(admin, { handle: 'capper', hidden: true })
  await rejectsWith(picks.page('capper'), 'not_found')
  assert.ok(await picks.page('capper', { viewer: elite }), 'the owner still sees it')
  now.add(25_000)
  assert.equal((await picks.feed()).picks.length, 0)
  await picks.setHidden(admin, { handle: 'capper', hidden: false })
  await rejectsWith(picks.setHidden(free, { handle: 'capper', hidden: true }), 'admin')
})

test('grading: box score, game log fallback, voids, records and the leaderboard', async () => {
  const wh = engine.wh
  const game = wh.games.get(GAME)
  const kick = Date.parse(game.date)
  const pre = wh.summaries.get(GAME)?.data || {}
  const open = await picks.page('capper', { viewer: elite })
  const legs = open.open.flatMap((p) => p.legs)
  assert.equal(legs.length, 6)
  // Box score: the first five legs all hit (stat = line + 1 for overs, line - 1 for unders);
  // the sixth player never shows up.
  const players = {}
  for (const l of legs.slice(0, 5)) {
    const row = engine.views.findProp(l.id)
    const base = { ...(players[l.playerId]?.stats || {}) }
    const target = l.side === 'o' ? Math.floor(l.line) + 1 : Math.max(0, Math.ceil(l.line) - 1)
    // set every stat key the market reads so mk.stat(box) lands on target
    const m = (await import('../src/nfl/markets.js')).MARKETS[l.market]
    for (const k of m.keys || []) base[k] = 0
    base[(m.keys || [])[0]] = target
    players[l.playerId] = { id: l.playerId, name: row?.name, teamId: row?.teamId, stats: base }
  }
  const finalStatus = { ...game.status, state: 'post', completed: true, name: 'STATUS_FINAL', detail: 'Final', short: 'Final', period: 4, clock: '0:00' }
  const sb = await engine.espn.scoreboard()
  const fin = structuredClone(sb)
  fin.games.find((g) => g.id === GAME).status = finalStatus
  wh.setScoreboard(fin, now())
  wh.setSummary(GAME, { ...pre, status: finalStatus, home: { ...game.home, score: 27 }, away: { ...game.away, score: 20 }, players }, now())

  now.set(kick + 4 * 3600_000)
  const r1 = await picks.gradeOpen()
  assert.ok(r1.checked >= 6)
  const after1 = await picks.page('capper', { viewer: elite })
  assert.equal(after1.history.length, 5, 'five graded off the box score')
  assert.ok(after1.history.every((p) => p.result === 'win'), JSON.stringify(after1.history.map((p) => [p.legs[0].label, p.legs[0].value, p.result])))
  assert.equal(after1.open.length, 1, 'the missing player waits for his game log')
  assert.equal(after1.profile.record.all.wins, 5)
  assert.equal(after1.profile.record.all.streak, 'W5')

  now.set(kick + 3.5 * 3600_000 + 19 * 3600_000)
  await picks.gradeOpen()
  const after2 = await picks.page('capper', { viewer: elite })
  assert.equal(after2.open.length, 0)
  const voided = after2.history.find((p) => p.result === 'void')
  assert.ok(voided, 'no box score and no game log 18 hours later: void')
  assert.equal(after2.profile.record.all.voids, 1)
  assert.equal(after2.profile.record.all.units, Math.round(after2.history.reduce((s, p) => s + p.profit, 0) * 100) / 100)

  const again = await picks.gradeOpen()
  assert.equal(again.graded, 0, 'grading twice changes nothing')
  assert.equal((await picks.page('capper')).profile.record.all.wins, 5)

  now.add(70_000)
  const board = await picks.leaderboard({ range: '30d' })
  assert.equal(board.rows.length, 1)
  assert.equal(board.rows[0].profile.handle, 'capper')
  assert.equal(board.rows[0].record.graded, 5)
  const rebuilt = await picks.rebuildRecord(elite.uid)
  assert.deepEqual(rebuilt.all, (await picks.page('capper')).profile.record.all, 'a full recount agrees with the running totals')

  // free user's picks graded too (records for everyone), but no leaderboard spot
  const fp = await picks.page('freefan', { viewer: free })
  assert.ok(fp.history.length >= 1)
  wh.setScoreboard(sb, now())
  wh.setSummary(GAME, pre, now())
})

test('losing Elite hides the socials and drops the page from the feed', async () => {
  await billing.revoke(admin, { uid: elite.uid })
  const me = await picks.me(elite)
  assert.equal(me.profile.elite, false)
  const pub = await picks.page('capper')
  assert.equal(pub.profile.x, null)
  assert.equal(pub.profile.elite, false)
})

// Weekly contests on the recorded Week 7 slate: drafts from the board, publishing (an https rules
// link when there's a prize), free entry with a 21+ check, picks that lock at each game's start,
// grading once per prop, standings, the winner and its tiebreak, and responsible-play blocks.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createContests, rank, scoreOf, rulesUrlOf, rgBlock, MAX_PROPS } from '../src/contests/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createBilling } from '../src/billing/service.js'
import { createStore } from '../src/lib/store.js'
import { ApiError } from '../src/lib/router.js'
import { MARKETS } from '../src/nfl/markets.js'
import { ADMIN } from '../src/admin/session.js'
import { createApexApp } from '../app.js'
import { fixtureHttp } from './helpers.js'
import { fullEngine, loadAll, clock, withEnv, testAuth, USERS, bearer, serve, CAPTURED_AT } from './support.js'

const KEY = 'test-admin-key-for-contests-0123'
const restoreEnv = withEnv({ APEX_USAGE_TZ: 'America/New_York', APEX_EPHEMERAL: null, APEX_PAYWALL: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, OPENAI_API_KEY: null, APEX_LOG_LEVEL: 'error', ADMIN_SPORTS_KEY: KEY, APEX_ADMIN_EMAILS: 'boss@example.com', APEX_ADMIN_UIDS: null })
after(() => restoreEnv())

async function rejectsWith(p, code) {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof ApiError, `expected an ApiError, got ${e}`)
    assert.equal(e.code, code, e.message)
    return true
  })
}

// the slate's games: a London morning game, the 1 PM window, 4:25, and Sunday night
const G = { london: '401873011', bal: '401873012', ten: '401873013', det: '401873020', sea: '401873022' }
const amy = { uid: 'u_amy', email: 'amy@example.com', name: 'Amy' }
const ben = { uid: 'u_ben', email: 'ben@example.com', name: 'Ben' }
const cat = { uid: 'u_cat', email: 'cat@example.com', name: 'Cat' }
const dan = { uid: 'u_dan', email: 'dan@example.com', name: 'Dan' }
const eve = { uid: 'u_eve', email: 'eve@example.com', name: 'Eve' }
const MIN = 60_000
const HOUR = 3_600_000

test('scoring: a point per right pick, pushes and voids score nothing, ties go to the earliest change', () => {
  const slate = [{ result: 'o' }, { result: 'u' }, { result: 'push' }, { result: 'void' }, { result: null }]
  assert.deepEqual(scoreOf(slate, 'oooo-'), { points: 1, correct: 1, wrong: 1, pushes: 2, pending: 0, picked: 4 })
  assert.deepEqual(scoreOf(slate, 'ou--o'), { points: 2, correct: 2, wrong: 0, pushes: 0, pending: 1, picked: 3 })
  const rows = [
    { u: 'late', n: 'Late', p: 'ou---', t: 300, c: 100 },
    { u: 'early', n: 'Early', p: 'ou---', t: 200, c: 150 },
    { u: 'low', n: 'Low', p: 'uo---', t: 50, c: 50 },
  ]
  const r = rank(slate, rows)
  assert.deepEqual(
    r.map((x) => [x.rank, x.uid, x.points]),
    [
      [1, 'early', 2],
      [2, 'late', 2],
      [3, 'low', 0],
    ],
    'same points: the entry last changed earliest ranks first',
  )
})

test('rules links are https only, and the break settings block entry while they last', () => {
  assert.equal(rulesUrlOf(''), '')
  assert.equal(rulesUrlOf(' https://sponsor.example.com/rules '), 'https://sponsor.example.com/rules')
  for (const bad of ['http://sponsor.example.com/rules', 'javascript:alert(1)', 'ftp://x.example.com', 'https://localhost/rules', 'https://user:pw@example.com/rules', 'rules.pdf']) {
    assert.throws(() => rulesUrlOf(bad), (e) => e.code === 'bad_rules_url', bad)
  }
  const t = Date.parse('2026-11-05T15:00:00Z')
  assert.equal(rgBlock(null, t), null, 'no settings, no block')
  assert.equal(rgBlock({ coolUntil: t - 1, excludedUntil: t - 1 }, t), null, 'both over')
  assert.equal(rgBlock({ coolUntil: null, excludedUntil: null }, t), null)
  const cool = rgBlock({ coolUntil: Date.parse('2026-11-08T17:00:00Z') }, t)
  assert.equal(cool.code, 'cooling_off')
  assert.equal(cool.message, 'You’re on a break from picks and contests until 2026-11-08.')
  const both = rgBlock({ coolUntil: t + HOUR, excludedUntil: Date.parse('2027-05-01T16:00:00Z') }, t)
  assert.equal(both.code, 'self_excluded', 'an exclusion outranks a break')
  assert.equal(both.until, Date.parse('2027-05-01T16:00:00Z'))
  assert.equal(both.message, 'You’ve excluded yourself from picks and contests until 2027-05-01.')
})

// ---- the full flow on the recorded slate --------------------------------------------------------

let engine
let now
let docs
let contests
let picks6 // six board props on five games
let main // the published contest

before(async () => {
  now = clock()
  engine = await fullEngine({ now })
  docs = createStoreDocs(createStore({ driver: 'memory' }))
  contests = createContests({ docs, engines: { nfl: engine }, now })
  const used = new Set()
  const two = (g) => engine.views.game(g).props.filter((p) => p.kind === 'player' && !p.oneSided && p.posted === 'main' && !used.has(p.playerId))
  const take = (list) => {
    const p = list[0]
    assert.ok(p, 'the fixture has props for this game')
    used.add(p.playerId)
    return p
  }
  picks6 = [take(two(G.london)), take(two(G.bal)), take(two(G.bal)), take(two(G.ten)), take(engine.views.game(G.det).props.filter((p) => p.oneSided && p.posted && !used.has(p.playerId))), take(two(G.sea))]
})
after(() => engine?.stop())

const refs = () => picks6.map((p, i) => (i % 2 ? `nfl:${p.id}` : p.id)) // both ref spellings work
const flip = (id) => id.replace(/\.([ou])\./, (_, s) => `.${s === 'o' ? 'u' : 'o'}.`)

test('drafts: built from board props by the admin only, checked prop by prop', async () => {
  await rejectsWith(contests.create(amy, { title: 'Week 7' }), 'admin')
  await rejectsWith(contests.create(ADMIN, { slate: ['junk'] }), 'bad_prop')
  await rejectsWith(contests.create(ADMIN, { slate: Array.from({ length: MAX_PROPS + 1 }, () => picks6[0].id) }), 'too_many')
  const p = picks6[1]
  await rejectsWith(contests.create(ADMIN, { slate: [p.id, flip(p.id)] }), 'dup_prop')
  await rejectsWith(contests.create(ADMIN, { slate: [`${p.playerId}.${p.market}.o.800`] }), 'not_posted')
  await rejectsWith(contests.create(ADMIN, { slate: [picks6[0].id], leagues: ['nba'] }), 'bad_league')
  await rejectsWith(contests.create(ADMIN, { rulesUrl: 'http://sponsor.example.com/rules' }), 'bad_rules_url')
  await assert.rejects(contests.create(ADMIN, { slate: ['junk', picks6[0].id, `${p.playerId}.${p.market}.o.800`] }), (e) => e.extra.props.length === 2, 'every problem at once')

  const { contest } = await contests.create(ADMIN, { title: '  Week 7\u0000 showdown ', slate: refs(), prize: 'A $100 gift card', sponsor: 'Acme Sports', places: 1 })
  main = contest.id
  assert.match(main, /^ct_[0-9a-f]{20}$/)
  assert.equal(contest.status, 'draft')
  assert.equal(contest.title, 'Week 7 showdown')
  assert.deepEqual(contest.leagues, ['nfl'])
  assert.equal(contest.slate.length, 6)
  assert.deepEqual(
    contest.slate.map((s) => s.id),
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
  )
  assert.ok(contest.refs.every((r) => /^nfl:\d+\.\w+\.o\.[\d.]+$/.test(r)), 'kept as the over side: entrants choose')
  await rejectsWith(contests.view(main), 'not_found')
  const fixed = await contests.update(ADMIN, main, { sponsor: 'Acme Sports Co.' })
  assert.equal(fixed.contest.sponsor, 'Acme Sports Co.')
  assert.equal(fixed.contest.slate.length, 6, 'fields left out stay as they were')
})

test('publishing: a prize needs an https rules link; 5 to 10 props; the slate is frozen', async () => {
  await rejectsWith(contests.publish(ADMIN, main), 'rules_url')
  await contests.update(ADMIN, main, { rulesUrl: 'https://sponsor.example.com/week-7-rules' })
  const small = await contests.create(ADMIN, { title: 'Too small', slate: refs().slice(0, 4) })
  await rejectsWith(contests.publish(ADMIN, small.contest.id), 'slate_size')
  await rejectsWith(contests.publish(amy, main), 'admin')

  const { contest } = await contests.publish(ADMIN, main)
  assert.equal(contest.status, 'open')
  assert.equal(contest.open, true)
  const london = contest.slate[0]
  assert.equal(london.game, engine.wh.games.get(G.london).shortName)
  assert.equal(london.kickoff, Date.parse(engine.wh.games.get(G.london).date))
  assert.equal(london.lockAt, london.kickoff)
  assert.equal(london.locked, false)
  assert.deepEqual(
    london.sides.map((s) => s.side),
    ['o', 'u'],
  )
  assert.match(london.sides[0].label, /^Over /)
  assert.deepEqual(contest.slate[4].sides, [{ side: 'o', label: 'Yes' }], 'one-sided props only have yes')
  assert.equal(contest.lockAt, london.kickoff, 'the first lock is the first game')
  assert.equal(contest.lastLockAt, Date.parse(engine.wh.games.get(G.sea).date))
  await rejectsWith(contests.publish(ADMIN, main), 'not_draft')
  await rejectsWith(contests.update(ADMIN, main, { title: 'Changed' }), 'not_draft')

  // the board moves on; the slate keeps what it was at publish
  const entry = engine.wh.lines.get(G.bal).props.find((l) => l.athleteId === picks6[1].playerId && l.market === picks6[1].market)
  const saved = entry.line
  entry.line = saved + 10
  engine.wh.bump('core')
  const v = await contests.view(main)
  assert.equal(v.contest.slate[1].line, picks6[1].line)
  entry.line = saved
  engine.wh.bump('core')

  const list = await contests.list()
  assert.deepEqual(
    list.contests.map((c) => c.id),
    [main],
    'drafts stay off the public list',
  )
  assert.equal(list.contests[0].props, 6)
  assert.equal(list.contests[0].sponsor, 'Acme Sports Co.')
})

test('entering: free, one entry per person, a 21+ check, real sides only', async () => {
  await rejectsWith(contests.enter(null, main, { picks: { p1: 'o' }, confirm: true }), 'signin')
  await rejectsWith(contests.enter(ADMIN, main, { picks: { p1: 'o' }, confirm: true }), 'signin')
  await rejectsWith(contests.enter(amy, 'ct_nope', { picks: { p1: 'o' }, confirm: true }), 'not_found')
  await rejectsWith(contests.enter(amy, main, { picks: { p1: 'o' } }), 'confirm')
  await rejectsWith(contests.enter(amy, main, { picks: { p1: 'o' }, confirm: 'yes' }), 'confirm')
  await rejectsWith(contests.enter(amy, main, { picks: { p99: 'o' }, confirm: true }), 'bad_prop')
  await rejectsWith(contests.enter(amy, main, { picks: { p1: 'sideways' }, confirm: true }), 'bad_side')
  await rejectsWith(contests.enter(amy, main, { picks: { p5: 'u' }, confirm: true }), 'bad_side')
  await rejectsWith(contests.enter(amy, main, { picks: ['o'], confirm: true }), 'bad_picks')
  await rejectsWith(contests.enter(amy, main, { picks: {}, confirm: true }), 'no_picks')

  const t0 = now()
  const a = await contests.enter(amy, main, { picks: { p1: 'o', p2: 'o', p3: 'o', p4: 'u', p5: 'yes', p6: 'u' }, confirm: true })
  assert.deepEqual(a.you.entry.picks, { p1: 'o', p2: 'o', p3: 'o', p4: 'u', p5: 'o', p6: 'u' })
  assert.equal(a.you.entry.picked, 6)
  assert.equal(a.you.entry.pending, 6)
  assert.equal(a.you.entry.updatedAt, t0)
  now.add(MIN)
  await contests.enter(ben, main, { picks: { p1: 'o', p2: 'u', p3: 'o', p4: 'u', p5: 'o', p6: 'u' }, confirm: true })
  now.add(MIN)
  // the same picks again is not a change: Amy keeps her earlier time
  const again = await contests.enter(amy, main, { picks: { p1: 'o', p2: 'o' } })
  assert.equal(again.you.entry.updatedAt, t0, 'no change, no new time')
  now.add(MIN)
  // with a public picks page the standings show the handle
  await docs.set('profiles', cat.uid, { uid: cat.uid, handle: 'cat_picks', hidden: false })
  await contests.enter(cat, main, { picks: { p1: 'u', p2: 'u', p4: 'o', p6: 'o' }, confirm: true })
  const catRow = (await contests.view(main, cat)).standings.rows.find((r) => r.you)
  assert.equal(catRow.name, '@cat_picks')
  assert.equal(catRow.handle, 'cat_picks')

  const v = await contests.view(main, amy)
  assert.equal(v.contest.entries, 3, 'one entry each: saving again changes the same entry')
  assert.equal(v.standings.total, 3)
  assert.equal(v.you.entered, true)
  assert.deepEqual(v.you.entry.picks, a.you.entry.picks)
  assert.equal(v.you.block, null)
  const me = v.standings.rows.find((r) => r.you)
  assert.equal(me.rank, v.you.entry.rank, 'your own row is marked')
  assert.ok(v.standings.rows.every((r) => !('uid' in r)), 'no account ids in public standings')
  assert.match(me.name, /^Entrant [0-9A-F]{6}$/, 'no picks page: an anonymous tag, never a real name')
  const anon = await contests.view(main)
  assert.equal(anon.you, null)
  assert.ok(anon.standings.rows.every((r) => !r.you))
  const stored = await docs.get('contestEntries', `${main}_${amy.uid}`)
  assert.equal(stored.email, 'amy@example.com', 'kept privately to reach a winner')
  assert.equal(stored.confirmedAt, t0)
})

test('cool-off and self-exclusion: no entering and no changes while they last', async () => {
  const t = now()
  await docs.set('rg', eve.uid, { coolUntil: t + 3 * 24 * HOUR })
  await assert.rejects(contests.enter(eve, main, { picks: { p1: 'o' }, confirm: true }), (e) => e.code === 'cooling_off' && e.status === 403 && /^You’re on a break from picks and contests until \d{4}-\d{2}-\d{2}\.$/.test(e.message))
  const seen = await contests.view(main, eve)
  assert.equal(seen.you.block.code, 'cooling_off', 'the page knows before anyone fills in picks')
  assert.equal(seen.you.block.until, t + 3 * 24 * HOUR)
  await docs.set('rg', eve.uid, { coolUntil: t - 1, excludedUntil: t + 180 * 24 * HOUR })
  await assert.rejects(contests.enter(eve, main, { picks: { p1: 'o' }, confirm: true }), (e) => e.code === 'self_excluded' && e.status === 403 && e.extra.until === t + 180 * 24 * HOUR && /^You’ve excluded yourself from picks and contests until \d{4}-\d{2}-\d{2}\.$/.test(e.message))
  // someone already in can't change picks during a break either
  await docs.set('rg', amy.uid, { coolUntil: t + HOUR })
  await rejectsWith(contests.enter(amy, main, { picks: { p6: 'o' } }), 'cooling_off')
  await docs.set('rg', amy.uid, { coolUntil: t - 1, excludedUntil: null })
  const v = await contests.view(main, amy)
  assert.equal(v.you.block, null, 'a break that has ended blocks nothing')
  assert.equal(v.you.entry.picks.p6, 'u', 'the refused change never landed')
  assert.equal((await contests.view(main)).standings.total, 3, 'refused entries are not on the board')
})

test('closing and cancelling', async () => {
  const later = refs().slice(1)
  const { contest } = await contests.create(ADMIN, { title: 'Closes early', slate: later })
  await contests.publish(ADMIN, contest.id)
  await contests.enter(dan, contest.id, { picks: { p1: 'u' }, confirm: true })
  const closed = await contests.close(ADMIN, contest.id)
  assert.equal(closed.contest.status, 'closed')
  assert.equal(closed.contest.open, false)
  await rejectsWith(contests.enter(dan, contest.id, { picks: { p1: 'o' } }), 'closed')
  await rejectsWith(contests.close(ADMIN, contest.id), 'not_open')
  const gone = await contests.cancel(ADMIN, contest.id)
  assert.equal(gone.contest.status, 'cancelled')
  assert.equal((await contests.view(contest.id)).contest.status, 'cancelled', 'entrants can see it was called off')
  await rejectsWith(contests.enter(dan, contest.id, { picks: { p1: 'o' } }), 'cancelled')
  await rejectsWith(contests.cancel(ADMIN, contest.id), 'cancelled')
  // a draft cancelled before it went live never shows up in public
  const draft = await contests.create(ADMIN, { title: 'Never mind' })
  await contests.cancel(ADMIN, draft.contest.id)
  await rejectsWith(contests.view(draft.contest.id), 'not_found')
  const list = await contests.list()
  assert.deepEqual(
    list.contests.map((c) => c.id),
    [main],
  )
  const all = await contests.adminList(ADMIN)
  assert.equal(all.contests.length, 4, 'the admin sees every contest, drafts and cancelled ones too')
})

test('locks: a pick can change until its game starts, never after', async () => {
  const start = Date.parse(engine.wh.games.get(G.london).date)
  now.set(start + MIN)
  await rejectsWith(contests.enter(amy, main, { picks: { p1: 'u' } }), 'locked')
  await rejectsWith(contests.enter(amy, main, { picks: { p1: null } }), 'locked')
  await assert.rejects(contests.enter(amy, main, { picks: { p1: 'u', p2: 'u' } }), (e) => e.code === 'locked' && e.extra.props.join() === 'p1', 'nothing saves when one pick is locked')
  // sending a locked pick unchanged is fine; the open one changes
  const a = await contests.enter(amy, main, { picks: { p1: 'o', p2: 'u' } })
  assert.equal(a.you.entry.picks.p2, 'u')
  assert.equal(a.you.entry.updatedAt, start + MIN)
  // a new entry after a game starts: only the games still to come
  await rejectsWith(contests.enter(dan, main, { picks: { p1: 'o', p2: 'u' }, confirm: true }), 'locked')
  now.set(start + 2 * MIN)
  const d = await contests.enter(dan, main, { picks: { p2: 'u', p3: 'u', p4: 'o', p5: 'yes', p6: 'u' }, confirm: true })
  assert.equal(d.you.entry.picked, 5)
  const v = await contests.view(main, dan)
  assert.equal(v.contest.slate[0].locked, true)
  assert.equal(v.contest.slate[1].locked, false)
  assert.equal(v.contest.open, true)

  // the scoreboard says a game started early: locked before its listed start time
  now.set(start + 3 * MIN)
  const sb = await engine.espn.scoreboard()
  const early = structuredClone(sb)
  early.games.find((g) => g.id === G.bal).status = { ...early.games.find((g) => g.id === G.bal).status, state: 'in', period: 1, clock: '14:50' }
  engine.wh.setScoreboard(early, now())
  await rejectsWith(contests.enter(cat, main, { picks: { p2: 'o' } }), 'locked')
  assert.equal((await contests.enter(cat, main, { picks: { p6: 'u' } })).you.entry.picks.p6, 'u', 'later games are still open')
  engine.wh.setScoreboard(sb, now())

  // every game under way: no new entries
  now.set(Date.parse(engine.wh.games.get(G.sea).date) + MIN)
  await rejectsWith(contests.enter(eve, main, { picks: { p6: 'u' }, confirm: true }), 'self_excluded')
  await docs.del('rg', eve.uid)
  await rejectsWith(contests.enter(eve, main, { picks: { p6: 'u' }, confirm: true }), 'all_locked')
  assert.equal((await contests.view(main)).contest.open, false)
})

/** Final box scores: each listed prop lands on the side given ('o' over/yes, 'u' under); players left out never played. */
function finish(gameId, outcomes, slate) {
  const wh = engine.wh
  const game = wh.games.get(gameId)
  const pre = wh.summaries.get(gameId)?.data || {}
  const players = {}
  for (const [id, side] of Object.entries(outcomes)) {
    const p = slate.find((x) => x.id === id)
    const m = MARKETS[p.market]
    const stats = { ...(players[p.playerId]?.stats || {}) }
    for (const k of m.keys || []) stats[k] = 0
    stats[m.keys[0]] = side === 'o' ? Math.floor(p.line) + 1 : Math.max(0, Math.ceil(p.line) - 1)
    players[p.playerId] = { id: p.playerId, name: p.name, stats }
  }
  const status = { ...game.status, state: 'post', completed: true, name: 'STATUS_FINAL', detail: 'Final', short: 'Final', period: 4, clock: '0:00' }
  wh.setSummary(gameId, { ...pre, status, home: { ...game.home, score: 27 }, away: { ...game.away, score: 20 }, players }, now())
  return () => wh.setSummary(gameId, pre, now())
}

test('grading: each prop once, standings as games finish, the winner by tiebreak', async () => {
  const slate = (await contests.view(main)).contest.slate
  const kick = (g) => Date.parse(engine.wh.games.get(g).date)
  const undo = []
  // results: p1 over, p2 under, p3 void (his player never plays), p4 over, p5 yes, p6 under
  undo.push(finish(G.london, { p1: 'o' }, slate))
  now.set(kick(G.london) + 4 * HOUR)
  const r1 = await contests.gradeActive()
  assert.equal(r1.graded, 1, 'only the London game is final')
  const mid = await contests.view(main, ben)
  assert.equal(mid.contest.slate[0].result, 'o')
  assert.ok(Number.isFinite(mid.contest.slate[0].value))
  assert.equal(mid.contest.graded, 1)
  assert.equal(mid.contest.status, 'open')
  const byName = (v) => Object.fromEntries(v.standings.rows.map((r) => [r.rank, r]))
  const m = byName(mid)
  assert.equal(m[1].points, 1)
  assert.equal(m[1].pending, 5)
  assert.equal(m[2].points, 1)
  assert.equal(mid.you.entry.rank, 1, 'Ben and Amy both have p1; Ben last changed his entry first')
  assert.equal(mid.you.entry.points, 1)

  undo.push(finish(G.bal, { p2: 'u' }, slate))
  undo.push(finish(G.ten, { p4: 'o' }, slate))
  undo.push(finish(G.det, { p5: 'o' }, slate))
  undo.push(finish(G.sea, { p6: 'u' }, slate))
  now.set(kick(G.sea) + 4 * HOUR)
  const r2 = await contests.gradeActive()
  assert.equal(r2.graded, 4, 'p3 waits: a player missing from the box gets 18 hours for his game log')
  assert.equal((await contests.view(main)).contest.status, 'open')

  now.set(kick(G.bal) + 3.5 * HOUR + 19 * HOUR)
  const r3 = await contests.gradeActive()
  assert.equal(r3.graded, 1)
  assert.equal(r3.finals, 1)
  const fin = await contests.view(main, amy)
  assert.equal(fin.contest.status, 'final')
  assert.equal(fin.contest.slate[2].result, 'void')
  assert.deepEqual(
    fin.contest.slate.map((p) => p.result),
    ['o', 'u', 'void', 'o', 'o', 'u'],
  )
  assert.deepEqual(
    fin.standings.rows.map((r) => [r.rank, r.points]),
    [
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 3],
    ],
  )
  // Ben, Amy and Dan tie on 4: Ben never changed (02:30), Amy changed p2 at the London kickoff, Dan entered after
  const ranks = Object.fromEntries(
    await Promise.all(
      [ben, amy, dan, cat].map(async (u) => [u.uid, (await contests.view(main, u)).you.entry.rank]),
    ),
  )
  assert.deepEqual(ranks, { u_ben: 1, u_amy: 2, u_dan: 3, u_cat: 4 })
  assert.equal(fin.you.entry.pushes, 1, 'a void scores nothing')
  assert.equal(fin.winners.length, 1)
  assert.equal(fin.winners[0].points, 4)
  assert.equal(fin.winners[0].name, fin.standings.rows[0].name)
  assert.ok(!('uid' in fin.winners[0]))

  const adminSide = await contests.adminView(ADMIN, main)
  assert.equal(adminSide.winners[0].uid, ben.uid)
  assert.equal(adminSide.winners[0].email, 'ben@example.com', 'the admin can reach the winner')
  assert.equal(adminSide.contest.final.entries, 4)

  const again = await contests.gradeActive()
  assert.equal(again.graded, 0, 'grading twice changes nothing')
  await rejectsWith(contests.enter(amy, main, { picks: { p6: 'o' } }), 'closed')
  await rejectsWith(contests.cancel(ADMIN, main), 'final')
  const list = await contests.list()
  const done = list.contests.find((c) => c.id === main)
  assert.equal(done.status, 'final')
  assert.equal(done.winners[0].points, 4)
  for (const u of undo) u()
})

// ---- the API ------------------------------------------------------------------------------------

test('the API: anyone can look, entering needs a sign-in, running contests needs the admin password', async () => {
  const t = clock(CAPTURED_AT)
  const store = createStore({ driver: 'memory' })
  const billing = createBilling({ docs: createStoreDocs(store), now: t })
  const made = createApexApp({ engineMode: 'lazy', http: fixtureHttp().http, store, auth: testAuth(USERS), billing, oddsKey: () => null, now: t })
  await loadAll(made.engine)
  const api = await serve(made.app)
  try {
    const empty = await api.get('/api/contests')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.contests, [])
    assert.match(empty.headers.get('cache-control'), /public/)

    const slate = refs()
    assert.equal((await api.post('/api/admin/contests', { slate })).status, 401)
    const google = await api.post('/api/admin/contests', { slate }, { headers: bearer('u_admin') })
    assert.equal(google.status, 401, 'a Google admin account alone is not enough')
    assert.equal(google.body.code, 'admin_password')
    const login = await api.post('/api/admin/login', { password: KEY })
    const adm = { cookie: String(login.headers.get('set-cookie')).split(';')[0] }

    const made1 = await api.post('/api/admin/contests', { title: 'Week 7', slate, prize: 'Team jersey', sponsor: 'Acme' }, { headers: adm })
    assert.equal(made1.status, 200)
    const id = made1.body.contest.id
    const bad = await api.post(`/api/admin/contests/${id}/publish`, {}, { headers: adm })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'rules_url')
    assert.equal((await api.put(`/api/admin/contests/${id}`, { rulesUrl: 'https://acme.example.com/rules' }, { headers: adm })).status, 200)
    assert.equal((await api.post(`/api/admin/contests/${id}/publish`, {}, { headers: adm })).status, 200)
    assert.equal((await api.get('/api/admin/contests', { headers: adm })).body.contests.length, 1)
    assert.equal((await api.get('/api/admin/contests')).status, 401)

    const list = await api.get('/api/contests')
    assert.equal(list.body.contests[0].id, id)
    const anon = await api.get(`/api/contests/${id}`)
    assert.equal(anon.status, 200)
    assert.equal(anon.body.you, null)
    assert.equal(anon.body.contest.slate.length, 6)
    assert.match(anon.headers.get('cache-control'), /public/)

    const out = await api.post(`/api/contests/${id}/entry`, { picks: { p1: 'o' }, confirm: true })
    assert.equal(out.status, 401)
    assert.equal(out.body.code, 'signin')
    const ok = await api.post(`/api/contests/${id}/entry`, { picks: { p1: 'o', p2: 'u' }, confirm: true }, { headers: bearer('u_free') })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.you.entry.picks, { p1: 'o', p2: 'u' })
    const mine = await api.get(`/api/contests/${id}`, { headers: bearer('u_free') })
    assert.equal(mine.headers.get('cache-control'), 'private, no-store')
    assert.equal(mine.body.you.entered, true)
    assert.equal(mine.body.standings.total, 1)
    const noConfirm = await api.post(`/api/contests/${id}/entry`, { picks: { p1: 'o' } }, { headers: bearer('u_pro') })
    assert.equal(noConfirm.status, 400)
    assert.equal(noConfirm.body.code, 'confirm')
    await billing.docs.set('rg', 'u_elite', { excludedUntil: t() + 30 * 24 * HOUR })
    const excluded = await api.post(`/api/contests/${id}/entry`, { picks: { p1: 'o' }, confirm: true }, { headers: bearer('u_elite') })
    assert.equal(excluded.status, 403)
    assert.equal(excluded.body.code, 'self_excluded')
    assert.equal(excluded.body.until, t() + 30 * 24 * HOUR)
    assert.equal((await api.get(`/api/contests/${id}`, { headers: bearer('u_elite') })).body.you.block.code, 'self_excluded')

    // writes are rate limited per person
    let limited = null
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await api.post(`/api/contests/${id}/entry`, { picks: { p3: i % 2 ? 'o' : 'u' } }, { headers: bearer('u_free') })
      if (r.status === 429) limited = r
    }
    assert.ok(limited, 'too many saves in a row slow down')
    assert.equal(limited.body.code, 'slow_down')
    assert.ok(Number(limited.headers.get('retry-after')) > 0)

    assert.equal((await api.post(`/api/admin/contests/${id}/close`, {}, { headers: adm })).body.contest.status, 'closed')
    assert.equal((await api.get('/api/contests/ct_00000000000000000000')).status, 404)
    assert.equal((await api.post('/api/admin/contests/grade', {}, { headers: adm })).status, 200)
  } finally {
    await api.close()
    for (const e of Object.values(made.engines)) e.stop()
  }
})

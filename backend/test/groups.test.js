// Private groups with their own boards, tailing a pick into your own record, and the fair-play
// checks on the leaderboard (shared wallets, mirrored sides from a shared network, deleting picks
// before kickoff as a habit).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { createIntegrity, fingerprint, legKey, deleteShare, DELETE_RULE } from '../src/picks/integrity.js'
import { readCode, CODE_RE, newCode } from '../src/picks/groups.js'
import { applyGraded } from '../src/picks/service.js'
import { fixtureHttp } from './helpers.js'
import { clock, loadAll, testAuth, USERS, bearer, withEnv, serve } from './support.js'

const DAY = 86_400_000

test('fingerprints are keyed and one-way; legs know their other side', () => {
  const a = fingerprint('203.0.113.7', { ADMIN_SPORTS_KEY: 'k'.repeat(30) })
  assert.match(a, /^[0-9a-f]{24}$/)
  assert.equal(a, fingerprint('203.0.113.7', { ADMIN_SPORTS_KEY: 'k'.repeat(30) }), 'stable')
  assert.notEqual(a, fingerprint('203.0.113.7', { ADMIN_SPORTS_KEY: 'j'.repeat(30) }), 'keyed by the server secret')
  assert.notEqual(a, fingerprint('203.0.113.8', { ADMIN_SPORTS_KEY: 'k'.repeat(30) }))
  assert.ok(!a.includes('203'), 'the address itself is nowhere in it')
  assert.equal(fingerprint(''), null)
  assert.deepEqual(legKey({ sport: 'nba', playerId: '9', market: 'pts', line: 24.5, side: 'u' }), { key: 'nba:9:pts:24.5', side: 'u' })
  assert.equal(legKey({ playerId: '9', market: 'anyTd', line: 0.5, side: 'o', oneSided: true }), null, 'a yes-only market has no other side')
  assert.equal(legKey({ teamId: '4', market: 'teamPts', line: 24.5, side: 'o' }).key, 'nfl:t4:teamPts:24.5')
})

test('deleting before kickoff: a habit over 30 days is selective posting', () => {
  const t = Date.parse('2026-11-20T12:00:00Z')
  const posts = Array.from({ length: 16 }, (_, i) => t - i * DAY)
  assert.equal(deleteShare(posts, [t - DAY], t).over, false, 'one delete is a change of mind')
  const many = Array.from({ length: DELETE_RULE.min }, (_, i) => t - i * DAY)
  const s = deleteShare(posts, many, t)
  assert.deepEqual([s.posted, s.deleted, s.over], [16, 8, true], '8 of 16 deleted')
  assert.equal(deleteShare([...posts, ...posts.map((x) => x - 1000)], many, t).over, false, '8 of 32 is under the line')
  assert.equal(deleteShare(posts, many.map((x) => x - 40 * DAY), t).deleted, 0, 'only the last 30 days count')
})

test('fair-play flags: shared networks noted, mirrored sides and shared wallets held, cleared by the admin', async () => {
  let t = Date.parse('2026-11-20T15:00:00Z')
  const docs = createStoreDocs(createStore({ driver: 'memory' }))
  const integ = createIntegrity({ docs, now: () => t, env: { ADMIN_SPORTS_KEY: 'k'.repeat(30) } })
  const leg = (side) => ({ sport: 'nfl', playerId: '3046779', market: 'passYds', line: 250.5, side, name: 'J. Goff', label: `${side === 'u' ? 'Under' : 'Over'} 250.5 Passing Yards` })
  // two accounts on one network: noted, not held
  await integ.notePost('u_one', { ip: '198.51.100.4', legs: [leg('o')] })
  await integ.notePost('u_two', { ip: '198.51.100.9', legs: [leg('u')] })
  let flags = await integ.list()
  assert.equal(flags.length, 0, 'other side from another network: two people who disagree')
  await integ.notePost('u_three', { ip: '198.51.100.4', legs: [{ ...leg('o'), line: 260.5 }] })
  flags = await integ.list()
  assert.deepEqual(flags.map((f) => f.kind), ['network'])
  assert.equal(flags[0].strong, false)
  assert.equal((await integ.holds()).size, 0, 'a shared network alone holds nobody')
  // the same network, the other side of the same prop, the same day: held
  t += 60_000
  await integ.notePost('u_three', { ip: '198.51.100.4', legs: [{ ...leg('u') }] })
  flags = await integ.list()
  const mirror = flags.find((f) => f.kind === 'mirror')
  assert.ok(mirror, 'mirrored')
  assert.deepEqual(mirror.uids, ['u_one', 'u_three'])
  assert.match(mirror.detail, /opposite sides of J\. Goff Under 250\.5 Passing Yards/)
  t += 2 * 60_000
  let held = await integ.holds()
  assert.equal(held.get('u_one'), 'mirror')
  assert.equal(held.get('u_three'), 'mirror')
  assert.equal(held.has('u_two'), false)
  // the admin looks and clears it
  assert.equal((await integ.clear({ uid: 'x' }, { id: mirror.id })).ok, false, 'admins only')
  assert.equal((await integ.clear({ admin: true, email: 'boss@example.com' }, { id: mirror.id })).ok, true)
  t += 2 * 60_000
  held = await integ.holds()
  assert.equal(held.size, 0)
  // two accounts that paid from one wallet: held until cleared
  await docs.set('billingPayments', 'inv1', { uid: 'u_w1', from: '0xAbCdEf0000000000000000000000000000000001', createdAt: t })
  await docs.set('billingPayments', 'inv2', { uid: 'u_w2', from: '0xabcdef0000000000000000000000000000000001', createdAt: t + 1 })
  await docs.set('billingPayments', 'inv3', { uid: 'u_w3', from: '0x9999990000000000000000000000000000000001', createdAt: t + 2 })
  t += 11 * 60_000
  held = await integ.holds()
  assert.equal(held.get('u_w1'), 'wallet')
  assert.equal(held.get('u_w2'), 'wallet')
  assert.equal(held.has('u_w3'), false)
  // deleting most picks before kickoff: held, and the person's own numbers show it
  for (let i = 0; i < 10; i++) await integ.notePost('u_del', { ip: '192.0.2.1', legs: [] })
  for (let i = 0; i < 8; i++) await integ.noteDelete('u_del')
  t += 2 * 60_000
  assert.equal((await integ.holds()).get('u_del'), 'deletes')
  assert.deepEqual(await integ.statsFor('u_del'), { posted: 10, deleted: 8, days: 30 })
  const del = (await integ.list()).find((f) => f.kind === 'deletes')
  assert.equal(del.detail, 'Deleted 8 of 10 picks before kickoff in 30 days.')
})

test('group codes: eight characters nobody misreads', () => {
  for (let i = 0; i < 50; i++) assert.match(newCode(), CODE_RE)
  assert.equal(readCode(' ab2c-d3ef x '), 'AB2CD3EF')
  assert.ok(!CODE_RE.test('AB0CD1EF'), 'no zeros or ones')
})

// ---- the app: groups, tailing into your record, and a hold on the leaderboard -------------
let api
let made
let docs
let now
let restoreEnv
const ADMIN_KEY = 'groups-admin-key-0123456789'
before(async () => {
  restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error', APEX_PAYWALL: 'auto', APEX_TREASURY_ADDRESS: '0x1111111111111111111111111111111111111111', APEX_EPHEMERAL: null, APEX_BOARD_MIN: '5', ADMIN_SPORTS_KEY: ADMIN_KEY })
  now = clock()
  const store = createStore({ driver: 'memory' })
  docs = createStoreDocs(store)
  const billing = createBilling({ docs, now })
  await docs.set('subscriptions', 'u_pro', { plan: 'pro', paidUntil: now() + 20 * DAY, source: 'usdc', email: 'pro@example.com', updatedAt: now() - DAY })
  const { http } = fixtureHttp()
  made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, oddsKey: () => null, now })
  await loadAll(made.engine)
  api = await serve(made.app)
})
after(async () => {
  await api?.close()
  for (const e of Object.values(made?.engines || {})) e.stop()
  restoreEnv?.()
})

test('groups: a member starts one, anyone with a page joins with the code, a board of its own', async () => {
  assert.equal((await api.get('/api/picks/groups')).status, 401)
  // a page first: groups rank the records on it
  const noPage = await api.post('/api/picks/groups', { name: 'Sunday crew' }, { headers: bearer('u_pro') })
  assert.equal(noPage.body.code, 'no_profile')
  assert.equal((await api.put('/api/picks/me', { handle: 'pro_guy', name: 'Pro Guy' }, { headers: bearer('u_pro') })).status, 200)
  assert.equal((await api.put('/api/picks/me', { handle: 'free_gal', name: 'Free Gal' }, { headers: bearer('u_free') })).status, 200)
  // starting one is for members; joining isn't
  const freeTry = await api.post('/api/picks/groups', { name: 'Free crew' }, { headers: bearer('u_free') })
  assert.equal(freeTry.status, 402)
  assert.equal((await api.post('/api/picks/groups', { name: 'x' }, { headers: bearer('u_pro') })).body.code, 'bad_name')
  const made1 = await api.post('/api/picks/groups', { name: '  Sunday   crew <b>' }, { headers: bearer('u_pro') })
  assert.equal(made1.status, 200, JSON.stringify(made1.body))
  const g = made1.body.group
  assert.equal(g.name, 'Sunday crew b')
  assert.match(g.code, CODE_RE)
  assert.equal(g.owner, true)
  // the join link shows the name before joining, signed in or not
  const peek = await api.get(`/api/picks/groups/code/${g.code.toLowerCase()}`)
  assert.deepEqual(peek.body, { name: 'Sunday crew b', members: 1, full: false, owner: 'pro_guy' })
  assert.equal((await api.get('/api/picks/groups/code/NOPE2345')).status, 404)
  // a stranger can't see the board
  assert.equal((await api.get(`/api/picks/groups/${g.id}`, { headers: bearer('u_free') })).status, 404)
  const joined = await api.post('/api/picks/groups/join', { code: g.code }, { headers: bearer('u_free') })
  assert.equal(joined.status, 200)
  assert.equal(joined.body.group.members, 2)
  assert.equal(joined.body.group.code, null, 'only the owner sees the code')
  assert.equal((await api.post('/api/picks/groups/join', { code: g.code }, { headers: bearer('u_free') })).body.group.members, 2, 'joining twice is once')
  const mine = await api.get('/api/picks/groups', { headers: bearer('u_free') })
  assert.deepEqual(mine.body.groups.map((x) => x.name), ['Sunday crew b'])
  assert.equal(mine.body.canCreate, false)
  // the board: both of them, uids never sent
  const board = await api.get(`/api/picks/groups/${g.id}?range=all`, { headers: bearer('u_free') })
  assert.equal(board.status, 200)
  assert.deepEqual(board.body.rows.map((r) => r.profile.handle).sort(), ['free_gal', 'pro_guy'])
  assert.ok(board.body.rows.every((r) => r.uid === undefined))
  assert.equal(board.body.rows.find((r) => r.you).profile.handle, 'free_gal')
  assert.equal(board.body.rows.find((r) => r.owner).profile.handle, 'pro_guy')
  // the owner's tools: rename, a new code (the old one stops), remove someone
  assert.equal((await api.post(`/api/picks/groups/${g.id}/rename`, { name: 'Nope' }, { headers: bearer('u_free') })).status, 403)
  assert.equal((await api.post(`/api/picks/groups/${g.id}/rename`, { name: 'Sunday Crew' }, { headers: bearer('u_pro') })).body.group.name, 'Sunday Crew')
  const fresh = await api.post(`/api/picks/groups/${g.id}/code`, {}, { headers: bearer('u_pro') })
  assert.notEqual(fresh.body.group.code, g.code)
  assert.equal((await api.get(`/api/picks/groups/code/${g.code}`)).status, 404, 'the old link is dead')
  assert.equal((await api.post(`/api/picks/groups/${g.id}/remove`, { handle: 'free_gal' }, { headers: bearer('u_pro') })).status, 200)
  assert.equal((await api.get(`/api/picks/groups/${g.id}`, { headers: bearer('u_free') })).status, 404)
  assert.equal((await api.get('/api/picks/groups', { headers: bearer('u_free') })).body.groups.length, 0)
  // back in, then the owner leaves: the group passes to the one who's left
  await api.post('/api/picks/groups/join', { code: fresh.body.group.code }, { headers: bearer('u_free') })
  assert.equal((await api.post(`/api/picks/groups/${g.id}/leave`, {}, { headers: bearer('u_pro') })).status, 200)
  const after1 = await api.get('/api/picks/groups', { headers: bearer('u_free') })
  assert.equal(after1.body.groups[0].owner, true, 'free_gal runs it now')
  // and when the last one leaves, it's gone
  await api.post(`/api/picks/groups/${g.id}/leave`, {}, { headers: bearer('u_free') })
  assert.equal((await api.get(`/api/picks/groups/code/${fresh.body.group.code}`)).status, 404)
})

test('tailing a pick into your own record: same legs, your units, marked as tailed', async () => {
  const props = (await api.get('/api/nfl/games/401873020')).body.props.filter((p) => p.kind === 'player' && !p.oneSided && p.posted === 'main')
  await api.put('/api/picks/me', { handle: 'pro_guy', name: 'Pro Guy' }, { headers: bearer('u_pro') })
  await api.put('/api/picks/me', { handle: 'free_gal', name: 'Free Gal' }, { headers: bearer('u_free') })
  const src = await api.post('/api/picks', { legs: [props[0].id, props[1].id], units: 2 }, { headers: bearer('u_pro') })
  assert.equal(src.status, 200, JSON.stringify(src.body))
  const id = src.body.picks[0].id
  assert.equal((await api.post(`/api/picks/${id}/track`, {}, { headers: bearer('u_pro') })).body.code, 'own_pick')
  assert.equal((await api.post(`/api/picks/${id}/track`, {})).status, 401)
  const mine = await api.post(`/api/picks/${id}/track`, { units: 0.5 }, { headers: bearer('u_free') })
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  const p = mine.body.picks[0]
  assert.deepEqual(p.legs.map((l) => l.id), [props[0].id, props[1].id])
  assert.equal(p.units, 0.5)
  assert.deepEqual(p.tailOf, { id, handle: 'pro_guy' })
  // it's on her page, and counted as a tail on his
  const page = await api.get('/api/picks/u/free_gal')
  assert.equal(page.body.open[0].tailOf.handle, 'pro_guy')
  const his = await api.get('/api/picks/u/pro_guy', { headers: bearer('u_pro') })
  assert.equal(his.body.open.find((x) => x.id === id).tails, 1)
  // the same pick twice the same day is refused, like posting it twice
  assert.equal((await api.post(`/api/picks/${id}/track`, {}, { headers: bearer('u_free') })).body.code, 'dup_pick')
  // a page shows its deletes before kickoff
  assert.deepEqual(page.body.fairPlay, { posted: 1, deleted: 0, days: 30 })
})

test('a fair-play hold keeps an account off the public leaderboard, and the owner is told', async () => {
  const t = now()
  // both have a real pass (opening their own page re-reads it)
  for (const uid of ['u_elite', 'u_elite2']) await docs.set('subscriptions', uid, { plan: 'pro', paidUntil: t + 20 * DAY, source: 'usdc', updatedAt: t - DAY })
  let st = null
  for (let i = 0; i < 8; i++) st = applyGraded(st, { result: i % 2 ? 'win' : 'loss', price: 150, units: 1, profit: i % 2 ? 1.5 : -1, clv: 0.01, legs: [{ sport: 'nfl' }] }, new Date(t - i * DAY).toISOString().slice(0, 10))
  for (const [uid, handle] of [
    ['u_elite', 'held_one'],
    ['u_elite2', 'clean_one'],
  ]) {
    await docs.set('profiles', uid, { uid, handle, name: handle, createdAt: t - 40 * DAY, recordAt: t - DAY, stats: st, paidUntil: t + 10 * DAY })
    await docs.set('profileHandles', handle, { uid })
  }
  const before1 = await api.get('/api/picks/leaderboard?range=30d&sort=units', { headers: bearer('u_pro') })
  assert.ok(before1.body.rows.some((r) => r.profile.handle === 'held_one'))
  // two accounts paid from one wallet: the wallet check raises it on the next look
  await docs.set('billingPayments', 'inv_a', { uid: 'u_elite', from: '0x2222222222222222222222222222222222222222', createdAt: t })
  await docs.set('billingPayments', 'inv_b', { uid: 'u_someone', from: '0x2222222222222222222222222222222222222222', createdAt: t + 1 })
  // the cached board, holds and wallet list expire within ten minutes
  now.add(11 * 60_000)
  const after1 = await api.get('/api/picks/leaderboard?range=30d&sort=roi', { headers: bearer('u_pro') })
  assert.ok(!after1.body.rows.some((r) => r.profile.handle === 'held_one'), 'held off the board')
  assert.ok(after1.body.rows.some((r) => r.profile.handle === 'clean_one'))
  const me = await api.get('/api/picks/me', { headers: bearer('u_elite') })
  assert.equal(me.body.held, 'wallet')
  // the admin sees it with handles, and clears it
  assert.equal((await api.get('/api/admin/integrity', { headers: bearer('u_admin') })).status, 401, 'the admin password, not a Google admin account')
  const adm = { 'x-apex-admin-key': ADMIN_KEY }
  const list = await api.get('/api/admin/integrity', { headers: adm })
  assert.equal(list.status, 200)
  const f = list.body.flags.find((x) => x.kind === 'wallet')
  assert.ok(f, JSON.stringify(list.body.flags))
  assert.deepEqual(f.people.map((x) => x.handle), ['held_one', null])
  assert.equal(f.strong, true)
  assert.equal((await api.post('/api/admin/integrity/clear', { id: f.id }, { headers: adm })).status, 200)
  assert.equal((await api.post('/api/admin/integrity/clear', { id: 'flag-wallet-nope' }, { headers: adm })).status, 404)
  now.add(3 * 60_000)
  const back = await api.get('/api/picks/leaderboard?range=30d&sort=units', { headers: bearer('u_pro') })
  assert.ok(back.body.rows.some((r) => r.profile.handle === 'held_one'), 'cleared: back on the board')
  assert.equal((await api.get('/api/picks/me', { headers: bearer('u_elite') })).body.held, null)
})

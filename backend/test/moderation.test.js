// What people post, kept clean (App Review Guideline 1.2): a word filter on notes, pages and group
// names; reporting through feedback; blocking someone so their picks drop out of your boards.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { objectionable } from '../src/lib/clean.js'
import { fixtureHttp } from './helpers.js'
import { clock, loadAll, testAuth, USERS, bearer, withEnv, serve } from './support.js'

const DAY = 86_400_000
let api
let made
let docs
let restoreEnv
before(async () => {
  restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error', APEX_PAYWALL: 'auto', APEX_TREASURY_ADDRESS: '0x1111111111111111111111111111111111111111', APEX_EPHEMERAL: null })
  const now = clock()
  const store = createStore({ driver: 'memory' })
  docs = createStoreDocs(store)
  const billing = createBilling({ docs, now })
  await docs.set('subscriptions', 'u_pro', { plan: 'pro', paidUntil: now() + 20 * DAY, source: 'usdc', updatedAt: now() - DAY })
  const { http } = fixtureHttp()
  made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, oddsKey: () => null, now, deleteAuthUser: async () => true })
  await loadAll(made.engine)
  api = await serve(made.app)
})
after(async () => {
  await api?.close()
  for (const e of Object.values(made?.engines || {})) e.stop()
  restoreEnv?.()
})

test('the filter: profanity and its disguises, but not betting words that contain one', () => {
  for (const bad of ['shit pick', 'what a fucking lock', 'sh1t', 'fuuuuck this']) assert.equal(objectionable(bad), true, bad)
  for (const ok of ['Jalen over 8.5 rebounds', 'assists over 6.5', 'Hancock to score', 'classic spot', 'Scunthorpe', '', null]) assert.equal(objectionable(ok), false, String(ok))
})

test('pages, notes and group names with a word we don’t allow are refused, with a plain reason', async () => {
  const badName = await api.put('/api/picks/me', { handle: 'pro_guy', name: 'Shit Picks' }, { headers: bearer('u_pro') })
  assert.deepEqual([badName.status, badName.body.code], [400, 'not_allowed'])
  assert.match(badName.body.error, /name/)
  assert.equal((await api.put('/api/picks/me', { handle: 'pro_guy', name: 'Pro Guy', bio: 'Props, mostly NBA.' }, { headers: bearer('u_pro') })).status, 200)
  assert.equal((await api.put('/api/picks/me', { handle: 'free_gal', name: 'Free Gal' }, { headers: bearer('u_free') })).status, 200)
  const props = (await api.get('/api/nfl/games/401873020')).body.props.filter((p) => p.kind === 'player' && !p.oneSided && p.posted === 'main')
  const badNote = await api.post('/api/picks', { legs: [props[0].id, props[1].id], units: 1, note: 'easy money you fucking idiots' }, { headers: bearer('u_free') })
  assert.deepEqual([badNote.status, badNote.body.code], [400, 'not_allowed'])
  const badGroup = await api.post('/api/picks/groups', { name: 'Shit Crew' }, { headers: bearer('u_pro') })
  assert.deepEqual([badGroup.status, badGroup.body.code], [400, 'not_allowed'])
})

test('reporting: a report is its own kind of feedback for the admin', async () => {
  const r = await api.post('/api/members/feedback', { kind: 'report', message: 'Spam on this page', about: 'user:free_gal' }, { headers: bearer('u_pro') })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('blocking: their rows leave your group board; you can’t block yourself; unblocking brings them back', async () => {
  const g = (await api.post('/api/picks/groups', { name: 'Sunday crew' }, { headers: bearer('u_pro') })).body.group
  assert.equal((await api.post('/api/picks/groups/join', { code: g.code }, { headers: bearer('u_free') })).status, 200)
  const board = async () => (await api.get(`/api/picks/groups/${g.id}`, { headers: bearer('u_pro') })).body.rows.map((r) => r.profile.handle).sort()
  assert.deepEqual(await board(), ['free_gal', 'pro_guy'])

  assert.equal((await api.post('/api/picks/blocks', { handle: 'pro_guy' }, { headers: bearer('u_pro') })).body.code, 'self')
  assert.equal((await api.post('/api/picks/blocks', { handle: 'nobody_here' }, { headers: bearer('u_pro') })).status, 404)
  const b = await api.post('/api/picks/blocks', { handle: '@Free_Gal' }, { headers: bearer('u_pro') })
  assert.equal(b.status, 200, JSON.stringify(b.body))
  assert.deepEqual(b.body.blocked.map((x) => x.handle), ['free_gal'])
  assert.deepEqual(await board(), ['pro_guy'], 'blocked: gone from this member’s board')
  // the other member still sees everyone
  assert.deepEqual((await api.get(`/api/picks/groups/${g.id}`, { headers: bearer('u_free') })).body.rows.map((r) => r.profile.handle).sort(), ['free_gal', 'pro_guy'])
  // the feed and the leaderboard answer privately once someone's blocked
  const lb = await api.get('/api/picks/leaderboard', { headers: bearer('u_pro') })
  assert.equal(lb.status, 200)
  assert.match(lb.headers.get('cache-control') || '', /private/)
  assert.ok(!lb.body.rows.some((x) => x.profile?.handle === 'free_gal'))
  const feed = await api.get('/api/picks/feed', { headers: bearer('u_pro') })
  assert.ok(!feed.body.picks.some((x) => (x.profile?.handle || x.handle) === 'free_gal'))

  const un = await api.post('/api/picks/blocks', { handle: 'free_gal', on: false }, { headers: bearer('u_pro') })
  assert.deepEqual(un.body.blocked, [])
  assert.deepEqual(await board(), ['free_gal', 'pro_guy'])
  assert.deepEqual((await api.get('/api/picks/blocks', { headers: bearer('u_pro') })).body.blocked, [])
})

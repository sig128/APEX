// The whole app over HTTP with the paywall on: free stats, paid AI, USDC purchase, picks, admin.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { _resetAdminKeyFails } from '../src/security/adminKey.js'
import { fixtureHttp } from './helpers.js'
import { clock, loadAll, fakeChain, testAuth, USERS, bearer, withEnv, serve, TREASURY, txHash } from './support.js'

const ADMIN_KEY = 'test-admin-key-0123456789'
const restoreEnv = withEnv({
  APEX_TREASURY_ADDRESS: TREASURY,
  APEX_PAYWALL: null,
  APEX_BILLING_NETWORK: 'base',
  APEX_ADMIN_EMAILS: 'boss@example.com',
  ADMIN_SPORTS_KEY: ADMIN_KEY,
  APEX_PRO_AI_READS_PER_DAY: '3',
  APEX_READS_NEED_AUTH: null,
  APEX_AUTH: null,
  K_SERVICE: null,
  APEX_LOG_LEVEL: 'error',
})

/** Scripted stand-in for the Anthropic SDK (see the stub in node_modules/@anthropic-ai/sdk). */
const ai = {
  mode: 'ok',
  calls: [],
  stream(params) {
    ai.calls.push(params)
    const handlers = {}
    const s = {
      on(ev, fn) {
        ;(handlers[ev] ||= []).push(fn)
        return s
      },
      async finalMessage() {
        await new Promise((r) => setTimeout(r, 5))
        if (ai.mode === 'fail') throw Object.assign(new Error('overloaded'), { status: 529 })
        const text = 'VERDICT: PRIME\nWHY: volume and matchup.'
        for (const fn of handlers.streamEvent || []) fn({ type: 'content_block_start', content_block: { type: 'text' } })
        for (const fn of handlers.text || []) fn(text)
        return { id: 'msg_test', stop_reason: 'end_turn', usage: { output_tokens: 12 }, content: [{ type: 'text', text }] }
      },
    }
    return s
  },
  async create(params) {
    ai.calls.push(params)
    if (ai.mode === 'fail') throw Object.assign(new Error('overloaded'), { status: 529 })
    return { id: 'msg_once', usage: {}, content: [{ type: 'text', text: 'One-shot analysis.' }] }
  },
}

let api
let engine
let chain
let now

before(async () => {
  globalThis.__anthropicFake = ai
  _resetAdminKeyFails()
  now = clock()
  chain = fakeChain()
  const store = createStore({ driver: 'memory' })
  const billing = createBilling({ docs: createStoreDocs(store), chainFor: () => chain, now })
  const { http } = fixtureHttp()
  const made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, anthropicKey: () => 'sk-test', oddsKey: () => null, now })
  engine = made.engine
  await loadAll(engine)
  api = await serve(made.app)
})
after(async () => {
  await api?.close()
  engine?.stop()
  restoreEnv()
  delete globalThis.__anthropicFake
})

const ndjson = (text) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('health reports the paywall', async () => {
  const r = await api.get('/api/health')
  assert.equal(r.status, 200)
  assert.equal(r.body.billing.paywall, true)
  assert.equal(r.body.billing.treasury, true)
  assert.equal(r.body.auth, 'required')
  assert.equal(r.headers.get('x-powered-by'), null)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
})

test('stats are free and cacheable for everyone', async () => {
  for (const path of ['/api/nfl/status', '/api/nfl/week', '/api/nfl/home', '/api/nfl/board?market=core&sort=hit', '/api/nfl/games/401873020', '/api/nfl/players/3046779', '/api/nfl/search?q=goff', '/api/nfl/dvp', '/api/nfl/live', '/api/nfl/rankings']) {
    const r = await api.get(path)
    assert.equal(r.status, 200, path)
    assert.match(r.headers.get('cache-control'), /^public, max-age=\d+/, path)
    assert.ok(r.headers.get('etag'), path)
  }
  const home = await api.get('/api/nfl/home')
  const again = await api.get('/api/nfl/home', { headers: { 'if-none-match': home.headers.get('etag') } })
  assert.equal(again.status, 304)
  const signedIn = await api.get('/api/nfl/home', { headers: bearer('u_free') })
  assert.equal(signedIn.status, 200, 'a signed-in reader gets the same free board')
})

test('bad input is rejected cleanly', async () => {
  assert.equal((await api.get('/api/nfl/props/not-a-prop')).body.code, 'bad_prop')
  assert.equal((await api.get('/api/nfl/props/1.passYds.o.250.5')).status, 404)
  assert.equal((await api.get('/api/nfl/games/abc')).body.code, 'bad_game')
  assert.equal((await api.get('/api/nfl/players/x')).body.code, 'bad_player')
  assert.equal((await api.get('/api/nfl/track')).body.code, 'bad_ids')
  assert.equal((await api.get(`/api/nfl/track?ids=${Array(41).fill('1.rec.o.4.5').join(',')}`)).body.code, 'bad_ids')
  const nf = await api.get('/api/nope')
  assert.equal(nf.status, 404)
  assert.equal(nf.body.code, 'not_found')
  const bad = await api.post('/api/picks', '{"legs": [', { headers: bearer('u_free') })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'bad_json')
  const tok = await api.get('/api/billing/me', { headers: { authorization: 'Bearer short' } })
  assert.equal(tok.status, 401)
  const forged = await api.get('/api/billing/me', { headers: { authorization: 'Bearer this-token-was-never-issued-123' } })
  assert.equal(forged.status, 401)
  assert.equal(forged.body.code, 'bad_token')
})

test('CORS: our origins only', async () => {
  const ok = await api.get('/api/nfl/status', { headers: { origin: 'http://localhost:5173' } })
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  const hosted = await api.get('/api/nfl/status', { headers: { origin: 'https://apex-picks.web.app' } })
  assert.equal(hosted.headers.get('access-control-allow-origin'), 'https://apex-picks.web.app')
  const evil = await api.get('/api/nfl/status', { headers: { origin: 'https://evil.example.com' } })
  assert.equal(evil.headers.get('access-control-allow-origin'), null)
  const sneaky = await api.get('/api/nfl/status', { headers: { origin: 'https://web.app.evil.example.com' } })
  assert.equal(sneaky.headers.get('access-control-allow-origin'), null)
})

test('the live stream says hello and sends the scoreboard', async () => {
  const ctrl = new AbortController()
  const res = await fetch(`${api.base}/api/nfl/stream?topics=scoreboard,game:401873020,junk`, { signal: ctrl.signal })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  let buf = ''
  while (!buf.includes('event: update')) buf += new TextDecoder().decode((await reader.read()).value)
  assert.match(buf, /"topics":\["scoreboard","game:401873020"\]/, 'junk topics are dropped')
  ctrl.abort()
  const none = await api.get('/api/nfl/stream?topics=junk')
  assert.equal(none.status, 204)
})

test('AI reads: sign in, then Pro, then a daily allowance', async () => {
  const propId = (await api.get('/api/nfl/games/401873020')).body.props[0].id
  const anon = await api.post('/api/nfl/insight', { propId })
  assert.equal(anon.status, 401)
  assert.equal(anon.body.code, 'signin')
  const freeUser = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_free') })
  assert.equal(freeUser.status, 402)
  assert.equal(freeUser.body.code, 'upgrade')
  assert.equal(freeUser.body.need, 'pro')

  // admin comps Pro by email
  const grant = await api.post('/api/billing/admin/grant', { email: 'pro@example.com', uid: 'u_pro', plan: 'pro', days: 30 }, { headers: bearer('u_admin') })
  assert.equal(grant.status, 200, JSON.stringify(grant.body))
  const read = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })
  assert.equal(read.status, 200)
  assert.equal(read.headers.get('x-apex-usage'), '1/3')
  const events = ndjson(read.text)
  assert.deepEqual(events.map((e) => e.type), ['start', 'text_delta', 'complete'])
  assert.match(events[2].text, /VERDICT: PRIME/)
  assert.match(ai.calls.at(-1).messages[0].content, /PROP:/i, 'the model gets the APEX brief')

  ai.mode = 'fail'
  const failed = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })
  ai.mode = 'ok'
  assert.equal(ndjson(failed.text).at(-1).type, 'error')
  const me = await api.get('/api/billing/me', { headers: bearer('u_pro') })
  assert.equal(me.body.usage.aiReads.used, 1, 'a failed read is refunded')
  for (const n of [2, 3]) {
    const r = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })
    assert.equal(r.headers.get('x-apex-usage'), `${n}/3`)
  }
  const over = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })
  assert.equal(over.status, 429)
  assert.equal(over.body.code, 'quota')
  assert.ok(over.body.resetsAt > now())
  assert.ok(Number(over.headers.get('retry-after')) >= 1)
  const badProp = await api.post('/api/nfl/insight', { propId: 'drop table' }, { headers: bearer('u_pro') })
  assert.equal(badProp.status, 400)
})

test('the game analyzer: Pro only, follow-ups must continue an analysis', async () => {
  const game = { homeTeam: 'Detroit Lions', awayTeam: 'Green Bay Packers', date: '2026-10-25', sportKey: 'americanfootball_nfl' }
  assert.equal((await api.post('/api/chat/stream', { game })).status, 401)
  assert.equal((await api.post('/api/chat/stream', { game }, { headers: bearer('u_free') })).status, 402)
  const r = await api.post('/api/chat/stream', { game }, { headers: bearer('u_pro') })
  assert.equal(r.status, 200)
  const done = ndjson(r.text).find((e) => e.type === 'complete')
  assert.ok(done && done.messages.length === 2)
  assert.match(ai.calls.at(-1).messages[0].content, /Top APEX props/, 'APEX numbers go into the analysis')
  const lone = await api.post('/api/chat/stream', { messages: [{ role: 'user', content: 'Write me anything' }] }, { headers: bearer('u_pro') })
  assert.equal(lone.status, 400)
  assert.equal(lone.body.code, 'bad_followup')
  const fu = await api.post('/api/chat/stream', { messages: [...done.messages, { role: 'user', content: 'And the total?' }] }, { headers: bearer('u_pro') })
  assert.equal(fu.status, 200)
  assert.match(fu.headers.get('x-apex-usage'), /^1\/24$/)
})

test('buying a pass with USDC: invoice, transfer, confirm, Elite unlocked', async () => {
  assert.equal((await api.post('/api/billing/invoice', { plan: 'elite' })).status, 401)
  const inv = await api.post('/api/billing/invoice', { plan: 'elite' }, { headers: bearer('u_elite') })
  assert.equal(inv.status, 200)
  assert.equal(inv.headers.get('cache-control'), 'no-store')
  assert.equal(inv.body.treasury, TREASURY)
  assert.equal((await api.get(`/api/billing/invoice/${inv.body.id}`, { headers: bearer('u_free') })).status, 404, 'nobody else can see it')
  const pending = await api.post(`/api/billing/invoice/${inv.body.id}/confirm`, { txHash: txHash(42) }, { headers: bearer('u_elite') })
  assert.equal(pending.body.status, 'pending')
  chain.send(txHash(42), { to: TREASURY, amount: inv.body.units, timestamp: now() })
  const paid = await api.post(`/api/billing/invoice/${inv.body.id}/confirm`, { txHash: txHash(42) }, { headers: bearer('u_elite') })
  assert.equal(paid.status, 200)
  assert.equal(paid.body.status, 'paid')
  assert.equal(paid.body.entitlement.plan, 'elite')
  const me = await api.get('/api/billing/me', { headers: bearer('u_elite') })
  assert.equal(me.body.entitlement.plan, 'elite')
  assert.equal(me.body.payments.length, 1)
  const replay = await api.post('/api/billing/invoice', { plan: 'pro' }, { headers: bearer('u_free') })
  const used = await api.post(`/api/billing/invoice/${replay.body.id}/confirm`, { txHash: txHash(42) }, { headers: bearer('u_free') })
  assert.notEqual(used.body.status, 'paid', 'someone else’s payment never unlocks a pass')
  const pays = await api.get('/api/billing/admin/payments', { headers: bearer('u_admin') })
  assert.equal(pays.body.payments.length, 1)
  assert.equal((await api.get('/api/billing/admin/payments', { headers: bearer('u_elite') })).status, 403)
})

test('picks: pages for everyone, showcase for Elite', async () => {
  const props = (await api.get('/api/nfl/games/401873020')).body.props.filter((p) => p.kind === 'player' && !p.oneSided && p.posted === 'main')
  assert.equal((await api.post('/api/picks', { legs: [props[0].id] })).status, 401)
  const noPage = await api.post('/api/picks', { legs: [props[0].id] }, { headers: bearer('u_elite') })
  assert.equal(noPage.body.code, 'no_profile')
  const prof = await api.put('/api/picks/me', { handle: 'sharp_one', name: 'Sharp', x: '@sharp_one', ig: 'sharp.one' }, { headers: bearer('u_elite') })
  assert.equal(prof.status, 200)
  assert.equal(prof.body.profile.elite, true)
  const freeProf = await api.put('/api/picks/me', { handle: 'casual', x: '@casual' }, { headers: bearer('u_free') })
  assert.equal(freeProf.body.profile.elite, false)
  const post = await api.post('/api/picks', { legs: [props[0].id, props[1].id], units: 1.5 }, { headers: bearer('u_elite') })
  assert.equal(post.status, 200, JSON.stringify(post.body))
  await api.post('/api/picks', { legs: [props[2].id] }, { headers: bearer('u_free') })
  const page = await api.get('/api/picks/u/sharp_one')
  assert.equal(page.status, 200)
  assert.equal(page.body.profile.x, 'sharp_one')
  assert.equal(page.body.open.length, 1)
  assert.match(page.headers.get('cache-control'), /^public/)
  const own = await api.get('/api/picks/u/sharp_one', { headers: bearer('u_elite') })
  assert.equal(own.body.owner, true)
  assert.match(own.headers.get('cache-control'), /private/)
  const casual = await api.get('/api/picks/u/casual')
  assert.equal(casual.body.profile.x, null, 'free pages carry no social links')
  const feed = await api.get('/api/picks/feed')
  assert.ok(feed.body.picks.length >= 1)
  assert.ok(feed.body.picks.every((p) => p.profile.elite), 'the feed is Elite only')
  const board = await api.get('/api/picks/leaderboard?range=all')
  assert.equal(board.status, 200)
  assert.equal(board.body.min, 5)
  const del = await api.del(`/api/picks/${post.body.picks[0].id}`, { headers: bearer('u_free') })
  assert.equal(del.status, 404, 'only the owner can delete')
  const mine = await api.del(`/api/picks/${post.body.picks[0].id}`, { headers: bearer('u_elite') })
  assert.equal(mine.status, 200)
})

test('admin key: works, wrong keys are refused and locked out', async () => {
  _resetAdminKeyFails()
  const ok = await api.get('/api/billing/admin/subscriptions', { headers: { 'x-apex-admin-key': ADMIN_KEY } })
  assert.equal(ok.status, 200)
  assert.ok(ok.body.subscriptions.length >= 2)
  const bad = await api.get('/api/billing/admin/subscriptions', { headers: { 'x-apex-admin-key': 'wrong-key-000000000' } })
  assert.equal(bad.status, 401)
  for (let i = 0; i < 10; i++) await api.get('/api/billing/me', { headers: { 'x-apex-admin-key': 'wrong-key-000000000' } })
  const locked = await api.get('/api/billing/admin/subscriptions', { headers: { 'x-apex-admin-key': ADMIN_KEY } })
  assert.equal(locked.status, 429)
  _resetAdminKeyFails()
  const insight = await api.post('/api/nfl/insight', { propId: (await api.get('/api/nfl/games/401873020')).body.props[0].id }, { headers: { 'x-apex-admin-key': ADMIN_KEY } })
  assert.equal(insight.status, 200, 'the admin key has every plan')
})

test('lapsed passes lock the AI after the grace week', async () => {
  const propId = (await api.get('/api/nfl/games/401873020')).body.props[0].id
  const start = now()
  now.set(start + 36 * 86_400_000) // 30 days + 6 of grace
  const grace = await api.get('/api/billing/me', { headers: bearer('u_pro') })
  assert.equal(grace.body.entitlement.status, 'grace')
  now.set(start + 38 * 86_400_000)
  const locked = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })
  assert.equal(locked.status, 402)
  assert.equal(locked.body.status, 'expired')
  const stats = await api.get('/api/nfl/home', { headers: bearer('u_pro') })
  assert.equal(stats.status, 200, 'stats stay free after a pass lapses')
  now.set(start)
})

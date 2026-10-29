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
import { nbaFixtures } from './fixtures/nba.js'

const ADMIN_KEY = 'test-admin-key-0123456789'
const restoreEnv = withEnv({
  // these tests script the Anthropic path; a real OpenAI key in the shell must not take over
  OPENAI_API_KEY: null,
  APEX_AI_PROVIDER: null,
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
    if (ai.createBlocks) return { id: 'msg_blocks', usage: {}, content: ai.createBlocks }
    return { id: 'msg_once', usage: {}, content: [{ type: 'text', text: ai.createText || 'One-shot analysis.' }] }
  },
}

let api
let engine
let engines
let picksSvc
let chain
let now

before(async () => {
  globalThis.__anthropicFake = ai
  _resetAdminKeyFails()
  now = clock()
  chain = fakeChain()
  const store = createStore({ driver: 'memory' })
  const billing = createBilling({ docs: createStoreDocs(store), chainFor: () => chain, now })
  // the NFL week plus an NBA day, so slips can cross leagues
  const { http } = fixtureHttp(nbaFixtures({ now: now() }))
  const made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, anthropicKey: () => 'sk-test', oddsKey: () => null, now })
  engine = made.engine
  engines = made.engines
  picksSvc = made.picks
  await loadAll(engine)
  await loadAll(engines.nba)
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

test('AI reads: sign in, then Pro, then a daily allowance, and a read is shared, not paid twice', async () => {
  const ids = (await api.get('/api/nfl/games/401873020')).body.props.map((p) => p.id)
  const propId = ids[0]
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
  assert.match(ai.calls.at(-1).messages[0].content, /PROP:/i, 'the model gets the Propify brief')

  // the same prop again, by anyone with access: the shared read, no new AI call, no allowance
  const calls = ai.calls.length
  for (const who of ['u_pro', 'u_admin']) {
    const again = await api.post('/api/nfl/insight', { propId }, { headers: bearer(who) })
    assert.equal(again.status, 200)
    assert.equal(again.headers.get('x-apex-usage'), null)
    const ev = ndjson(again.text)
    assert.equal(ev[0].cached, true)
    assert.match(ev.at(-1).text, /VERDICT: PRIME/)
  }
  assert.equal(ai.calls.length, calls, 'nobody paid for the same read twice')

  ai.mode = 'fail'
  const failed = await api.post('/api/nfl/insight', { propId: ids[1] }, { headers: bearer('u_pro') })
  ai.mode = 'ok'
  assert.equal(ndjson(failed.text).at(-1).type, 'error')
  const me = await api.get('/api/billing/me', { headers: bearer('u_pro') })
  assert.equal(me.body.usage.aiReads.used, 1, 'a failed read is refunded, and a shared one never charged')
  assert.equal(me.body.ai.allowed, true)
  for (const n of [2, 3]) {
    const r = await api.post('/api/nfl/insight', { propId: ids[n] }, { headers: bearer('u_pro') })
    assert.equal(r.headers.get('x-apex-usage'), `${n}/3`)
  }
  const over = await api.post('/api/nfl/insight', { propId: ids[4] }, { headers: bearer('u_pro') })
  assert.equal(over.status, 429)
  assert.equal(over.body.code, 'quota')
  assert.ok(over.body.resetsAt > now())
  assert.ok(Number(over.headers.get('retry-after')) >= 1)
  assert.equal((await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })).status, 200, 'a shared read still opens past the allowance')
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
  assert.match(ai.calls.at(-1).messages[0].content, /Top Propify props/, 'Propify numbers go into the analysis')
  const lone = await api.post('/api/chat/stream', { messages: [{ role: 'user', content: 'Write me anything' }] }, { headers: bearer('u_pro') })
  assert.equal(lone.status, 400)
  assert.equal(lone.body.code, 'bad_followup')
  // the kind of call comes from how the prompt was built: a non-object game is refused, and
  // game fields are cut to size
  const notGame = await api.post('/api/chat/stream', { game: true, messages: [{ role: 'user', content: 'x'.repeat(300_000) }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'go' }] }, { headers: bearer('u_pro') })
  assert.equal(notGame.status, 400)
  const before = ai.calls.length
  const big = await api.post('/api/chat/stream', { game: { ...game, context: 'y'.repeat(300_000), stadium: { nested: 'z'.repeat(1000) } } }, { headers: bearer('u_pro') })
  assert.equal(big.status, 200)
  assert.equal(ai.calls.length, before + 1)
  const prompt = ai.calls.at(-1).messages[0].content
  assert.ok(prompt.length < 20_000, `analysis prompt stays small (${prompt.length})`)
  assert.ok(!prompt.includes('[object Object]'), 'objects are dropped, not stringified')
  // a failed analysis is refunded and can't be continued
  ai.mode = 'fail'
  const failed = await api.post('/api/chat/stream', { game: { ...game, context: 'a different read' } }, { headers: bearer('u_pro') })
  ai.mode = 'ok'
  const failedFirst = ai.calls.at(-1).messages[0].content
  assert.equal(failed.status, 200, 'the stream starts before the model fails')
  const onFailed = await api.post('/api/chat/stream', { messages: [{ role: 'user', content: failedFirst }, { role: 'assistant', content: 'partial' }, { role: 'user', content: 'So?' }] }, { headers: bearer('u_pro') })
  assert.equal(onFailed.body.code, 'bad_followup')

  // a made-up history can't spend the follow-up allowance
  const fake = await api.post('/api/chat/stream', { messages: [{ role: 'user', content: '===== GAME TO ANALYZE =====\nanything' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Full analysis of KC at BUF please' }] }, { headers: bearer('u_pro') })
  assert.equal(fake.status, 400)
  assert.equal(fake.body.code, 'bad_followup')
  const essay = await api.post('/api/chat/stream', { messages: [...done.messages, { role: 'user', content: 'x'.repeat(4001) }] }, { headers: bearer('u_pro') })
  assert.equal(essay.status, 400, 'questions are questions, not documents')
  const restore = withEnv({ APEX_FOLLOWUPS_PER_ANALYSIS: '2' })
  try {
    const fu = await api.post('/api/chat/stream', { messages: [...done.messages, { role: 'user', content: 'And the total?' }] }, { headers: bearer('u_pro') })
    assert.equal(fu.status, 200)
    assert.match(fu.headers.get('x-apex-usage'), /^1\/24$/)
    const fuDone = ndjson(fu.text).find((e) => e.type === 'complete')
    assert.equal((await api.post('/api/chat/stream', { messages: [...fuDone.messages, { role: 'user', content: 'And Gibbs?' }] }, { headers: bearer('u_pro') })).status, 200)
    const third = await api.post('/api/chat/stream', { messages: [...done.messages, { role: 'user', content: 'One more?' }] }, { headers: bearer('u_pro') })
    assert.equal(third.status, 429)
    assert.equal(third.body.code, 'thread_full')
  } finally {
    restore()
  }
})

test('parlay simulator: Pro only, real legs, numbers that add up', async () => {
  const props = (await api.get('/api/nfl/games/401873020')).body.props.filter((p) => p.kind === 'player').slice(0, 3).map((p) => p.id)
  assert.equal((await api.post('/api/nfl/sim', { legs: props })).status, 401)
  assert.equal((await api.post('/api/nfl/sim', { legs: props }, { headers: bearer('u_free') })).status, 402)
  assert.equal((await api.post('/api/nfl/sim', { legs: [] }, { headers: bearer('u_pro') })).status, 400)
  assert.equal((await api.post('/api/nfl/sim', { legs: ['1.passYds.o.250.5'] }, { headers: bearer('u_pro') })).status, 404)
  const r = await api.post('/api/nfl/sim', { legs: props, iterations: 25000, price: 600, bets: 50 }, { headers: bearer('u_pro') })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.iterations, 25000)
  assert.equal(r.body.legs.length, 3)
  for (const l of r.body.legs) assert.ok(Math.abs(l.hitRate + l.pushRate * 0 - l.apex) < 0.03, `${l.label}: ${l.hitRate} vs Propify ${l.apex}`)
  const sumHit = r.body.parlay.legsHit.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sumHit - 1) < 1e-9, 'every run lands somewhere')
  assert.ok(r.body.price.implied > 0.14 && r.body.price.implied < 0.15)
  assert.equal(r.body.luck.bets, 50)
  assert.equal(r.headers.get('cache-control'), 'no-store')
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
  // tailing: counted once per person while the pick is open
  const pid = post.body.picks[0].id
  const t1 = await api.post(`/api/picks/${pid}/tail`, {}, { headers: bearer('u_free') })
  assert.equal(t1.status, 200, JSON.stringify(t1.body))
  assert.equal(t1.body.tails, 1)
  const t2 = await api.post(`/api/picks/${pid}/tail`, {}, { headers: bearer('u_free') })
  assert.equal(t2.body.tails, 1, 'the same person twice counts once')
  assert.equal(t2.body.already, true)
  assert.equal((await api.post(`/api/picks/${pid}/tail`, {})).body.tails, 2, 'a guest counts too')
  assert.equal((await api.post('/api/picks/pk_nope/tail', {})).status, 404)
  const tailed = await api.get('/api/picks/u/sharp_one')
  assert.equal(tailed.body.open[0].tails, 2)
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

test('parlay check: Pro only, reads a typed slip, simulates, then a verdict per leg', async () => {
  const props = (await api.get('/api/nfl/games/401873020')).body.props.filter((p) => p.kind !== 'team' && !p.oneSided)
  const [a, b] = props
  assert.equal((await api.post('/api/nfl/check', { legs: [a.id] })).status, 401)
  assert.equal((await api.post('/api/nfl/check', { legs: [a.id] }, { headers: bearer('u_free') })).status, 402)
  const grant = await api.post('/api/billing/admin/grant', { email: 'two@example.com', uid: 'u_elite2', plan: 'elite', days: 30 }, { headers: bearer('u_admin') })
  assert.equal(grant.status, 200, JSON.stringify(grant.body))
  const who = 'u_elite2'
  const empty = await api.post('/api/nfl/check', {}, { headers: bearer(who) })
  assert.equal(empty.status, 400)
  const badImg = await api.post('/api/nfl/check', { image: { type: 'image/svg+xml', data: 'PHN2Zz4=' } }, { headers: bearer(who) })
  assert.equal(badImg.status, 400, 'only raster screenshots')

  ai.createText = JSON.stringify({
    legs: [
      { player: a.name, market: a.market, side: a.side, line: a.line, odds: -120 },
      { player: 'Nobody McFake', market: 'recYds', side: 'o', line: 40.5, odds: null },
    ],
    parlayOdds: 250,
    notes: '',
  })
  const r = await api.post('/api/nfl/check', { text: `${a.name} over ${a.line}`, legs: [b.id] }, { headers: bearer(who) })
  ai.createText = null
  assert.equal(r.status, 200, r.text)
  const ev = ndjson(r.text)
  const legs = ev.find((e) => e.type === 'legs')
  assert.equal(legs.legs.length, 2, 'the board leg plus the matched typed leg')
  assert.ok(legs.legs.some((l) => l.id === a.id && l.odds === -120), 'the slip price is kept')
  assert.equal(legs.unmatched.length, 1)
  assert.ok(['keep', 'cut', 'risky'].includes(legs.legs[0].lean))
  const sim = ev.find((e) => e.type === 'sim')
  assert.ok(sim.parlay.hitRate > 0 && sim.parlay.hitRate < 1)
  assert.equal(sim.price.price, 250)
  assert.equal(ev.at(-1).type, 'complete')
  assert.match(ai.calls.at(-1).system, /KEEP/, 'the verdict prompt')
  assert.match(ai.calls.at(-1).messages[0].content, /LEG 2/)
})

test('game intel: Pro only, reputable sources only, one shared scan per game', async () => {
  const g = (await api.get('/api/nfl/games/401873020')).body
  const star = g.props.find((p) => p.kind !== 'team')
  assert.equal((await api.post('/api/nfl/intel', { gameId: '401873020' })).status, 401)
  assert.equal((await api.post('/api/nfl/intel', { gameId: '401873020' }, { headers: bearer('u_free') })).status, 402)
  assert.equal((await api.post('/api/nfl/intel', { gameId: 'x' }, { headers: bearer('u_elite2') })).status, 400)
  const calls = ai.calls.length
  ai.createBlocks = [
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'injury report' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://www.espn.com/nfl/story/_/id/1', title: 'Injury report' }, { type: 'web_search_result', url: 'https://leaks.example.net/playbook', title: 'Leaked playbook' }] },
    {
      type: 'text',
      text: JSON.stringify({
        summary: 'The top receiver was limited all week.',
        injuries: [{ player: star.name, team: star.teamAbbr, status: 'Questionable', note: 'Hamstring, limited Thursday and Friday.', url: 'https://www.espn.com/nfl/story/_/id/1' }],
        news: [
          { headline: 'Coach says the run game is the plan', team: star.teamAbbr, detail: 'Said so at Wednesday’s press conference.', impact: 'up', players: [star.name], url: 'https://www.nfl.com/news/x', date: '2026-10-22' },
          { headline: 'Leaked game plan', team: star.teamAbbr, detail: 'Do not use.', impact: 'up', players: [], url: 'https://leaks.example.net/playbook' },
        ],
        angles: [{ player: star.name, lean: 'hurt', why: 'A limited hamstring caps his snaps.' }],
      }),
    },
  ]
  const r = await api.post('/api/nfl/intel', { gameId: '401873020' }, { headers: bearer('u_elite2') })
  ai.createBlocks = null
  assert.equal(r.status, 200, r.text)
  const req = ai.calls.at(-1)
  assert.equal(req.tools[0].type, 'web_search_20250305')
  assert.ok(req.tools[0].allowed_domains.includes('espn.com'), 'search is limited to established outlets')
  assert.match(req.system, /Never use or repeat leaked/)
  assert.equal(r.body.news.length, 1, 'items from outlets off the list are dropped')
  assert.ok(r.body.sources.every((x) => !/leaks/.test(x.url)))
  assert.equal(r.body.injuries[0].playerId, star.playerId, 'players are linked to the board')
  assert.ok(r.body.angles[0].props.length > 0)
  assert.equal(r.body.cached, false)
  const again = await api.post('/api/nfl/intel', { gameId: '401873020' }, { headers: bearer('u_elite') })
  assert.equal(again.status, 200)
  assert.equal(again.body.cached, true)
  assert.equal(ai.calls.length, calls + 1, 'the scan is shared')
})

test('3-Leg Lock: Pro only, every prop through the rules, and a public season ledger', async () => {
  assert.equal((await api.get('/api/nfl/lock')).status, 401)
  assert.equal((await api.get('/api/nfl/lock', { headers: bearer('u_free') })).status, 402)
  const r = await api.get('/api/nfl/lock', { headers: bearer('u_elite2') })
  assert.equal(r.status, 200, r.text)
  assert.ok(['certified', 'price_needed', 'pass'].includes(r.body.status))
  assert.ok(r.body.funnel.scanned > 100, 'the whole board is scanned')
  assert.ok(r.body.funnel.prob <= r.body.funnel.scanned)
  if (r.body.status === 'pass') assert.ok(r.body.reason)
  else assert.equal(r.body.lock.legs.length, 3)
  const led = await api.get('/api/nfl/lock/ledger')
  assert.equal(led.status, 200)
  assert.equal(led.body.weeks.length, 1, 'this week is on the ledger')
  assert.equal(led.body.full, false)
})

test('one slip across leagues: simulate, shop, post a pick, grade it on its own league', async () => {
  const nfl = (await api.get('/api/nfl/games/401873020')).body.props.find((p) => p.kind === 'player' && !p.oneSided && p.posted === 'main')
  const nbaId = '101.pts.o.23.5'
  const board = await api.get('/api/nba/home')
  assert.equal(board.status, 200)
  assert.equal(board.body.sport, 'nba')
  assert.equal(board.body.calendar, 'day')
  assert.ok(board.body.tabs.apex.every((c) => c.sport === 'nba'), 'cards say which league they belong to')

  // the simulator: any league's endpoint takes the other league's legs by ref
  const sim = await api.post('/api/nfl/sim', { legs: [nfl.id, `nba:${nbaId}`], iterations: 10000 }, { headers: bearer('u_pro') })
  assert.equal(sim.status, 200, JSON.stringify(sim.body))
  assert.deepEqual(sim.body.legs.map((l) => l.id), [nfl.id, nbaId])
  assert.equal(sim.body.parlay.correlated.length, 0, 'an NFL leg and an NBA leg never move together')
  const indep = sim.body.legs[0].hitRate * sim.body.legs[1].hitRate
  assert.ok(Math.abs(sim.body.parlay.hitRate - indep) < 0.02, `${sim.body.parlay.hitRate} vs ${indep}`)
  const back = await api.post('/api/nba/sim', { legs: [nbaId, `nfl:${nfl.id}`], iterations: 10000 }, { headers: bearer('u_pro') })
  assert.equal(back.status, 200)
  assert.equal((await api.post('/api/nba/sim', { legs: ['nhl:1.sog.o.2.5'] }, { headers: bearer('u_pro') })).status, 404, 'a leg not on its board')
  assert.equal((await api.post('/api/nba/sim', { legs: ['__proto__:1.sog.o.2.5', 'constructor:1.pts.o.2.5'] }, { headers: bearer('u_pro') })).status, 404, 'junk league keys are just missing legs')
  assert.equal((await api.post('/api/picks/check', { legs: ['__proto__:1.pts.o.2.5'] })).body.legs[0].code, 'bad_leg')

  // line shopping: the NBA leg carries DraftKings' price from ESPN
  const shop = await api.post('/api/nba/shop', { legs: [nbaId, `nfl:${nfl.id}`] })
  assert.equal(shop.status, 200, JSON.stringify(shop.body))
  assert.equal(shop.body.legs.length, 2)
  assert.equal(shop.body.legs[0].books.find((b) => b.book === 'draftkings')?.price, -115)

  // picks: an NBA leg goes on the record and is graded from the NBA box score
  assert.equal((await api.put('/api/picks/me', { handle: 'hoops_pro', name: 'Hoops' }, { headers: bearer('u_pro') })).status, 200)
  const check = await api.post('/api/picks/check', { legs: [`nba:${nbaId}`, 'nba:999.pts.o.9.5'] })
  assert.deepEqual(check.body.legs.map((l) => l.id), ['nba:999.pts.o.9.5'], 'problems come back under the ref that was sent')
  const post = await api.post('/api/picks', { legs: [`nba:${nbaId}`], units: 1 }, { headers: bearer('u_pro') })
  assert.equal(post.status, 200, JSON.stringify(post.body))
  const leg = post.body.picks[0].legs[0]
  assert.equal(leg.sport, 'nba')
  assert.equal(leg.price, -115)
  const nba = engines.nba
  const g = [...nba.wh.games.values()][0]
  const t0 = now()
  try {
    now.set(Date.parse(g.date) + 3 * 3600_000)
    nba.wh.setSummary(g.id, { ...(nba.wh.summaries.get(g.id)?.data || {}), status: { state: 'post', completed: true, name: 'STATUS_FINAL', short: 'Final', detail: 'Final', period: 4, clock: '0:00' }, players: { 101: { id: '101', name: 'Laker Guard', teamId: '13', stats: { pts: 31, reb: 4, ast: 8 } } } }, now())
    const graded = await picksSvc.gradeOpen()
    assert.ok(graded.graded >= 1)
    const page = await api.get('/api/picks/u/hoops_pro', { headers: bearer('u_pro') })
    const pick = page.body.history.find((p) => p.id === post.body.picks[0].id)
    assert.equal(pick?.result, 'win', JSON.stringify(page.body))
    assert.equal(pick.legs[0].value, 31)
    assert.equal(pick.legs[0].sport, 'nba')
  } finally {
    now.set(t0)
  }
})

// Paywall off (no treasury yet): the site is open, but the AI still takes a real Pro or Elite
// pass (an invite code alone doesn't open it), and an optional "sign in to read anything" mode
// with signed stream tickets.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createStore } from '../src/lib/store.js'
import { fixtureHttp } from './helpers.js'
import { clock, loadAll, testAuth, USERS, bearer, withEnv, serve } from './support.js'

const restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_AI_PROVIDER: null, APEX_TREASURY_ADDRESS: null, APEX_PAYWALL: 'off', APEX_READS_NEED_AUTH: null, APEX_AUTH: null, K_SERVICE: null, APEX_STREAM_SECRET: 's'.repeat(32), APEX_LOG_LEVEL: 'error' })

let api
let engine
let made
before(async () => {
  globalThis.__anthropicFake = {
    stream() {
      const h = {}
      const s = {
        on: (ev, fn) => ((h[ev] ||= []).push(fn), s),
        finalMessage: async () => {
          for (const fn of h.text || []) fn('VERDICT: STANDARD')
          return { id: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'VERDICT: STANDARD' }] }
        },
      }
      return s
    },
  }
  const { http } = fixtureHttp()
  made = createApexApp({ engineMode: 'lazy', http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS, { invited: ['u_pro'] }), anthropicKey: () => 'sk-test', oddsKey: () => null, now: clock() })
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

test('no paywall: the site is open, but the AI takes a real pass, with its daily allowance', async () => {
  const cfg = await api.get('/api/billing/config')
  assert.equal(cfg.body.paywall, false)
  assert.equal(cfg.body.aiOpen, false)
  assert.equal((await api.post('/api/billing/invoice', { plan: 'pro' }, { headers: bearer('u_free') })).body.code, 'billing_off')
  const propId = (await api.get('/api/nfl/games/401873020')).body.props[0].id
  assert.equal((await api.post('/api/nfl/insight', { propId })).status, 401)
  const game = { homeTeam: 'Detroit Lions', awayTeam: 'Green Bay Packers', date: '2026-10-25' }
  // no pass: no AI, whether or not they redeemed an invite code (u_pro has one)
  for (const who of ['u_free', 'u_pro']) {
    const no = await api.post('/api/nfl/insight', { propId }, { headers: bearer(who) })
    assert.equal(no.status, 402, who)
    assert.equal(no.body.code, 'upgrade')
    assert.equal((await api.post('/api/chat/stream', { game }, { headers: bearer(who) })).status, 402)
    assert.equal((await api.post('/api/nfl/check', { text: 'anything over 1.5' }, { headers: bearer(who) })).status, 402)
    const me = await api.get('/api/billing/me', { headers: bearer(who) })
    assert.equal(me.body.ai.allowed, false)
    assert.equal(me.body.entitlement.plan, 'elite', 'everything else on the site stays open')
  }
  // a pass the admin gives (or a plan code) opens it, and the allowance counts
  await made.billing.grant({ uid: 'admin', admin: true }, { uid: 'u_pro', plan: 'pro', days: 30 })
  const ok = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('x-apex-usage'), '1/15', 'the daily allowance applies with passes off sale too')
  assert.equal((await api.get('/api/billing/me', { headers: bearer('u_pro') })).body.ai.allowed, true)
  assert.equal((await api.post('/api/chat/stream', { game }, { headers: bearer('u_pro') })).status, 200)
})

test('no paywall: every page gets the showcase', async () => {
  const p = await api.put('/api/picks/me', { handle: 'openuser', x: 'openuser' }, { headers: bearer('u_free') })
  assert.equal(p.body.profile.elite, true)
  assert.equal((await api.get('/api/picks/u/openuser')).body.profile.x, 'openuser')
})

test('sign-in-to-read mode: private caching and stream tickets', async () => {
  const restore = withEnv({ APEX_READS_NEED_AUTH: '1' })
  try {
    const anon = await api.get('/api/nfl/home')
    assert.equal(anon.status, 401)
    const r = await api.get('/api/nfl/home', { headers: bearer('u_free') })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('cache-control'), /^private/)
    assert.equal(r.headers.get('vary'), 'Authorization')
    assert.equal((await api.get('/api/nfl/stream?topics=scoreboard')).status, 401)
    const t = await api.get('/api/nfl/ticket', { headers: bearer('u_free') })
    assert.equal(t.body.required, true)
    const ctrl = new AbortController()
    const s = await fetch(`${api.base}/api/nfl/stream?topics=scoreboard&ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ctrl.signal })
    assert.equal(s.status, 200)
    ctrl.abort()
    const forged = await api.get(`/api/nfl/stream?topics=scoreboard&ticket=${encodeURIComponent(`${t.body.ticket.split('.')[0]}.AAAA`)}`)
    assert.equal(forged.status, 401)
  } finally {
    restore()
  }
  assert.equal((await api.get('/api/nfl/ticket')).body.required, false)
})

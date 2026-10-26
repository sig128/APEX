// Paywall off (no treasury yet): the original invite-code gate guards the AI, and an optional
// "sign in to read anything" mode with signed stream tickets.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createStore } from '../src/lib/store.js'
import { fixtureHttp } from './helpers.js'
import { clock, loadAll, testAuth, USERS, bearer, withEnv, serve } from './support.js'

const restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_AI_PROVIDER: null, APEX_TREASURY_ADDRESS: null, APEX_PAYWALL: 'off', APEX_READS_NEED_AUTH: null, APEX_AUTH: null, K_SERVICE: null, APEX_STREAM_SECRET: 's'.repeat(32), APEX_LOG_LEVEL: 'error' })

let api
let engine
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
  const made = createApexApp({ engineMode: 'lazy', http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS, { invited: ['u_pro'] }), anthropicKey: () => 'sk-test', oddsKey: () => null, now: clock() })
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

test('no paywall: passes are off sale, the invite rule guards the AI', async () => {
  const cfg = await api.get('/api/billing/config')
  assert.equal(cfg.body.paywall, false)
  assert.equal((await api.post('/api/billing/invoice', { plan: 'pro' }, { headers: bearer('u_free') })).body.code, 'billing_off')
  const propId = (await api.get('/api/nfl/games/401873020')).body.props[0].id
  assert.equal((await api.post('/api/nfl/insight', { propId })).status, 401)
  const noInvite = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_free') })
  assert.equal(noInvite.status, 403)
  assert.equal(noInvite.body.code, 'invite')
  const ok = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('x-apex-usage'), null, 'no allowance without a paywall')
  const game = { homeTeam: 'Detroit Lions', awayTeam: 'Green Bay Packers', date: '2026-10-25' }
  assert.equal((await api.post('/api/chat/stream', { game }, { headers: bearer('u_free') })).status, 403)
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

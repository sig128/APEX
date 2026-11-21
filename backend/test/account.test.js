// The iPhone app's server side: alerts through Apple's push service, the app's screens calling
// the API from capacitor://localhost, the app-link file, and deleting an account (the App Store
// requires it in the app; the website has it too).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { createApns, providerToken, cleanToken, apnsConfig } from '../src/push/apns.js'
import { createPush } from '../src/push/service.js'
import { fixtureHttp } from './helpers.js'
import { clock, loadAll, testAuth, USERS, bearer, withEnv, serve } from './support.js'

const DAY = 86_400_000
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' })
const TOKEN = 'ab'.repeat(32)
const cfg = { enabled: true, key: P8, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'com.proppickz.app' }

/** A stand-in for http2.connect: each request answers with the next scripted reply. */
function fakeApple(replies) {
  const seen = []
  const connect = (origin) => {
    const s = new EventEmitter()
    s.request = (headers) => {
      const req = new EventEmitter()
      req.setEncoding = () => {}
      req.end = (body) => {
        seen.push({ origin, headers, body: JSON.parse(body) })
        const [status, reason] = replies.shift() || [200, null]
        setImmediate(() => {
          req.emit('response', { ':status': status })
          if (reason) req.emit('data', JSON.stringify({ reason }))
          req.emit('end')
        })
      }
      return req
    }
    return s
  }
  return { connect, seen }
}

test('the provider token is ES256 over the team and time, and verifies with the key', () => {
  const t = Date.parse('2026-11-21T12:00:00Z')
  const tok = providerToken(cfg, t)
  const [h, c, sig] = tok.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' })
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { iss: 'TEAM123456', iat: t / 1000 })
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')))
  assert.equal(cleanToken(` ${TOKEN.toUpperCase()} `), TOKEN)
  assert.equal(cleanToken('xyz'), null)
  assert.equal(apnsConfig({}).enabled, false, 'off without the key')
  assert.equal(apnsConfig({ APNS_KEY: 'k', APNS_KEY_ID: 'i', APNS_TEAM_ID: 't' }).topic, 'com.proppickz.app')
})

test('sending: the alert, the topic and collapse id; a dead token; a sandbox build’s token', async () => {
  const apple = fakeApple([[200], [410, 'Unregistered'], [400, 'BadDeviceToken'], [200]])
  const apns = createApns({ config: () => cfg, connect: apple.connect, now: () => Date.parse('2026-11-21T12:00:00Z') })
  const ok = await apns.send(TOKEN, { title: 'Won', body: 'Your 3-leg parlay hit', url: '/me', tag: 'res-1' })
  assert.deepEqual([ok.ok, ok.gone, ok.env], [true, false, 'production'])
  const first = apple.seen[0]
  assert.equal(first.origin, 'https://api.push.apple.com')
  assert.equal(first.headers[':path'], `/3/device/${TOKEN}`)
  assert.equal(first.headers['apns-topic'], 'com.proppickz.app')
  assert.equal(first.headers['apns-push-type'], 'alert')
  assert.equal(first.headers['apns-collapse-id'], 'res-1')
  assert.match(first.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  assert.deepEqual(first.body, { aps: { alert: { title: 'Won', body: 'Your 3-leg parlay hit' }, sound: 'default', 'thread-id': 'res-1' }, url: '/me' })
  const gone = await apns.send(TOKEN, { title: 'x', body: 'y' })
  assert.deepEqual([gone.ok, gone.gone], [false, true])
  const sandbox = await apns.send(TOKEN, { title: 'x', body: 'y' })
  assert.deepEqual([sandbox.ok, sandbox.env], [true, 'sandbox'], 'refused by production, delivered by the sandbox')
  assert.equal(apple.seen.at(-1).origin, 'https://api.sandbox.push.apple.com')
})

test('the app’s devices sit with the browsers: same choices, dead ones dropped, sandbox remembered', async () => {
  const docs = createStoreDocs(createStore({ driver: 'memory' }))
  const sent = []
  const apnsReplies = [{ ok: true, env: 'sandbox' }, { ok: false, gone: true }]
  const apns = { enabled: () => true, send: async (token, msg, opts) => (sent.push({ token, msg, opts }), apnsReplies.shift()) }
  const push = createPush({ docs, apns, config: () => ({ enabled: false }), now: () => Date.parse('2026-11-21T12:00:00Z') })
  const user = { uid: 'u_app' }
  await assert.rejects(push.subscribeNative(user, { token: 'nope' }), (e) => e.code === 'bad_token')
  const st = await push.subscribeNative(user, { token: TOKEN, prefs: { results: true, injuries: false }, device: 'iPhone app' })
  assert.deepEqual([st.native, st.devices, st.prefs.injuries], [true, 1, false])
  assert.equal(await push.notify('u_app', 'injuries', { title: 'x', body: 'y' }), 0, 'they turned injury alerts off')
  assert.equal(await push.notify('u_app', 'results', { title: 'Won', body: 'hit', tag: 'r1' }), 1)
  assert.equal(sent[0].opts.env, 'production')
  assert.equal((await docs.get('pushSubs', 'u_app')).subs[0].env, 'sandbox', 'delivered by the sandbox: kept there')
  assert.equal(await push.notify('u_app', 'results', { title: 'Won', body: 'hit', tag: 'r2' }), 0)
  assert.equal(sent[1].opts.env, 'sandbox')
  assert.equal((await docs.get('pushSubs', 'u_app')).subs.length, 0, 'Apple said the token is gone')
  // the app can't sign up for alerts while the server has no push key
  const off = createPush({ docs, apns: { enabled: () => false, send: async () => ({}) }, config: () => ({ enabled: false }) })
  await assert.rejects(off.subscribeNative(user, { token: TOKEN }), (e) => e.code === 'push_off')
})

// ---- the app: CORS for the app's screens, the app-link file, deleting an account ------------
let api
let made
let docs
let now
let restoreEnv
const deletedSignIns = []
before(async () => {
  restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error', APEX_PAYWALL: 'auto', APEX_TREASURY_ADDRESS: '0x1111111111111111111111111111111111111111', APEX_EPHEMERAL: null, APNS_KEY: P8, APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456', APPLE_TEAM_ID: null })
  now = clock()
  const store = createStore({ driver: 'memory' })
  docs = createStoreDocs(store)
  const billing = createBilling({ docs, now })
  await docs.set('subscriptions', 'u_pro', { plan: 'pro', paidUntil: now() + 20 * DAY, source: 'usdc', email: 'pro@example.com', updatedAt: now() - DAY })
  const { http } = fixtureHttp()
  made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, oddsKey: () => null, now, deleteAuthUser: async (uid) => deletedSignIns.push(uid) })
  await loadAll(made.engine)
  api = await serve(made.app)
})
after(async () => {
  await api?.close()
  for (const e of Object.values(made?.engines || {})) e.stop()
  restoreEnv?.()
})

test('the app’s screens may call the API from inside the app; other sites still may not', async () => {
  const res = await api.raw('OPTIONS', '/api/nfl/status', { headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } })
  assert.equal(res.headers.get('access-control-allow-origin'), 'capacitor://localhost')
  const evil = await fetch(`${api.base}/api/nfl/status`, { headers: { origin: 'https://evil.example' } })
  assert.equal(evil.headers.get('access-control-allow-origin'), null)
  const cfgRes = await api.get('/api/push/config')
  assert.equal(cfgRes.body.native, true, 'the app can tell alerts are on')
})

test('the app-link file appears once the Apple team is known', async () => {
  const unset = withEnv({ APPLE_TEAM_ID: null, APNS_TEAM_ID: null })
  assert.equal((await api.get('/.well-known/apple-app-site-association')).status, 404)
  unset()
  const restore = withEnv({ APPLE_TEAM_ID: 'ABCDE12345' })
  try {
    const r = await api.get('/.well-known/apple-app-site-association')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.applinks.details[0].appIDs, ['ABCDE12345.com.proppickz.app'])
    assert.ok(r.body.applinks.details[0].components.some((c) => c['/'] === '/api/*' && c.exclude), 'the API stays on the web')
  } finally {
    restore()
  }
})

test('deleting an account: picks, page, handle, groups, alerts and limits go, then the sign-in', async () => {
  const props = (await api.get('/api/nfl/games/401873020')).body.props.filter((p) => p.kind === 'player' && !p.oneSided && p.posted === 'main')
  assert.equal((await api.put('/api/picks/me', { handle: 'pro_guy', name: 'Pro Guy' }, { headers: bearer('u_pro') })).status, 200)
  assert.equal((await api.put('/api/picks/me', { handle: 'free_gal', name: 'Free Gal' }, { headers: bearer('u_free') })).status, 200)
  const g = (await api.post('/api/picks/groups', { name: 'Sunday crew' }, { headers: bearer('u_pro') })).body.group
  assert.equal((await api.post('/api/picks/groups/join', { code: g.code }, { headers: bearer('u_free') })).status, 200)
  const posted = await api.post('/api/picks', { legs: [props[0].id, props[1].id], units: 1 }, { headers: bearer('u_free') })
  assert.equal(posted.status, 200, JSON.stringify(posted.body))
  assert.equal((await api.post('/api/push/native/subscribe', { token: TOKEN, device: 'iPhone app' }, { headers: bearer('u_free') })).status, 200)
  await docs.set('rg', 'u_free', { dailyUnits: 5 })
  assert.ok(await docs.get('pushSubs', 'u_free'))
  // the fair-play trail: when they posted, and the fingerprint of the network they posted from
  const trail = await docs.get('integrity', 'who-u_free')
  assert.ok(trail?.nets?.length, 'posting noted the network')
  const fp = trail.nets[0].fp
  assert.ok((await docs.get('integrity', `net-${fp}`)).seen.some((x) => x.uid === 'u_free'))

  // signed out, or without typing DELETE: nothing happens
  assert.equal((await api.post('/api/account/delete', { confirm: 'DELETE' })).status, 401)
  const noConfirm = await api.post('/api/account/delete', {}, { headers: bearer('u_free') })
  assert.deepEqual([noConfirm.status, noConfirm.body.code], [400, 'confirm'])
  assert.equal((await api.get('/api/picks/u/free_gal')).status, 200)

  const del = await api.post('/api/account/delete', { confirm: 'delete' }, { headers: bearer('u_free') })
  assert.equal(del.status, 200, JSON.stringify(del.body))
  assert.deepEqual([del.body.deleted.picks, del.body.deleted.page, del.body.deleted.groups], [1, true, 1])
  assert.deepEqual(deletedSignIns, ['u_free'], 'the sign-in itself goes last')
  // the page and its handle are gone, and the handle is free again
  assert.equal((await api.get('/api/picks/u/free_gal')).status, 404)
  assert.equal(await docs.get('profileHandles', 'free_gal'), null)
  assert.equal((await docs.recent('picks', { field: 'createdAt', where: [['uid', '==', 'u_free']] })).length, 0)
  assert.equal(await docs.get('pushSubs', 'u_free'), null)
  assert.ok(!((await docs.get('pushIndex', 'all'))?.uids || []).includes('u_free'))
  assert.equal(await docs.get('groupsOf', 'u_free'), null)
  assert.equal(await docs.get('rg', 'u_free'), null)
  assert.equal(await docs.get('integrity', 'who-u_free'), null, 'the fair-play trail goes')
  assert.ok(!((await docs.get('integrity', `net-${fp}`))?.seen || []).some((x) => x.uid === 'u_free'), 'and the network forgets them')
  // the group is still there for the person who started it, one member fewer
  const mine = await api.get('/api/picks/groups', { headers: bearer('u_pro') })
  assert.deepEqual([mine.body.groups.length, mine.body.groups[0].members], [1, 1])
  // other people's accounts are untouched
  assert.equal((await api.get('/api/picks/u/pro_guy')).status, 200)
  assert.ok(await docs.get('subscriptions', 'u_pro'))
})

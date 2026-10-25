// Invite and plan codes through the API: the same rules the Firebase callable used, now one
// implementation for both (and for Vercel, which has no callable).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createStore } from '../src/lib/store.js'
import { fakeFirestore } from './fakeFirestore.js'
import { fixtureHttp } from './helpers.js'
import { clock, testAuth, USERS, bearer, withEnv, serve, TREASURY } from './support.js'

const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, APEX_BILLING_STORE: 'firestore', K_SERVICE: null, APEX_LOG_LEVEL: 'error' })
let api
let bare
let made
let db
const now = clock()

before(async () => {
  db = fakeFirestore()
  const codes = db.collection('inviteCodes')
  await codes.doc('APEX-PLAIN-0001').set({ active: true })
  await codes.doc('APEX-ELITE-0001').set({ active: true, plan: 'elite', days: 30 })
  await codes.doc('APEX-ONCE-0001').set({ active: true, plan: 'pro', days: 7, usesRemaining: 1 })
  await codes.doc('APEX-OLD-0001').set({ active: true, plan: 'pro', days: 7, expiresAt: now() - 1000 })
  await codes.doc('APEX-OFF-0001').set({ active: false })
  made = createApexApp({ engineMode: 'lazy', http: fixtureHttp().http, store: createStore({ driver: 'memory' }), getFirestore: () => db, auth: testAuth(USERS), anthropicKey: () => null, oddsKey: () => null, now })
  api = await serve(made.app)
  const nodb = createApexApp({ engineMode: 'lazy', http: fixtureHttp().http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS), anthropicKey: () => null, oddsKey: () => null, now })
  bare = await serve(nodb.app)
  bare.engine = nodb.engine
})
after(async () => {
  await api?.close()
  await bare?.close()
  made?.engine.stop()
  bare?.engine?.stop()
  restoreEnv()
})

const redeem = (who, code, on = api) => on.post('/api/billing/redeem', { code }, { headers: who ? bearer(who) : {} })

test('codes need a sign-in and a database', async () => {
  assert.equal((await redeem(null, 'APEX-PLAIN-0001')).status, 401)
  const r = await redeem('u_free', 'APEX-PLAIN-0001', bare)
  assert.equal(r.status, 503)
  assert.equal(r.body.code, 'no_database')
  assert.equal((await redeem('u_free', 'not a code!')).status, 400)
})

test('a plain code unlocks the AI; a plan code adds the pass; each once per person', async () => {
  const plain = await redeem('u_free', 'apex-plain-0001')
  assert.equal(plain.status, 200, JSON.stringify(plain.body))
  assert.equal(plain.body.plan, null)
  assert.ok((await db.collection('users').doc('u_free').get()).data().inviteVerifiedAt, 'unlocked')
  const elite = await redeem('u_free', 'APEX-ELITE-0001')
  assert.equal(elite.status, 200)
  assert.equal(elite.body.plan, 'elite')
  assert.equal(elite.body.entitlement.plan, 'elite')
  const me = await api.get('/api/billing/me', { headers: bearer('u_free') })
  assert.equal(me.body.entitlement.plan, 'elite', 'the pass shows up right away')
  const again = await redeem('u_free', 'APEX-ELITE-0001')
  assert.equal(again.status, 409)
  // one use left on this one: the first person takes it
  assert.equal((await redeem('u_pro', 'APEX-ONCE-0001')).status, 200)
  const gone = await redeem('u_elite', 'APEX-ONCE-0001')
  assert.equal(gone.status, 404)
})

test('every kind of miss gets the same answer, and tries are limited', async () => {
  const msgs = new Set()
  for (const code of ['APEX-NOPE-0001', 'APEX-OLD-0001', 'APEX-OFF-0001']) {
    const r = await redeem('u_elite', code)
    assert.equal(r.status, 404, code)
    msgs.add(r.body.error)
  }
  assert.equal(msgs.size, 1, 'unknown, expired and switched-off codes look the same')
  // u_elite has used 4 of 8 tries (the sold-out code counted too)
  for (let i = 0; i < 4; i++) assert.equal((await redeem('u_elite', `APEX-GUESS-${1000 + i}`)).status, 404)
  const locked = await redeem('u_elite', 'APEX-PLAIN-0001')
  assert.equal(locked.status, 429, 'even a good code waits out the hour')
  now.add(61 * 60_000)
  assert.equal((await redeem('u_elite', 'APEX-PLAIN-0001')).status, 200, 'the window rolls')
})

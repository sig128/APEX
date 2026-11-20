// The consent screen's record, the onboarding tour's counts, and feedback to the team's inbox.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { createMembers, CONSENT_VERSION, clip } from '../src/members/service.js'
import { createMailer, mailConfig, feedbackEmail } from '../src/members/mail.js'
import { fixtureHttp } from './helpers.js'
import { clock, testAuth, USERS, bearer, withEnv, serve } from './support.js'

const KEY = 'test-admin-key-0123456789abcdef'
const restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_PAYWALL: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error', ADMIN_SPORTS_KEY: KEY, RESEND_API_KEY: null, SENDGRID_API_KEY: null, POSTMARK_SERVER_TOKEN: null, FEEDBACK_TO: null })
let api
let made
let store
let now
const DEVICE = 'dev_0123456789abcdef'
const uid = Object.values(USERS)[0].uid

before(async () => {
  now = clock(Date.parse('2026-11-20T20:00:00Z'))
  store = createStore({ driver: 'memory' })
  const billing = createBilling({ docs: createStoreDocs(store), now })
  const { http } = fixtureHttp()
  made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, oddsKey: () => null, now })
  api = await serve(made.app)
})
after(async () => {
  await api?.close()
  for (const e of Object.values(made?.engines || {})) e.stop()
  restoreEnv()
})

test('consent: kept per device and per account, only for the current text, only when agreed', async () => {
  assert.equal((await api.post('/api/members/consent', { device: DEVICE, version: CONSENT_VERSION, app: 'abc1234' })).status, 400, 'no tick, no record')
  assert.equal((await api.post('/api/members/consent', { agree: true, device: DEVICE, version: '2020-01-01' })).status, 409, 'an older text asks for a reload')
  assert.equal((await api.post('/api/members/consent', { agree: true, device: 'x', version: CONSENT_VERSION })).status, 400)
  const ok = await api.post('/api/members/consent', { agree: true, device: DEVICE, version: CONSENT_VERSION, app: 'abc1234' })
  assert.equal(ok.status, 200)
  const doc = await store.get('members', `consent-d-${DEVICE}`)
  assert.deepEqual(Object.keys(doc.accepted), [CONSENT_VERSION])
  assert.equal(doc.accepted[CONSENT_VERSION].app, 'abc1234')
  assert.equal(doc.uid, undefined, 'signed out: no account on it')
  // signing in later ties the same device's acceptance to the account
  assert.equal((await api.get('/api/members/consent', { headers: bearer(uid) })).body.accepted, false)
  await api.post('/api/members/consent', { agree: true, device: DEVICE, version: CONSENT_VERSION, app: 'abc1234' }, { headers: bearer(uid) })
  assert.equal((await store.get('members', `consent-d-${DEVICE}`)).uid, uid)
  assert.equal((await api.get('/api/members/consent', { headers: bearer(uid) })).body.accepted, true)
})

test('tour: counts starts, finishes and where people skip', async () => {
  for (const b of [{ action: 'start' }, { action: 'step', step: 0 }, { action: 'step', step: 1 }, { action: 'skip', step: 1 }, { action: 'start' }, { action: 'done' }]) assert.equal((await api.post('/api/members/tour', b)).status, 200)
  assert.equal((await api.post('/api/members/tour', { action: 'nope' })).status, 400)
  const d = await store.get('members', 'tour-2026-11-20')
  assert.deepEqual([d.start, d.done, d.skip[1], d.reached[0], d.reached[1]], [2, 1, 1, 1, 1])
})

test('feedback: kept, account only when asked, a hidden field and a rate limit keep scripts out', async () => {
  assert.equal((await api.post('/api/members/feedback', { kind: 'bug', message: '' })).status, 400)
  const one = await api.post('/api/members/feedback', { kind: 'bug', message: 'The slip button did nothing on my phone', rating: 2, page: '/nfl', app: 'abc1234', include: true }, { headers: { ...bearer(uid), 'user-agent': 'iPhone test' } })
  assert.equal(one.status, 200)
  const two = await api.post('/api/members/feedback', { kind: 'feature', message: 'Add NHL lineups', include: false }, { headers: bearer(uid) })
  assert.equal(two.status, 200)
  const bot = await api.post('/api/members/feedback', { kind: 'general', message: 'buy now', website: 'http://spam.example' })
  assert.equal(bot.status, 200, 'the bot hears thanks')
  const tap = await api.post('/api/members/feedback', { kind: 'pick', helpful: false, about: 'nfl:123.recYds.o.55.5' })
  assert.equal(tap.status, 200, 'a "was this helpful?" tap needs no words')
  const idx = await store.get('members', 'fb-index')
  assert.equal(idx.ids.length, 3, 'the bot left nothing behind')
  const first = await store.get('members', `fb-${one.body.id}`)
  assert.equal(first.user.uid, uid)
  assert.equal(first.device, 'iPhone test')
  assert.equal(first.rating, 2)
  assert.equal((await store.get('members', `fb-${two.body.id}`)).user, null, 'not shared unless they tick the box')
  // a few notes a minute at most
  let last
  for (let i = 0; i < 6; i++) last = await api.post('/api/members/feedback', { kind: 'general', message: `note ${i}` })
  assert.equal(last.status, 429)
  // the admin reads them, newest first
  const login = await api.post('/api/admin/login', { password: KEY })
  const cookie = String(login.headers.get('set-cookie')).split(';')[0]
  const list = await api.get('/api/admin/feedback', { headers: { cookie } })
  assert.equal(list.status, 200)
  assert.ok(list.body.items.length >= 3)
  assert.equal(list.body.items.at(-1).message, 'The slip button did nothing on my phone')
  assert.equal((await api.get('/api/admin/feedback')).status, 401, 'not without the password')
})

test('feedback mail: the configured service gets it, a failure keeps the note', async () => {
  assert.equal(mailConfig({}).ready, false)
  assert.equal(createMailer({ env: {} }), null, 'no service, no mail')
  const sent = []
  const fetchImpl = async (url, init) => {
    sent.push({ url, init })
    return { ok: sent.length === 1, status: sent.length === 1 ? 200 : 500 }
  }
  const mail = createMailer({ env: { RESEND_API_KEY: 'k', FEEDBACK_TO: 'team@example.com' }, fetchImpl })
  const st = createStore({ driver: 'memory' })
  const m = createMembers({ store: st, mail, now: () => Date.parse('2026-11-20T20:00:00Z') })
  const a = await m.feedback({ kind: 'bug', message: 'Broken button', include: true, user: { uid: 'u1', email: 'me@example.com' } })
  assert.equal(sent[0].url, 'https://api.resend.com/emails')
  const body = JSON.parse(sent[0].init.body)
  assert.deepEqual(body.to, ['team@example.com'])
  assert.equal(body.reply_to, 'me@example.com')
  assert.match(body.subject, /^\[PropPickz feedback\] Bug: Broken button/)
  assert.equal((await st.get('members', `fb-${a.id}`)).mailed, true)
  const b = await m.feedback({ kind: 'general', message: 'Second note' })
  assert.equal((await st.get('members', `fb-${b.id}`)).mailed, false, 'kept even when the mail fails')
  const e = feedbackEmail({ id: 'x', at: 0, kind: 'pick', message: 'Line was stale', rating: null, about: 'nfl:1', page: '/nfl', app: 'v', device: 'd', user: null })
  assert.match(e.text, /Account: not shared/)
  assert.equal(clip('a\u0000b\u0007c ', 10), 'abc')
})

test('Smart Check counts: what was shown and what happened next, per day', async () => {
  const { createMembers } = await import('../src/members/service.js')
  const { createStore } = await import('../src/lib/store.js')
  const store = createStore({ driver: 'memory' })
  const m = createMembers({ store, now: () => Date.parse('2026-11-20T20:00:00Z') })
  await m.nudges({ types: ['weak', 'legs', 'nope'], action: 'shown' })
  await m.nudges({ types: ['weak'], action: 'removed' })
  await assert.rejects(m.nudges({ types: ['weak'], action: 'stole' }))
  const [d] = await m.nudgeStats(1)
  assert.deepEqual(d.types.weak, { shown: 1, dismissed: 0, muted: 0, removed: 1 })
  assert.equal(d.types.nope, undefined, 'unknown types are dropped')
})

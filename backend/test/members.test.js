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
const restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_PAYWALL: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error', ADMIN_SPORTS_KEY: KEY, RESEND_API_KEY: null, SENDGRID_API_KEY: null, POSTMARK_SERVER_TOKEN: null, FEEDBACK_TO: null, APEX_TRUST_PROXY: '1' })
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

test('feedback screenshots: kept apart from the note, checked, and opened from the admin inbox', async () => {
  const st = createStore({ driver: 'memory' })
  const m = createMembers({ store: st, now: () => Date.parse('2026-11-20T20:00:00Z') })
  // a 1x1 PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  const a = await m.feedback({ kind: 'bug', message: 'The slip overlaps the footer', shot: { type: 'image/png', data: `data:image/png;base64,${png}` } })
  const note = await st.get('members', `fb-${a.id}`)
  assert.equal(note.shot, true)
  assert.equal(note.data, undefined, 'the picture isn’t in the note itself')
  assert.deepEqual(await m.feedbackShot(a.id), { type: 'image/png', data: png, at: Date.parse('2026-11-20T20:00:00Z') })
  assert.equal(await m.feedbackShot('../etc'), null)
  await assert.rejects(m.feedback({ kind: 'bug', message: 'x y z', shot: { type: 'image/gif', data: png } }), (e) => e.code === 'bad_shot')
  await assert.rejects(m.feedback({ kind: 'bug', message: 'x y z', shot: { type: 'image/png', data: 'not base64!' } }), (e) => e.code === 'bad_shot')
  await assert.rejects(m.feedback({ kind: 'bug', message: 'x y z', shot: { type: 'image/jpeg', data: 'A'.repeat(700_004) } }), (e) => e.code === 'shot_too_big')
  const tap = await m.feedback({ kind: 'pick', helpful: true, shot: { type: 'image/png', data: png } })
  assert.equal((await st.get('members', `fb-${tap.id}`)).shot, false, 'a helpful tap carries no picture')
  assert.match(feedbackEmail({ ...note }).text, /Screenshot: attached, on the admin page/)
  // through the app: posted with a note, opened by the admin with the password
  now.add(5 * 60_000)
  // (from another address: the earlier test used up this one's notes for the minute)
  const sent = await api.post('/api/members/feedback', { kind: 'bug', message: 'Here is what I see', shot: { type: 'image/png', data: png } }, { headers: { 'x-forwarded-for': '203.0.113.50' } })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  const login = await api.post('/api/admin/login', { password: KEY })
  const cookie = String(login.headers.get('set-cookie')).split(';')[0]
  const pic = await api.get(`/api/admin/feedback/${sent.body.id}/shot`, { headers: { cookie } })
  assert.equal(pic.status, 200)
  assert.equal(pic.body.data, png)
  assert.equal((await api.get(`/api/admin/feedback/${sent.body.id}/shot`)).status, 401)
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

test('setup: leagues, odds format, where they bet and books, kept with the account and checked', async () => {
  // signed out there's nothing to read or save
  assert.equal((await api.get('/api/members/prefs')).status, 401)
  assert.equal((await api.post('/api/members/prefs', { odds: 'decimal' })).status, 401)
  const h = { headers: bearer(uid) }
  assert.deepEqual((await api.get('/api/members/prefs', h)).body, { leagues: [], odds: 'american', region: null, books: [], onboarded: null, at: null })
  // a step at a time: each answer saves on its own, the rest stays
  assert.deepEqual((await api.post('/api/members/prefs', { leagues: ['nba', 'nfl', 'nba'] }, h)).body.leagues, ['nba', 'nfl'])
  assert.equal((await api.post('/api/members/prefs', { odds: 'decimal', region: 'CA-ON' }, h)).body.region, 'CA-ON')
  const done = await api.post('/api/members/prefs', { books: ['fanduel', 'espnbet'], done: true }, h)
  assert.deepEqual(done.body.leagues, ['nba', 'nfl'])
  assert.equal(done.body.odds, 'decimal')
  assert.deepEqual(done.body.books, ['fanduel', 'espnbet'])
  assert.equal(done.body.onboarded, now())
  // running the setup again later keeps the first finish
  const first = now()
  now.add(60_000)
  assert.equal((await api.post('/api/members/prefs', { region: 'US-NY', done: true }, h)).body.onboarded, first)
  // anything off the lists is turned away, and nothing of it is saved
  for (const b of [{ leagues: ['xfl'] }, { leagues: 'nfl' }, { odds: 'fractional' }, { region: 'US-ZZ' }, { region: 'Norway' }, { books: ['pinnacle'] }]) {
    assert.equal((await api.post('/api/members/prefs', b, h)).status, 400, JSON.stringify(b))
  }
  const kept = (await api.get('/api/members/prefs', h)).body
  assert.equal(kept.odds, 'decimal')
  assert.equal(kept.region, 'US-NY')
  // deleting the account deletes the setup
  const own = createStore({ driver: 'memory' })
  const m = createMembers({ store: own })
  await m.setPrefs('u1', { odds: 'decimal', done: true })
  await m.eraseUser('u1')
  assert.equal((await own.get('members', 'prefs-u-u1')) ?? null, null)
  assert.equal((await m.prefsOf('u1')).onboarded, null)
})

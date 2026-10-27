// The admin page's API: behind the admin password only, and the numbers add up from what the site keeps:
// sign-ins, picks pages, passes, payments, posted picks (the admin's own apart), the 3-Leg
// Lock, and the board's graded days by series and segment. The daily cron is locked when
// CRON_SECRET is set.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { fixtureHttp } from './helpers.js'
import { clock, testAuth, USERS, bearer, withEnv, serve } from './support.js'
import { COLS } from '../src/nfl/proplog.js'
import { daysBetween } from '../src/admin/metrics.js'

const KEY = 'test-admin-key-0123456789abcdef'
const restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_ADMIN_EMAILS: 'boss@example.com', APEX_ADMIN_UIDS: null, APEX_PAYWALL: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error', CRON_SECRET: 'cron-secret-for-tests', ADMIN_SPORTS_KEY: KEY })
const C = Object.fromEntries(COLS.map((k, i) => [k, i]))
const DAY = 86_400_000
let api
let now
let made
let store
let adm // the cookie a right password gets

before(async () => {
  now = clock(Date.parse('2026-10-28T15:00:00Z'))
  store = createStore({ driver: 'memory' })
  const docs = createStoreDocs(store)
  const billing = createBilling({ docs, now })
  const t = now()
  const signIns = [
    { uid: 'u_admin', email: 'boss@example.com', name: 'Boss', created: t - 40 * DAY, lastSeen: t - 3600_000 },
    { uid: 'u_pro', email: 'pro@example.com', name: 'Pro Bettor', created: t - 5 * DAY, lastSeen: t - 2 * DAY },
    { uid: 'u_free', email: 'free@example.com', name: 'Free Fan', created: t - DAY, lastSeen: t - 20 * DAY },
  ]
  // a picks page, a paid pass, a comp, a payment, and picks (the admin's two among them)
  await docs.set('profiles', 'u_admin', { uid: 'u_admin', handle: 'boss', name: 'Boss', createdAt: t - 30 * DAY, stats: null })
  await docs.set('profiles', 'u_pro', { uid: 'u_pro', handle: 'sharp', name: 'Pro Bettor', createdAt: t - 4 * DAY, stats: null })
  await docs.set('subscriptions', 'u_pro', { plan: 'pro', paidUntil: t + 20 * DAY, source: 'usdc', email: 'pro@example.com', updatedAt: t - 10 * DAY })
  await docs.set('subscriptions', 'u_free', { plan: 'elite', paidUntil: t + 5 * DAY, source: 'admin', email: 'free@example.com', updatedAt: t - DAY })
  await docs.set('billingPayments', 'inv_1', { invoiceId: 'inv_1', uid: 'u_pro', email: 'pro@example.com', plan: 'pro', usd: 29, units: '29000017', txHash: '0xabc', network: 'base', createdAt: t - 10 * DAY })
  const pick = (id, uid, day, result, profit) => docs.set('picks', id, { id, uid, handle: uid, createdAt: Date.parse(`${day}T12:00:00Z`), lockAt: Date.parse(`${day}T23:00:00Z`), status: result ? 'graded' : 'open', result, units: 1, profit, price: -110, legs: [{ name: 'A. One', label: 'Over 2.5 Shots on Goal', sport: 'nhl', result }] })
  await pick('p1', 'u_admin', '2026-10-26', 'win', 0.91)
  await pick('p2', 'u_admin', '2026-10-27', 'loss', -1)
  await pick('p3', 'u_pro', '2026-10-27', 'win', 0.91)
  await pick('p4', 'u_pro', '2026-10-28', null, null)
  // two graded NHL days on the board's record, and one day's raw rows for the drill-down
  const acc = (n, w, l, p, u, r) => [n, w, l, p, u, r, r, 0.6 * (w + l), 0.52 * (w + l), w + l, 0, 0]
  await store.set('propsum-nhl', '2026-10', {
    days: {
      '2026-10-26': { rows: 40, voids: 2, all: acc(30, 18, 11, 1, 3.4, 30), top: acc(10, 7, 3, 0, 2.9, 10), edge: acc(6, 4, 2, 0, 1.6, 6), seg: { 'm:sog': acc(12, 8, 4, 0, 2.5, 12), 's:u': acc(10, 4, 6, 0, -2.4, 10) } },
      '2026-10-27': { rows: 36, voids: 0, all: acc(25, 12, 13, 0, -2.1, 25), top: acc(10, 6, 4, 0, 0.9, 10), edge: acc(5, 3, 2, 0, 0.7, 5), seg: { 'm:sog': acc(10, 6, 4, 0, 1.2, 10) } },
      '2026-09-01': { rows: 10, voids: 0, all: acc(9, 1, 8, 0, -7, 9), top: acc(9, 1, 8, 0, -7, 9), edge: acc(0, 0, 0, 0, 0, 0), seg: {} },
    },
  })
  await store.set('proplog-nhl', 'index', { all: ['2026-10-27'], open: [] })
  const row = Array(COLS.length).fill(null)
  Object.assign(row, { [C.id]: '101.sog.o.2.5', [C.game]: 'g1', [C.p]: 0.62, [C.price]: 120, [C.best]: 125, [C.book]: 'fanduel', [C.edge]: 0.05, [C.score]: 88, [C.res]: 'w', [C.val]: 4 })
  await store.set('proplog-nhl', '2026-10-27', { v: 1, sport: 'nhl', day: '2026-10-27', done: true, games: { g1: { k: Date.parse('2026-10-27T23:00:00Z'), n: 'AAA @ BBB' } }, pl: { 101: ['A. One', 'AAA', 'BBB', 'F'] }, rows: { 'g1:101:sog': row } })
  await store.set('locks-nhl', 'index', ['2026-10-27'])
  await store.set('locks-nhl', '2026-10-27', { key: '2026-10-27', status: 'graded', result: 'win', profit: 3.1, units: 2, lock: { price: 155, legs: [{ name: 'A. One', label: 'Over 2.5 Shots on Goal', kickoff: Date.parse('2026-10-27T23:00:00Z'), result: 'win' }] } })

  const { http } = fixtureHttp()
  made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, oddsKey: () => null, listUsers: async () => signIns, now })
  api = await serve(made.app)
  const login = await api.post('/api/admin/login', { password: KEY })
  adm = { cookie: String(login.headers.get('set-cookie')).split(';')[0] }
})

after(async () => {
  await api?.close()
  for (const e of Object.values(made?.engines || {})) e.stop()
  restoreEnv()
})

test('only the admin password opens it, not a Google account', async () => {
  assert.equal((await api.get('/api/admin/overview')).status, 401)
  const google = await api.get('/api/admin/overview', { headers: bearer('u_admin') })
  assert.equal(google.status, 401, 'an admin Google account alone is not enough')
  assert.equal(google.body.code, 'admin_password')
  const r = await api.get('/api/admin/overview', { headers: adm })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal((await api.get('/api/admin/overview', { headers: { 'x-apex-admin-key': KEY } })).status, 200, 'scripts can send the key itself')
})

test('the password: a signed HttpOnly cookie for the admin API only, and nothing for a wrong one', async () => {
  assert.deepEqual((await api.get('/api/admin/session')).body, { configured: true, open: false, until: null })
  const wrong = await api.post('/api/admin/login', { password: 'not-the-password-at-all-nope' })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.body.code, 'admin_password_wrong')
  assert.equal(wrong.headers.get('set-cookie'), null)
  const right = await api.post('/api/admin/login', { password: `  ${KEY}  ` })
  assert.equal(right.status, 200)
  const c = right.headers.get('set-cookie')
  assert.match(c, /^propify_admin=[\w-]+\.[\w-]+;/)
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/api/admin', 'Max-Age=604800']) assert.ok(c.includes(part), part)
  assert.ok(!c.includes(KEY), 'the password itself never goes in the cookie')
  const s = await api.get('/api/admin/session', { headers: { cookie: c.split(';')[0] } })
  assert.equal(s.body.open, true)
  // a forged or edited cookie is refused
  const [body, sig] = c.split(';')[0].slice('propify_admin='.length).split('.')
  const forged = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: 9e15 })).toString('base64url')
  assert.equal((await api.get('/api/admin/overview', { headers: { cookie: `propify_admin=${forged}.${sig}` } })).status, 401)
  assert.equal((await api.get('/api/admin/overview', { headers: { cookie: `propify_admin=${body}.${sig.slice(0, -2)}xx` } })).status, 401)
  const out = await api.post('/api/admin/logout', {}, { headers: adm })
  assert.match(out.headers.get('set-cookie'), /^propify_admin=;.*Max-Age=0/)
})

test('the tools work under the password and nowhere else', async () => {
  assert.equal((await api.post('/api/admin/grant', { uid: 'u_pro', plan: 'elite', days: 7 }, { headers: bearer('u_admin') })).status, 401)
  const g = await api.post('/api/admin/grant', { uid: 'u_pro', plan: 'elite', days: 7, note: 'test' }, { headers: adm })
  assert.equal(g.status, 200)
  assert.equal(g.body.subscription.grantedBy, 'admin')
  const rv = await api.post('/api/admin/revoke', { uid: 'u_pro' }, { headers: adm })
  assert.equal(rv.body.revoked, true)
  assert.equal((await api.post('/api/admin/hide', { handle: 'nobody-here', hidden: true }, { headers: adm })).status, 404)
})

test('members, passes and money', async () => {
  const { body } = await api.get('/api/admin/overview', { headers: adm })
  const u = body.users
  assert.equal(u.source, 'auth')
  assert.equal(u.total, 3)
  assert.equal(u.new7, 2)
  assert.equal(u.active7, 2)
  assert.equal(u.pages, 2)
  assert.deepEqual(u.plans, { free: 1, pro: 1, elite: 1 })
  assert.equal(u.paid, 1, 'paid in USDC')
  assert.equal(u.comps, 1, 'given by an admin')
  const pro = u.list.find((m) => m.uid === 'u_pro')
  assert.equal(pro.handle, 'sharp')
  assert.equal(pro.plan, 'pro')
  assert.equal(pro.email, 'pro@example.com')
  assert.equal(u.list[0].uid, 'u_free', 'newest first')
  assert.equal(body.money.total, 29)
  assert.equal(body.money.count, 1)
  assert.equal(body.money.recent[0].plan, 'pro')
})

test('posted picks: everyone’s by game day, and the admin’s own apart', async () => {
  const { body } = await api.get('/api/admin/overview', { headers: adm })
  const p = body.picks
  assert.equal(p.posted, 4)
  assert.equal(p.open, 1)
  assert.deepEqual(p.mine['2026-10-26'], { n: 1, w: 1, l: 0, p: 0, u: 0.91, risked: 1 })
  assert.deepEqual(p.mine['2026-10-27'], { n: 1, w: 0, l: 1, p: 0, u: -1, risked: 1 })
  assert.equal(p.crowd['2026-10-27'].n, 2)
  assert.equal(p.myPicks.length, 2)
  assert.equal(body.locks[0].sport, 'nhl')
  assert.equal(body.locks[0].day, '2026-10-27')
  assert.equal(body.locks[0].profit, 3.1)
})

test('the board’s record: days in range, series, segments by league, and the drill-down', async () => {
  const { body } = await api.get('/api/admin/overview?from=2026-10-01&to=2026-10-31', { headers: adm })
  const m = body.model
  assert.deepEqual(Object.keys(m.days).sort(), ['2026-10-26', '2026-10-27'], 'only days in the range')
  const nhl = m.leagues.nhl
  assert.equal(nhl.days, 2)
  assert.deepEqual(nhl.all.slice(0, 4), [55, 30, 24, 1])
  assert.equal(Math.round(nhl.all[4] * 10) / 10, 1.3)
  assert.deepEqual(m.seg['m:sog'].slice(0, 3), [22, 14, 8])
  assert.deepEqual(m.seg['lg:nhl'].slice(0, 2), [55, 30])
  assert.ok(m.status.nhl, 'each league says how its log is doing')
  const wide = await api.get('/api/admin/overview?from=2026-09-01&to=2026-10-31&sport=nhl', { headers: adm })
  assert.equal(wide.body.model.leagues.nhl.days, 3)
  // a month for the calendar: only the board, no members or money
  const month = await api.get('/api/admin/overview?from=2026-10-27&to=2026-10-31&parts=board', { headers: adm })
  assert.equal(month.status, 200)
  assert.equal(month.body.model.leagues.nhl.days, 1)
  assert.equal(month.body.users, undefined)
  assert.equal(month.body.money, undefined)
  assert.equal(month.body.labels.m.hPts, 'Points (hockey)', 'two sports never share a market name')
  assert.equal((await api.get('/api/admin/overview?parts=board', { headers: bearer('u_pro') })).status, 401)
  assert.equal((await api.get('/api/admin/overview?from=2026-10-31&to=2026-10-01', { headers: adm })).status, 400)

  const d = await api.get('/api/admin/day?sport=nhl&day=2026-10-27', { headers: adm })
  assert.equal(d.status, 200)
  assert.equal(d.body.rows[0].name, 'A. One')
  assert.equal(d.body.rows[0].res, 'w')
  assert.equal(d.body.rows[0].best, 125)
  assert.equal((await api.get('/api/admin/day?sport=nhl&day=2026-10-01', { headers: adm })).status, 404)
  assert.equal((await api.get('/api/admin/day?sport=xyz&day=2026-10-27', { headers: adm })).status, 400)
  assert.equal((await api.get('/api/admin/day?sport=nhl&day=2026-10-27', { headers: bearer('u_admin') })).status, 401)
})

test('the daily run is locked to the cron when CRON_SECRET is set', async () => {
  assert.equal((await api.get('/api/cron/daily')).status, 401)
  assert.equal((await api.get('/api/cron/daily', { headers: { authorization: 'Bearer nope' } })).status, 401)
  assert.equal(daysBetween('2026-10-30', '2026-11-02').length, 4)
})

test('guessing gets locked out for a while, from one address and from everywhere', async () => {
  await store.del('admin-lock', 'all')
  for (let i = 0; i < 8; i++) assert.equal((await api.post('/api/admin/login', { password: `guess-number-${i}-xxxxxxxxxxxx` })).status, 401)
  const locked = await api.post('/api/admin/login', { password: KEY })
  assert.equal(locked.status, 429, 'even the right password waits out the lock')
  assert.equal(locked.body.code, 'admin_locked')
  assert.ok(Number(locked.headers.get('retry-after')) > 0)
  assert.equal((await api.get('/api/admin/overview', { headers: adm })).status, 200, 'a session already open keeps working')
})

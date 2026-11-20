// Push notifications: subscriptions per device, the kinds each person chose, a daily cap and a gap
// per pick, dead subscriptions dropped, and ticker alerts only for members at their threshold.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import webpush from 'web-push'
import { createPush, tickerAlertable } from '../src/push/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { ApiError } from '../src/lib/router.js'
import { clock } from './support.js'

const keys = webpush.generateVAPIDKeys()
const config = () => ({ enabled: true, publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:test@example.com' })
const sub = (n) => ({ endpoint: `https://push.example.com/send/abcdefghij${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } })
const alice = { uid: 'alice' }
const bob = { uid: 'bob' }

function setup() {
  const now = clock(Date.parse('2026-11-20T18:00:00Z'))
  const sent = []
  const gone = new Set()
  const sender = async (s, payload) => {
    if (gone.has(s.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 })
    sent.push({ to: s.endpoint, ...payload })
  }
  const docs = createStoreDocs(createStore({ driver: 'memory' }))
  const push = createPush({ docs, now, sender, config, isMember: async (uid) => uid === 'alice' })
  return { push, sent, gone, now, docs }
}

test('subscribing: a valid browser subscription, per device, with choices', async () => {
  const { push } = setup()
  await assert.rejects(push.subscribe(alice, { subscription: { endpoint: 'http://nope' } }), (e) => e instanceof ApiError && e.code === 'bad_subscription')
  await assert.rejects(push.subscribe(null, { subscription: sub(1) }), (e) => e.code === 'signin')
  const s = await push.subscribe(alice, { subscription: sub(1), device: 'Mac, Chrome' })
  assert.deepEqual([s.enabled, s.devices, s.prefs.ticker], [true, 1, 'big'])
  await push.subscribe(alice, { subscription: sub(2) })
  await push.subscribe(alice, { subscription: sub(2) })
  assert.equal((await push.status(alice)).devices, 2, 'the same device once')
  const p = await push.setPrefs(alice, { results: false, ticker: 'risk', junk: 1 })
  assert.deepEqual(p.prefs, { results: false, injuries: true, ticker: 'risk' })
})

test('sending: only what they chose, a daily cap, a gap per pick, dead devices dropped', async () => {
  const { push, sent, gone, now } = setup()
  await push.subscribe(alice, { subscription: sub(1) })
  await push.subscribe(alice, { subscription: sub(2) })
  assert.equal(await push.notify('alice', 'results', { title: 'Your pick won', body: '+2u', tag: 'result-p1' }), 2, 'both devices')
  assert.equal(await push.notify('alice', 'results', { title: 'again', body: '', tag: 'result-p1' }), 0, 'the same pick within 30 minutes')
  gone.add(sub(1).endpoint)
  now.add(31 * 60_000)
  assert.equal(await push.notify('alice', 'injuries', { title: 'X: Out', body: 'On your pick', tag: 'inj-1' }), 1)
  assert.equal((await push.status(alice)).devices, 1, 'the dead subscription is gone')
  await push.setPrefs(alice, { injuries: false })
  assert.equal(await push.notify('alice', 'injuries', { title: 'Y', body: '', tag: 'inj-2' }), 0, 'turned off')
  for (let i = 0; i < 20; i++) await push.notify('alice', 'results', { title: `r${i}`, body: '', tag: `r-${i}` })
  assert.ok(sent.length <= 12 + 1, `capped: ${sent.length}`)
  assert.equal(await push.notify('nobody', 'results', { title: 'x', body: '' }), 0)
})

test('ticker alerts: members only, at their threshold', async () => {
  assert.equal(tickerAlertable('big', { status: 'moved' }, { kind: 'line', size: 0.5 }), false)
  assert.equal(tickerAlertable('big', { status: 'moved' }, { kind: 'line', size: 1 }), true)
  assert.equal(tickerAlertable('risk', { status: 'risk' }, { kind: 'injury' }), true)
  assert.equal(tickerAlertable('all', { status: 'valid' }, { kind: 'post' }), false)
  const { push, sent } = setup()
  await push.subscribe(alice, { subscription: sub(1) })
  await push.subscribe(bob, { subscription: sub(3) })
  const item = { key: 'k1', id: '1.recYds.o.62.5', short: 'W. Smith', shortLabel: 'O 62.5 Rec Yds', status: 'moved' }
  const n = await push.tickerEvents('nfl', [{ item, ev: { kind: 'line', size: 1.5, text: 'Line 62.5 → 64' } }, { item, ev: { kind: 'price', size: 5, text: 'Over −110 → −115' } }])
  assert.equal(n, 1, 'one alert, to the member, for the big move only')
  assert.deepEqual([sent[0].to, sent[0].title, sent[0].body, sent[0].url], [sub(1).endpoint, 'W. Smith O 62.5 Rec Yds', 'Line 62.5 → 64', '/nfl/prop/1.recYds.o.62.5'])
})

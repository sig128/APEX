// The movement ticker: posted picks are followed from the first look; line, price, injury and
// lineup news become ticker lines and a status; the close is kept at kickoff with its closing line
// value; members get it live and on the stream, free visitors a snapshot at least 30 minutes old.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fullEngine, clock, testAuth, USERS, bearer, withEnv, serve } from './support.js'
import { fixtureHttp } from './helpers.js'
import { createStore } from '../src/lib/store.js'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { assess, changes, clvOf, directionOf, centsBetween, DELAY_MS } from '../src/nfl/ticker.js'

const MIN = 60_000

test('statuses, directions, closing line value and ticker lines', () => {
  const P = { side: 'o', line: 24.5, price: -110, inj: null }
  const base = { line: 24.5, price: -110, prob: 0.58, flipped: false, inPicks: true, inj: null, boost: null, state: 'pre', voidGame: false }
  assert.equal(assess(P, base).status, 'valid')
  assert.equal(assess(P, { ...base, line: 25.5 }).status, 'moved')
  assert.equal(assess(P, { ...base, price: -135 }).status, 'moved', 'a real price move')
  assert.equal(assess(P, { ...base, price: -112 }).status, 'valid', 'a cent or two is noise')
  assert.equal(assess(P, { ...base, inj: 'questionable' }).status, 'risk', 'newly questionable')
  assert.equal(assess({ ...P, inj: 'questionable' }, { ...base, inj: 'questionable' }).status, 'valid', 'already questionable when it was posted')
  assert.equal(assess(P, { ...base, inj: 'doubtful' }).status, 'risk')
  assert.equal(assess(P, { ...base, inj: 'out' }).status, 'void')
  assert.equal(assess(P, { ...base, voidGame: true }).status, 'void')
  assert.equal(assess(P, { ...base, flipped: true }).status, 'risk')
  assert.equal(assess(P, { ...base, prob: 0.47 }).status, 'risk')
  assert.equal(assess(P, { ...base, line: null }).status, 'risk', 'pulled at the book')
  assert.equal(assess(P, { ...base, state: 'in' }).status, 'live')
  // toward the pick is up
  assert.equal(directionOf(P, 25.5, -110), 'up', 'over: the line went up')
  assert.equal(directionOf({ ...P, side: 'u' }, 25.5, -110), 'down')
  assert.equal(directionOf(P, 24.5, -130), 'up', 'same line, dearer: the market agrees')
  assert.equal(directionOf(P, 24.5, 100), 'down')
  assert.equal(directionOf(P, 24.5, -110), null)
  assert.deepEqual(clvOf(P, { line: 26.5, price: -110 }), { kind: 'line', value: 2 })
  assert.deepEqual(clvOf({ ...P, side: 'u' }, { line: 26.5, price: -110 }), { kind: 'line', value: -2 })
  const c = clvOf(P, { line: 24.5, price: -130 })
  assert.equal(c.kind, 'price')
  assert.ok(c.value > 0.03)
  const ev = changes(P, base, { ...base, line: 25.5, inj: 'questionable', injText: 'Ankle', boost: 'J. Doe' }, 1000)
  assert.deepEqual(ev.map((e) => e.kind), ['line', 'injury', 'lineup'])
  assert.equal(ev[0].text, 'Line 24.5 → 25.5')
  assert.equal(ev[0].dir, 'up')
  assert.equal(ev[1].text, 'Questionable: Ankle')
  assert.equal(ev[2].text, 'Teammate out: J. Doe')
  assert.equal(changes(P, base, { ...base, price: -112 }, 1000).length, 0, 'noise is not news')
  assert.equal(changes(P, base, { ...base, price: -130 }, 1000)[0].text, 'Over −110 → −130')
  assert.equal(changes(P, base, { ...base, price: -130 }, 1000)[0].size, 20, 'a 20-cent move')
  assert.equal(ev[0].size, 1, 'a one-point move')
  assert.equal(centsBetween(105, -110), 15)
  assert.equal(centsBetween(-110, -130), 20)
})

let engine
after(() => engine?.stop())

test('following posted picks: a line move, injury news, the close and its value, the delayed copy', async () => {
  const now = clock()
  const store = createStore({ driver: 'memory' })
  engine = await fullEngine({ now, store })
  const tk = engine.ticker
  const first = await tk.tick()
  assert.ok(first.picks >= 10, `${first.picks} picks followed`)
  let live = await tk.live()
  assert.equal(live.live, true)
  assert.ok(live.items.length >= 10)
  assert.ok(live.items.every((i) => i.events[0].kind === 'post' && i.events[0].text.startsWith('Posted: ')))
  assert.ok(live.items.filter((i) => i.status === 'valid').length >= live.items.length - 2, 'fresh picks are still valid')
  const lock = engine.views.lock().lock
  if (lock) assert.ok(lock.legs.every((l) => live.items.some((i) => i.lock && i.id === l.id)), 'the lock’s legs are followed too')
  // nothing old enough to show a free visitor yet
  const early = await tk.delayed()
  assert.equal(early.locked, true)
  assert.equal(early.items.length, 0)
  assert.equal(early.count, live.items.length)

  // the book moves one over up a point
  const it = live.items.find((x) => !x.lock && x.side === 'o' && !x.key.startsWith('t') && x.posted.line >= 2)
  const [pid, market] = it.key.split('.')
  const lines = engine.wh.lines.get(it.gameId).props
  const l = lines.find((x) => String(x.athleteId) === pid && x.market === market)
  l.line = it.posted.line + 1
  now.add(MIN)
  engine.wh.bump('lines')
  engine.wh.at.lines = now()
  await tk.tick()
  live = await tk.live()
  const moved = live.items.find((x) => x.key === it.key)
  assert.equal(moved.now.line, it.posted.line + 1)
  assert.equal(moved.moved.line, 1)
  assert.equal(moved.dir, 'up', 'an over whose line went up: the market moved toward it')
  assert.ok(['moved', 'risk'].includes(moved.status), moved.status)
  assert.ok(moved.events.some((e) => e.text === `Line ${it.posted.line} → ${it.posted.line + 1}`), JSON.stringify(moved.events))
  assert.equal(live.items[0].at >= moved.at, true, 'newest first')

  // injury news on another pick's player
  const hurt = live.items.find((x) => x.key !== it.key && x.gameId !== it.gameId && !x.key.startsWith('t') && !x.posted.inj)
  const hp = engine.wh.players.get(hurt.key.split('.')[0])
  const list = engine.wh.injuries.get(hp.teamId) || []
  engine.wh.injuries.set(hp.teamId, [...list, { athleteId: hp.id, status: 'Questionable', detail: 'Ankle' }])
  now.add(MIN)
  engine.wh.bump('injuries')
  engine.wh.at.lines = now()
  await tk.tick()
  const h = (await tk.live()).items.find((x) => x.key === hurt.key)
  assert.equal(h.status, 'risk')
  assert.equal(h.now.inj, 'questionable')
  assert.ok(h.events.some((e) => e.kind === 'injury' && e.text === 'Questionable: Ankle'), JSON.stringify(h.events))

  // kickoff: the pick closes at the last line seen, a point past where it was posted
  const g = engine.wh.games.get(it.gameId)
  now.set(Date.parse(g.date) + MIN)
  g.status = { ...g.status, state: 'in' }
  engine.wh.bump('live')
  await tk.tick()
  const closed = (await tk.live()).items.find((x) => x.key === it.key)
  assert.equal(closed.status, 'live')
  assert.deepEqual(closed.clv, { kind: 'line', value: 1 })
  assert.equal(closed.close.line, it.posted.line + 1)
  assert.match(closed.events[0].text, /beat the close by 1$/)

  // a free visitor now sees the first snapshot (more than 30 minutes old), as it was then
  const free = await tk.delayed()
  assert.ok(free.items.length > 0)
  assert.ok(now() - free.at >= DELAY_MS)
  assert.ok(free.items.every((i) => i.status === 'valid' || i.status === 'risk'), 'as things stood then')
  assert.ok(free.items.every((i) => !('close' in i) && !('clv' in i) && i.events.length <= 1), 'the trimmed copy')
})

// ---- who gets what -------------------------------------------------------------------------------
let api
let made
let restoreEnv
before(async () => {
  restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error', APEX_PAYWALL: 'auto', APEX_TREASURY_ADDRESS: '0x1111111111111111111111111111111111111111', APEX_EPHEMERAL: null, APEX_READS_NEED_AUTH: null })
  const now = clock()
  const store = createStore({ driver: 'memory' })
  const docs = createStoreDocs(store)
  const billing = createBilling({ docs, now })
  await docs.set('subscriptions', 'u_pro', { plan: 'pro', paidUntil: now() + 20 * 86_400_000, source: 'usdc', email: 'pro@example.com', updatedAt: now() })
  const { http } = fixtureHttp()
  made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, oddsKey: () => null, now })
  api = await serve(made.app)
})
after(async () => {
  await api?.close()
  for (const e of Object.values(made?.engines || {})) e.stop()
  restoreEnv?.()
})

test('members get the live ticker and its stream; everyone else the delayed copy', async () => {
  // warm the board so there's something to follow
  await api.get('/api/nfl/home')
  const anon = await api.get('/api/nfl/ticker')
  assert.equal(anon.status, 200)
  assert.equal(anon.body.locked, true)
  assert.equal(anon.body.live, false)
  assert.match(anon.headers.get('cache-control'), /private/)
  assert.equal(anon.headers.get('vary'), 'Authorization')
  const free = await api.get('/api/nfl/ticker', { headers: bearer('u_free') })
  assert.equal(free.body.locked, true, 'signed in on the free plan: still delayed')
  const pro = await api.get('/api/nfl/ticker', { headers: bearer('u_pro') })
  assert.equal(pro.body.locked, false)
  assert.equal(pro.body.live, true)
  assert.ok(Array.isArray(pro.body.items))

  // live signals: the record is public, the notes are for members
  const sAnon = await api.get('/api/nfl/signals')
  assert.equal(sAnon.body.locked, true)
  assert.ok(sAnon.body.record && 'rate' in sAnon.body.record)
  assert.equal(sAnon.body.live, undefined)
  const sPro = await api.get('/api/nfl/signals', { headers: bearer('u_pro') })
  assert.equal(sPro.body.locked, false)
  assert.ok(Array.isArray(sPro.body.live))
  // the stream: no ticker without a member's ticket
  const noTicket = await api.get('/api/nfl/stream?topics=ticker')
  assert.equal(noTicket.status, 204, 'a visitor asking only for the ticker gets nothing')
  const freeTicket = (await api.get('/api/nfl/ticket', { headers: bearer('u_free') })).body
  assert.equal(freeTicket.paid, false)
  const stillNo = await api.get(`/api/nfl/stream?topics=ticker&ticket=${encodeURIComponent(freeTicket.ticket)}`)
  assert.equal(stillNo.status, 204, 'a free plan’s ticket doesn’t open it')
  const forged = await api.get(`/api/nfl/stream?topics=ticker&ticket=${encodeURIComponent(freeTicket.ticket.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))}`)
  assert.equal(forged.status, 204, 'a tampered ticket is no ticket')
  const t = (await api.get('/api/nfl/ticket', { headers: bearer('u_pro') })).body
  assert.equal(t.paid, true)
  assert.ok(t.ticket)
  const ctrl = new AbortController()
  const res = await fetch(`${api.base}/api/nfl/stream?topics=scoreboard,ticker&ticket=${encodeURIComponent(t.ticket)}`, { signal: ctrl.signal })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  let buf = ''
  while (!buf.includes('event: hello')) buf += new TextDecoder().decode((await reader.read()).value)
  assert.match(buf, /"topics":\["scoreboard","ticker"\]/)
  ctrl.abort()
  const anonStream = new AbortController()
  const res2 = await fetch(`${api.base}/api/nfl/stream?topics=scoreboard,ticker`, { signal: anonStream.signal })
  const r2 = res2.body.getReader()
  let b2 = ''
  while (!b2.includes('event: hello')) b2 += new TextDecoder().decode((await r2.read()).value)
  assert.match(b2, /"topics":\["scoreboard"\]/, 'the ticker is dropped for a visitor; the rest still flows')
  anonStream.abort()
})

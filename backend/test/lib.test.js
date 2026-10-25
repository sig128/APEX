import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { num, round, median, mapLimit, hash, nameKey, shortName } from '../src/lib/util.js'
import { americanToProb, probToAmerican, americanToDecimal, decimalToAmerican, noVig, formatAmerican } from '../src/lib/odds.js'
import { wilsonLower, normalCdf, normalOver, poissonAtLeast, poissonPmf, quantile, ewma } from '../src/lib/stats.js'
import { createCache } from '../src/lib/cache.js'
import { createStore } from '../src/lib/store.js'
import { createHub } from '../src/lib/hub.js'
import { createRouter, ApiError, clientIp } from '../src/lib/router.js'
import { createLimiter } from '../src/security/rateLimit.js'
import { signTicket, verifyTicket } from '../src/security/ticket.js'
import { checkAdminKey, keyMatches, _resetAdminKeyFails } from '../src/security/adminKey.js'
import { createHttp, HttpError, createFixtureTransport, fixtureKey } from '../src/lib/http.js'
import { withEnv } from './support.js'

test('num parses what ESPN sends', () => {
  assert.equal(num('1,204'), 1204)
  assert.equal(num('+124'), 124)
  assert.equal(num('-148'), -148)
  assert.equal(num('12.5'), 12.5)
  assert.equal(num('3-7'), 3)
  assert.equal(num('--'), null)
  assert.equal(num(''), null)
  assert.equal(num('abc'), null)
  assert.equal(num(NaN), null)
  assert.equal(num(7), 7)
})

test('small helpers', async () => {
  assert.equal(round(1.23456, 2), 1.23)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(median([]), null)
  assert.equal(nameKey('A.J. Brown Jr.'), nameKey('AJ Brown'))
  assert.equal(shortName('Amon-Ra St. Brown'), 'A. St. Brown')
  assert.equal(hash('x'), hash('x'))
  assert.notEqual(hash('x'), hash('y'))
  let running = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    return x * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12])
  assert.ok(peak <= 2)
})

test('odds conversions are consistent', () => {
  assert.equal(probToAmerican(0.5), 100)
  assert.equal(probToAmerican(0.6), -150)
  assert.equal(probToAmerican(0.4), 150)
  assert.ok(Math.abs(americanToProb(-150) - 0.6) < 1e-9)
  assert.ok(Math.abs(americanToProb(150) - 0.4) < 1e-9)
  assert.equal(americanToProb(50), null)
  assert.equal(americanToDecimal(-110).toFixed(4), '1.9091')
  assert.equal(americanToDecimal(250), 3.5)
  assert.equal(decimalToAmerican(3.5), 250)
  assert.equal(decimalToAmerican(1.5), -200)
  assert.equal(decimalToAmerican(1), null)
  const [a, b] = noVig(-110, -110)
  assert.ok(Math.abs(a - 0.5) < 1e-9 && Math.abs(b - 0.5) < 1e-9)
  assert.equal(formatAmerican(120), '+120')
  assert.equal(formatAmerican(-120), '-120')
  for (const p of [0.12, 0.33, 0.5, 0.51, 0.77, 0.93]) assert.ok(Math.abs(americanToProb(probToAmerican(p)) - p) < 0.01, `round trip ${p}`)
})

test('stats', () => {
  assert.equal(wilsonLower(0, 0), 0)
  assert.ok(wilsonLower(10, 10) < 1 && wilsonLower(10, 10) > 0.8)
  assert.ok(wilsonLower(5, 5) < wilsonLower(20, 20), 'more games, more trust')
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7)
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3)
  assert.ok(Math.abs(normalOver(250, 50, 250) - 0.5) < 1e-6)
  assert.ok(normalOver(300, 50, 250) > 0.8)
  const tot = Array.from({ length: 40 }, (_, k) => poissonPmf(2.3, k)).reduce((s, x) => s + x, 0)
  assert.ok(Math.abs(tot - 1) < 1e-9)
  assert.ok(Math.abs(poissonAtLeast(0.7, 1) - (1 - Math.exp(-0.7))) < 1e-9)
  assert.equal(poissonAtLeast(1, 0), 1)
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3)
  assert.ok(ewma([10, 10, 10, 30]) > 10)
})

test('cache: fresh, stale-while-revalidate, single flight', async () => {
  const c = createCache()
  let calls = 0
  const fn = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return calls
  }
  const [a, b] = await Promise.all([c.wrap('k', { ttlMs: 30, staleMs: 1000 }, fn), c.wrap('k', { ttlMs: 30, staleMs: 1000 }, fn)])
  assert.equal(a, 1)
  assert.equal(b, 1)
  assert.equal(calls, 1)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(await c.wrap('k', { ttlMs: 30, staleMs: 1000 }, fn), 1, 'stale value comes back right away')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(await c.wrap('k', { ttlMs: 30, staleMs: 1000 }, fn), 2, 'background refresh landed')
  const failing = createCache()
  failing.set('x', 'old', 1, 0)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(await failing.wrap('x', { ttlMs: 10 }, async () => { throw new Error('down') }), 'old', 'an expired value beats an error')
  await assert.rejects(failing.wrap('never', { ttlMs: 10 }, async () => { throw new Error('down') }))
})

test('memory store: atomic update and keys', async () => {
  const s = createStore({ driver: 'memory' })
  await Promise.all(Array.from({ length: 50 }, () => s.update('ns', 'n', (cur) => (cur || 0) + 1)))
  assert.equal(await s.get('ns', 'n'), 50)
  await s.set('ns', 'other', { a: 1 })
  assert.deepEqual((await s.keys('ns')).sort(), ['n', 'other'])
  await s.del('ns', 'other')
  assert.equal(await s.get('ns', 'other'), undefined)
})

test('disk store survives a new instance', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-store-'))
  const a = createStore({ driver: 'disk', dir })
  await a.set('nfl', 'core', { week: 7 })
  await a.update('nfl', 'count', (n) => (n || 0) + 2)
  const b = createStore({ driver: 'disk', dir })
  assert.deepEqual(await b.get('nfl', 'core'), { week: 7 })
  assert.equal(await b.get('nfl', 'count'), 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('rate limiter refills over time', async () => {
  const l = createLimiter({ burst: 2, perSec: 20 })
  assert.ok(l.take('a').ok)
  assert.ok(l.take('a').ok)
  const no = l.take('a')
  assert.equal(no.ok, false)
  assert.ok(no.retryAfter >= 1)
  assert.ok(l.take('b').ok, 'buckets are per key')
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(l.take('a').ok)
})

test('stream tickets: signed, expiring, tamper-proof', () => {
  const restore = withEnv({ APEX_STREAM_SECRET: 'x'.repeat(32) })
  const t = signTicket({ uid: 'u1' })
  assert.equal(verifyTicket(t).uid, 'u1')
  const [body, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ uid: 'admin', exp: Date.now() + 1e6 })).toString('base64url')
  assert.equal(verifyTicket(`${forged}.${sig}`), null)
  assert.equal(verifyTicket(`${body}.AAAA`), null)
  assert.equal(verifyTicket(signTicket({ uid: 'u1' }, -1000)), null, 'expired')
  assert.equal(verifyTicket('junk'), null)
  restore()
})

test('admin key: constant-time match, short keys refused, lockout after 10 misses', () => {
  _resetAdminKeyFails()
  assert.equal(keyMatches('abc', 'abc'), true)
  assert.equal(keyMatches('abc', 'abd'), false)
  const req = (key, ip = '9.9.9.9') => ({ headers: { 'x-apex-admin-key': key }, socket: { remoteAddress: ip } })
  assert.equal(checkAdminKey({ headers: {} }, 'a-long-admin-key-123'), 'none')
  assert.equal(checkAdminKey(req('short'), 'short'), 'bad', 'keys under 12 chars never work')
  assert.equal(checkAdminKey(req('a-long-admin-key-123'), 'a-long-admin-key-123'), 'ok')
  for (let i = 0; i < 9; i++) assert.equal(checkAdminKey(req('wrong-guess-000000'), 'a-long-admin-key-123'), 'bad')
  assert.equal(checkAdminKey(req('wrong-guess-000000'), 'a-long-admin-key-123'), 'bad')
  assert.equal(checkAdminKey(req('a-long-admin-key-123'), 'a-long-admin-key-123'), 'blocked', 'even the right key waits out the lockout')
  assert.equal(checkAdminKey(req('a-long-admin-key-123', '8.8.8.8'), 'a-long-admin-key-123'), 'ok', 'other addresses are fine')
  _resetAdminKeyFails()
})

test('client ip: forwarded headers only count behind a trusted proxy', () => {
  const req = { headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }
  let restore = withEnv({ K_SERVICE: null, APEX_TRUST_PROXY: null, APEX_TRUSTED_HOPS: null })
  assert.equal(clientIp(req), '127.0.0.1')
  restore()
  restore = withEnv({ APEX_TRUST_PROXY: '1', APEX_TRUSTED_HOPS: null })
  assert.equal(clientIp(req), '10.0.0.1')
  restore()
  restore = withEnv({ APEX_TRUST_PROXY: '1', APEX_TRUSTED_HOPS: '2' })
  assert.equal(clientIp(req), '1.2.3.4')
  restore()
})

test('router: params, ETag 304, cache headers, errors as JSON', async () => {
  const r = createRouter()
  r.get('/things/:id', { cache: { maxAge: 10, sMaxAge: 20, swr: 30 } }, (ctx) => ({ id: ctx.params.id }))
  r.get('/boom', () => {
    throw new Error('kaboom')
  })
  r.get('/nope', () => {
    throw new ApiError(429, 'rate', 'Slow down', { retryAfter: 7 })
  })
  const server = http.createServer((req, res) => r.handle(req, res))
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${server.address().port}`
  const a = await fetch(`${base}/things/42`)
  assert.equal(a.status, 200)
  assert.deepEqual(await a.json(), { id: '42' })
  assert.equal(a.headers.get('cache-control'), 'public, max-age=10, s-maxage=20, stale-while-revalidate=30')
  const etag = a.headers.get('etag')
  const b = await fetch(`${base}/things/42`, { headers: { 'if-none-match': etag } })
  assert.equal(b.status, 304)
  const c = await fetch(`${base}/boom`)
  assert.equal(c.status, 500)
  assert.equal((await c.json()).code, 'internal')
  assert.equal(c.headers.get('cache-control'), 'no-store')
  const d = await fetch(`${base}/nope`)
  assert.equal(d.status, 429)
  assert.equal(d.headers.get('retry-after'), '7')
  const e = await fetch(`${base}/missing`)
  assert.equal(e.status, 404)
  server.close()
})

test('hub: hello, initial data, publish, cleanup on close', async () => {
  const hub = createHub({ heartbeatMs: 50 })
  const server = http.createServer((req, res) => hub.stream(req, res, { list: ['scoreboard', 'game:1'], initial: (t) => (t === 'scoreboard' ? { n: 1 } : null) }))
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const ctrl = new AbortController()
  const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: ctrl.signal })
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = res.body.getReader()
  let buf = ''
  const until = async (needle) => {
    while (!buf.includes(needle)) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
    }
    return buf.includes(needle)
  }
  assert.ok(await until('event: hello'))
  assert.ok(await until('"data":{"n":1}'))
  assert.equal(hub.publish('game:1', 'update', { score: 7 }), 1)
  assert.ok(await until('"score":7'))
  assert.ok(await until(': ping'))
  ctrl.abort()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(hub.hasSubscribers('game:1'), false)
  assert.equal(hub.publish('game:1', 'update', {}), 0)
  server.close()
})

test('http: retries, circuit breaker, fixture transport', async () => {
  let n = 0
  const flaky = async () => {
    n++
    if (n < 3) return { ok: false, status: 503, headers: new Headers(), text: async () => '' }
    return { ok: true, status: 200, headers: new Headers(), text: async () => '{"ok":true}' }
  }
  const h = createHttp({ transport: flaky })
  const out = await h.getJson('https://site.api.espn.com/x', { retries: 2 })
  assert.deepEqual(out, { ok: true })
  assert.equal(n, 3)
  const down = createHttp({ transport: async () => ({ ok: false, status: 500, headers: new Headers(), text: async () => '' }), breakerFailures: 2, breakerCooldownMs: 60_000 })
  await assert.rejects(down.getJson('https://a.example.com/1', { retries: 0 }), HttpError)
  await assert.rejects(down.getJson('https://a.example.com/2', { retries: 0 }), HttpError)
  await assert.rejects(down.getJson('https://a.example.com/3', { retries: 0 }), /open|breaker|cool/i)
  const ft = createFixtureTransport({ [fixtureKey('https://x.example.com/a?b=1&lang=en')]: { hi: 1 } })
  const fh = createHttp({ transport: ft })
  assert.deepEqual(await fh.getJson('https://x.example.com/a?lang=en&region=us&b=1'), { hi: 1 })
  await assert.rejects(fh.getJson('https://x.example.com/missing', { retries: 0 }))
  assert.ok(ft.misses.size >= 1)
})

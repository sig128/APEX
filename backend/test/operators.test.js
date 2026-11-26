// The setup's list of betting apps and their App Store icons, kept current once a day.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPERATOR_APPS, OPERATOR_KEYS } from '../src/members/operators.js'
import { createOperatorIcons, iconFrom, lookups } from '../src/members/operatorIcons.js'
import { PREF_BOOKS, cleanPrefs } from '../src/members/prefs.js'
import { createApexApp } from '../app.js'
import { createStore } from '../src/lib/store.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { fixtureKey } from '../src/lib/http.js'
import { fixtureHttp } from './helpers.js'
import { clock, testAuth, USERS, withEnv, serve } from './support.js'

const art = (id) => `https://is2-ssl.mzstatic.com/image/thumb/Purple221/v4/aa/bb/cc/${id}/AppIcon-0-0-1x_U007emarketing-0-11-0-85-220.png/512x512bb.jpg`
/** What Apple's lookup answers for one country's list: every app, each with its icon. */
const answer = (list) => ({ resultCount: list.length, results: list.map(([, id]) => ({ trackId: Number(id), artworkUrl512: art(id), artworkUrl100: art(id).replace('512x512', '100x100') })) })

test('the website and the server list the same operators, and a member can pick any of them', async () => {
  const { OPERATOR_KEYS: shown } = await import('../../frontend/src/lib/operators.js')
  assert.deepEqual([...shown].sort(), [...OPERATOR_KEYS].sort())
  assert.equal(PREF_BOOKS, OPERATOR_KEYS)
  // the books we have prices for lead the list, under the keys the slip uses
  assert.deepEqual(OPERATOR_KEYS.slice(0, 8), ['fanduel', 'draftkings', 'betmgm', 'williamhill_us', 'bet365', 'fanatics', 'betrivers', 'espnbet'])
  for (const ref of Object.values(OPERATOR_APPS)) assert.match(ref, /^(us|ca|gb):\d{6,12}$/)
  assert.deepEqual(cleanPrefs({ books: ['kalshi', 'proline', 'prizepicks', 'kalshi'] }).books, ['kalshi', 'proline', 'prizepicks'])
  assert.throws(() => cleanPrefs({ books: ['pinnacle'] }), /isn’t on the list/)
})

test('icons: Apple’s image servers only, at the size the tiles use', () => {
  assert.equal(iconFrom(art('x1')), art('x1').replace('512x512bb.jpg', '180x180bb.jpg'))
  for (const bad of [null, '', 'http://is1-ssl.mzstatic.com/image/thumb/a/b.png/512x512bb.jpg', 'https://evil.example/image/thumb/a/b.png/512x512bb.jpg', 'https://is1-ssl.mzstatic.com.evil.example/image/thumb/a/b.png/512x512bb.jpg', 'https://is1-ssl.mzstatic.com/other/a.png']) {
    assert.equal(iconFrom(bad), null, String(bad))
  }
  // one lookup per store country, every app in one of them
  const all = lookups()
  assert.deepEqual(all.map(([c]) => c).sort(), ['ca', 'gb', 'us'])
  assert.equal(all.reduce((n, [, , list]) => n + list.length, 0), OPERATOR_KEYS.length)
})

test('icons: looked up once a day and kept, and what we had stays when Apple doesn’t answer', async () => {
  const now = clock(Date.parse('2026-11-26T12:00:00Z'))
  const calls = []
  let down = false
  const http = {
    async getJson(url) {
      calls.push(url)
      if (down) throw Object.assign(new Error('HTTP 503'), { status: 503 })
      const hit = lookups().find(([, u]) => u === url)
      return answer(hit ? hit[2] : [])
    },
  }
  const store = createStore({ driver: 'memory' })
  const icons = createOperatorIcons({ http, store, now })
  const [a, b] = await Promise.all([icons.get(), icons.get()])
  assert.equal(calls.length, 3, 'one lookup per country, shared by callers at the same moment')
  assert.equal(a, b)
  assert.equal(Object.keys(a.icons).length, OPERATOR_KEYS.length)
  assert.equal(a.icons.fanduel, iconFrom(art('1413721906')))
  assert.equal(a.icons.proline, iconFrom(art('6756412017')))
  // the same day: no lookups; a new server instance reads them from the store
  now.add(3 * 3600_000)
  await icons.get()
  await createOperatorIcons({ http, store, now }).get()
  assert.equal(calls.length, 3)
  // a day on, Apple is down: the icons we had stay, and the next try is an hour away
  now.add(22 * 3600_000)
  down = true
  const kept = await createOperatorIcons({ http, store, now }).get()
  assert.equal(kept.icons.fanduel, a.icons.fanduel)
  const tried = calls.length
  const fresh = createOperatorIcons({ http, store: null, now })
  assert.deepEqual((await fresh.get()).icons, {}, 'nothing kept and no answer: the shipped icons are used')
  now.add(30 * 60_000)
  await fresh.get()
  assert.equal(calls.length, tried + 3, 'no second try within the hour')
  now.add(31 * 60_000)
  down = false
  assert.equal((await fresh.get()).icons.kalshi, iconFrom(art('1632713844')))
})

test('GET /api/operators/icons: the current icons, for anyone, cached', async () => {
  const restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_PAYWALL: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'error' })
  const extra = Object.fromEntries(lookups().map(([, url, list]) => [fixtureKey(url), answer(list)]))
  const { http } = fixtureHttp(extra)
  const now = clock(Date.parse('2026-11-26T12:00:00Z'))
  const store = createStore({ driver: 'memory' })
  const billing = createBilling({ docs: createStoreDocs(store), now })
  const made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing, oddsKey: () => null, now })
  const api = await serve(made.app)
  try {
    const r = await api.get('/api/operators/icons')
    assert.equal(r.status, 200)
    assert.equal(r.body.icons.draftkings, iconFrom(art('1375031369')))
    assert.match(r.headers.get('cache-control'), /public, max-age=3600/)
  } finally {
    await api.close()
    for (const e of Object.values(made.engines || {})) e.stop()
    restoreEnv()
  }
})

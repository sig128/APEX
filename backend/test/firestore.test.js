// The production storage paths (Firestore) on an in-memory Firestore: billing, picks, the
// engine snapshot (split across part documents when big), and the indexes those queries need.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeFirestore } from './fakeFirestore.js'
import { createStore } from '../src/lib/store.js'
import { createFirestoreDocs, createDocs } from '../src/billing/docs.js'
import { createBilling } from '../src/billing/service.js'
import { createPicks } from '../src/picks/service.js'
import { fullEngine, clock, fakeChain, withEnv, TREASURY, txHash } from './support.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, APEX_BILLING_STORE: null, K_SERVICE: null, APEX_LOG_LEVEL: 'error' })
after(() => restoreEnv())

test('store driver: small and split values, keys, delete, update', async () => {
  const db = fakeFirestore()
  const s = createStore({ driver: 'firestore', getFirestore: () => db })
  await s.set('nfl', 'small', { a: 1 })
  assert.deepEqual(await s.get('nfl', 'small'), { a: 1 })
  const big = { rows: Array.from({ length: 30_000 }, (_, i) => ({ i, name: `Player ${i} Ñandú`, v: [1, 2, 3] })) }
  assert.ok(JSON.stringify(big).length > 1_048_576, 'bigger than one Firestore document')
  await s.set('nfl', 'core', big)
  assert.deepEqual(await s.get('nfl', 'core'), big)
  const parts1 = [...db._cols.get('apexStore').keys()].filter((k) => k.includes('__p')).length
  assert.ok(parts1 >= 2)
  await s.set('nfl', 'core', { ...big, again: true })
  assert.equal((await s.get('nfl', 'core')).again, true)
  assert.equal([...db._cols.get('apexStore').keys()].filter((k) => k.includes('__p')).length, parts1, 'old parts are cleaned up')
  assert.deepEqual((await s.keys('nfl')).sort(), ['core', 'small'], 'part documents are not keys')
  await s.update('odds', 'spend', (n) => (n || 0) + 5)
  await s.update('odds', 'spend', (n) => n + 5)
  assert.equal(await s.get('odds', 'spend'), 10)
  await s.del('nfl', 'core')
  assert.equal(await s.get('nfl', 'core'), undefined)
  assert.equal([...db._cols.get('apexStore').keys()].filter((k) => k.includes('__p')).length, 0)
})

test('the engine snapshot round-trips through Firestore', async () => {
  const db = fakeFirestore()
  const store = createStore({ driver: 'firestore', getFirestore: () => db })
  const a = await fullEngine({ store })
  await a.persist(true)
  a.stop()
  const { createEngine } = await import('../src/nfl/engine.js')
  const { fixtureHttp } = await import('./helpers.js')
  const b = createEngine({ mode: 'lazy', http: fixtureHttp().http, store, now: clock() })
  await b.ensureStarted()
  assert.equal(b.wh.games.size, a.wh.games.size)
  assert.equal(b.wh.logs.size, a.wh.logs.size)
  assert.equal(b.views.allRows().rows.length, a.views.allRows().rows.length, 'a cold instance serves the same board')
  b.stop()
})

test('billing and picks on Firestore, and every query has its index', async () => {
  const db = fakeFirestore()
  const now = clock()
  const restore = withEnv({ APEX_BILLING_STORE: 'firestore' })
  const docs = createDocs({ getFirestore: () => db, store: null })
  restore()
  assert.equal(docs.kind, 'firestore')
  const chain = fakeChain()
  const billing = createBilling({ docs, chainFor: () => chain, now })
  const user = { uid: 'fs_user', email: 'fs@example.com', name: 'Fire Store' }
  const inv = await billing.createInvoice(user, 'elite')
  chain.send(txHash(77), { to: TREASURY, amount: inv.units, timestamp: now() })
  assert.equal((await billing.confirm(user, inv.id, txHash(77))).status, 'paid')
  assert.equal((await billing.entitlement(user)).plan, 'elite')
  await billing.useQuota(user, { plan: 'elite', status: 'active' }, 'aiReads')
  await billing.grant({ uid: 'boss', admin: true }, { email: 'fs@example.com', plan: 'elite', days: 3 })
  assert.ok((await billing.payments({ admin: true })).length === 1)
  assert.ok((await billing.subscriptions({ admin: true })).length >= 1)

  const engine = await fullEngine({ now })
  const picks = createPicks({ docs, engine, billing, now })
  await picks.saveProfile(user, { handle: 'fire_store', x: 'firestore' })
  const ids = engine.views.game('401873020').props.slice(0, 2).map((p) => p.id)
  await picks.post(user, { legs: ids })
  assert.equal((await picks.page('fire_store')).open.length, 1)
  now.add(25_000)
  assert.equal((await picks.feed()).picks.length, 1)
  await picks.leaderboard({ range: '30d' })
  await picks.leaderboard({ range: 'all' })
  now.set(Date.parse(engine.wh.games.get('401873020').date) + 3600_000)
  await picks.gradeOpen()
  engine.stop()

  const declared = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'firestore.indexes.json'), 'utf8')).indexes.map((i) => `${i.collectionGroup}:${i.fields.map((f) => `${f.fieldPath} ${f.order === 'DESCENDING' ? 'DESC' : 'ASC'}`).join(',')}`)
  const needed = [...db._indexNeeds]
  assert.ok(needed.length >= 2, needed.join(' | '))
  for (const n of needed) assert.ok(declared.includes(n), `firestore.indexes.json is missing ${n}`)
})

test('docs: transactions read before they write (Firestore rule)', async () => {
  const db = fakeFirestore()
  const d = createFirestoreDocs(db)
  await assert.rejects(
    d.tx(async (tx) => {
      tx.set('a', '1', { x: 1 })
      await tx.get('a', '2')
    }),
    /reads to be executed before all writes/,
  )
  await d.set('a', 'u', { x: undefined, y: 1 })
  assert.deepEqual(await d.get('a', 'u'), { y: 1 }, 'undefined fields are dropped, not rejected')
  await d.merge('a', 'u', { m: { k: 1 } })
  await d.merge('a', 'u', { m: { j: 2 } })
  assert.deepEqual((await d.get('a', 'u')).m, { k: 1, j: 2 })
  await d.patch('a', 'u', { m: { only: 3 } })
  assert.deepEqual((await d.get('a', 'u')).m, { only: 3 }, 'patch replaces the whole field')
})

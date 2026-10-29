// A prop's AI read is written once and shared: the same prop, line, prices and day give the same
// key; anything that moves gives a new one; old reads expire.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readKey, createReadCache } from '../src/nfl/ai.js'
import { createStore } from '../src/lib/store.js'

const ctx = (over = {}) => ({ prop: { id: '101.sog.o.2.5', line: 2.5, prob: 0.612, price: { book: 'fanduel', over: -120, under: 100 }, ...over }, injury: null })
const SPORT = { key: 'nhl', title: 'NHL' }

test('the same read twice has one key; a moved line, price, probability, model or status makes a new one', () => {
  const k = readKey(ctx(), SPORT, 'gpt-x')
  assert.equal(readKey(ctx(), SPORT, 'gpt-x'), k)
  assert.equal(readKey(ctx({ prob: 0.6149 }), SPORT, 'gpt-x'), k, 'probability counts to the point')
  for (const other of [ctx({ line: 3.5 }), ctx({ price: { book: 'fanduel', over: -130, under: 100 } }), ctx({ prob: 0.65 }), { ...ctx(), injury: { status: 'Questionable' } }]) assert.notEqual(readKey(other, SPORT, 'gpt-x'), k)
  assert.notEqual(readKey(ctx(), SPORT, 'gpt-y'), k)
  assert.notEqual(readKey(ctx(), { key: 'nba' }, 'gpt-x'), k)
  assert.equal(readKey({}, SPORT, 'gpt-x'), null)
})

test('shared reads live in the store for every instance, and expire', async () => {
  const store = createStore({ driver: 'memory' })
  const a = createReadCache({ store, sport: SPORT, ttlMs: 50 })
  const b = createReadCache({ store, sport: SPORT, ttlMs: 50 })
  await a.set('k1', 'VERDICT: PRIME')
  assert.equal((await b.get('k1')).text, 'VERDICT: PRIME', 'another instance finds it')
  await a.set('k2', '   ')
  assert.equal(await b.get('k2'), null, 'an empty answer is never shared')
  await new Promise((r) => setTimeout(r, 70))
  assert.equal(await b.get('k1'), null)
})

// Tips & Tricks: every entry complete, links that resolve, and the advanced ones in full for members only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENTRIES, CATEGORIES, legendFor } from '../src/learn/content.js'

test('every entry has a definition, a worked example, a tip and a mistake; links resolve', () => {
  const ids = new Set(ENTRIES.map((x) => x.id))
  assert.equal(ids.size, ENTRIES.length, 'unique ids')
  for (const x of ENTRIES) {
    for (const k of ['term', 'def', 'example', 'tip', 'mistake']) assert.ok(String(x[k] || '').length > 10 || k === 'term', `${x.id}.${k}`)
    assert.ok(CATEGORIES.some((c) => c.key === x.cat), `${x.id} category`)
    for (const s of x.see) assert.ok(ids.has(s), `${x.id} links to ${s}`)
    assert.ok(!/\bAI\b/.test(`${x.def} ${x.example} ${x.tip} ${x.mistake}`), `${x.id}: no AI branding`)
    assert.ok(!/guarantee/i.test(`${x.def} ${x.tip}`), `${x.id}: no guarantees`)
  }
  for (const c of CATEGORIES) assert.ok(ENTRIES.some((x) => x.cat === c.key), `${c.key} has entries`)
})

test('free: basics in full, advanced entries as a name and definition only', () => {
  const free = legendFor(false)
  const adv = free.entries.filter((x) => x.level === 'advanced')
  assert.ok(adv.length >= 10)
  assert.ok(adv.every((x) => x.locked && !x.example && !x.tip && !x.mistake && x.def))
  assert.ok(free.entries.filter((x) => x.level === 'basic').every((x) => !x.locked && x.example))
  assert.ok(legendFor(true).entries.every((x) => !x.locked && x.example))
})

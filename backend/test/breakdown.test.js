// The Bet Breakdown: the two-wins-one-miss demo (with an event log and box score only), push and
// void under the record rules, missing odds and snapshots, who may see what, checking a model's
// words, one charge per pick (refunded on failure), and corrected grades.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEvidence, buildReport, validate, answer, neededFor, distanceOf, settlementHash } from '../src/breakdown/build.js'
import { demoPick, demoGames } from '../src/breakdown/demo.js'
import { createBreakdowns } from '../src/breakdown/service.js'
import { createCredits } from '../src/billing/credits.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { ApiError } from '../src/lib/router.js'
import { clock, withEnv, TREASURY } from './support.js'

const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, APEX_BILLING_STORE: 'store', K_SERVICE: null, APEX_AUTH: null, APEX_CREDIT_COSTS: null })
process.on('exit', () => restoreEnv())

const report = (mode) => {
  const pick = demoPick()
  return buildReport({ pick, evidence: buildEvidence({ pick, games: demoGames(mode), demo: true }), demo: true })
}

test('the demo: two legs won, one missed; with the event log, and with only the box score', () => {
  const r = report('events')
  assert.equal(r.demo, true)
  assert.ok(r.evidence.every((e) => e.kind === 'rules' || /Demo data/.test(e.source)), 'every fact is labelled demo')
  assert.deepEqual(r.legs.map((l) => l.status), ['win', 'win', 'loss'])
  assert.equal(r.parlay.result, 'loss')
  assert.match(r.summary, /^Two legs won and one missed \(Player C’s Over 5\.5 Assists\)\. In a parlay every leg that counts has to win/)
  const c = r.legs[2]
  assert.equal(c.needed, '6 or more')
  assert.equal(c.value, 4)
  assert.equal(c.distance, -2)
  assert.equal(c.explanation, 'Player C Over 5.5 Assists missed: it needed 6 or more, and the final number was 4, 2 short.')
  assert.match(c.factors.join(' '), /The event log records his fourth foul early in the third quarter\./)
  assert.match(c.factors.join(' '), /He finished with 24 minutes, below the saved 34-minute projection\. Less playing time meant fewer chances\. The data doesn’t establish that more minutes would have produced the 2 more assists it needed\./)
  assert.equal(c.evidenceStatus, 'complete')
  assert.deepEqual([c.preBet.prob, c.preBet.saved], [0.55, true], 'the estimate saved at posting')
  // box score only: the miss is explained, the reason for the minutes isn't
  const b = report('boxscore')
  const cb = b.legs[2]
  assert.equal(cb.evidenceStatus, 'partial')
  assert.match(cb.factors.join(' '), /Why his minutes were down isn’t in the data: only the box score is available/)
  assert.ok(!/foul early/.test(cb.factors.join(' ')))
  // follow-ups, from the facts
  assert.equal(answer(r, 'Which leg missed, and by how much?').text, 'Player C’s Over 5.5 Assists missed: it needed 6 or more and finished at 4, 2 short.')
  assert.match(answer(r, 'Was that information available before I placed the bet?').text, /saved estimate was 55%.*weren’t knowable then/)
  assert.match(answer(r, 'Did these legs depend on the same game conditions?').text, /Player A, Player B and Player C played in the same game/)
  assert.match(answer(r, 'Was the estimate poorly calibrated, or could this be normal variation?', { calibration: [{ band: '55–60%', hit: 0.57, n: 40 }] }).text, /One result can’t show.*aren’t enough graded legs/)
  assert.match(answer(r, 'was the estimate off?', { calibration: [{ band: '55–60%', hit: 0.57, n: 1840 }] }).text, /legs estimated at 55–60% won 57% of 1,840/)
})

test('push and void under the record rules; what a leg needed', () => {
  assert.deepEqual([neededFor({ line: 5.5, side: 'o' }).text, neededFor({ line: 24.5, side: 'u' }).text, neededFor({ line: 7, side: 'o' }).push], ['6 or more', '24 or fewer', 7])
  assert.equal(distanceOf({ line: 24.5, side: 'u' }, 20), 4)
  const pick = { ...demoPick(), result: 'win', profit: 0.87, decimal: 1.87 }
  pick.legs = [{ ...pick.legs[0], result: 'win', value: 29 }, { ...pick.legs[1], line: 10, label: 'Over 10 Rebounds', result: 'push', value: 10 }, { ...pick.legs[2], result: 'void', value: null }]
  const r = buildReport({ pick, evidence: buildEvidence({ pick, games: demoGames('boxscore') }) })
  assert.deepEqual(r.parlay.counts, { win: 1, loss: 0, push: 1, void: 1, pending: 0 })
  assert.match(r.summary, /Every leg that counted won; 2 dropped out \(push or void\)/)
  assert.match(r.legs[1].explanation, /landed exactly on 10, a push, so it dropped out/)
  assert.match(r.legs[2].explanation, /was voided: a player with no stats in the game/i)
  assert.match(r.parlay.rule, /exactly on the line is a push/)
  assert.ok(r.evidence.some((e) => e.kind === 'settlement' && e.value.profit === 0.87), 'the recorded settlement, not a recomputed one')
})

test('missing odds, a pick still settling, and no snapshot from posting', () => {
  const pick = demoPick()
  pick.status = 'open'
  pick.result = null
  pick.legs = pick.legs.map((l, i) => (i === 2 ? { ...l, result: null, value: null, price: null, prob: undefined, fair: undefined, proj: undefined, projMin: undefined } : l))
  const r = buildReport({ pick, evidence: buildEvidence({ pick, games: new Map() }) })
  assert.equal(r.parlay.awaiting, true)
  assert.match(r.summary, /^Awaiting confirmation/)
  assert.equal(r.legs[2].status, 'pending')
  assert.equal(r.legs[2].evidenceStatus, 'awaiting')
  assert.equal(r.legs[2].price, null, 'no accepted price on record: none is invented')
  assert.equal(r.legs[2].preBet.saved, false)
  assert.ok(r.limitations.some((x) => /No estimate was saved/.test(x)))
  assert.equal(r.legs[0].evidenceStatus, 'unavailable', 'no game data at all')
  assert.match(answer(r, 'what changed during the game?').text, /Only the final box score|isn’t available/)
})

test('a model’s words are checked: numbers, citations, luck, advice, unsupported claims', () => {
  const r = report('events')
  const good = { summary: 'Two legs won. Player C finished with 4 assists, 2 short of the 6 he needed.', legs: [{ index: 2, finding: 'He played 24 minutes against a saved projection of 34.', evidence: ['e1'] }], limitations: [], takeaways: [] }
  assert.equal(validate(good, r).ok, true, validate(good, r).reasons.join(', '))
  const bad = (patch) => validate({ ...good, ...patch }, r)
  assert.match(bad({ summary: 'Player C finished with 7 assists.' }).reasons.join(), /number 7 isn’t in the evidence/)
  assert.match(bad({ summary: 'It was 70% bad luck and 30% game script.' }).reasons.join(), /banned/)
  assert.match(bad({ summary: 'Next time, bet more to win it back.' }).reasons.join(), /banned/)
  assert.match(bad({ summary: 'His ankle injury limited him.' }).reasons.join(), /unsupported claim \(injury\)/)
  assert.match(bad({ summary: 'The coach benched him.' }).reasons.join(), /unsupported claim \(coach\)/)
  assert.match(bad({ legs: [{ index: 2, finding: 'Fouls.', evidence: ['e999'] }] }).reasons.join(), /unknown evidence e999/)
  assert.match(bad({ legs: [{ index: 2, finding: 'Fouls.', evidence: [] }] }).reasons.join(), /cites nothing/)
})

// ---- the service: who sees what, credits, corrections -------------------------------------------
function setup({ ai = null, failTx = 0 } = {}) {
  const now = clock(Date.parse('2026-11-20T12:00:00Z'))
  const raw = createStoreDocs(createStore({ driver: 'memory' }))
  let fails = failTx
  const docs = { ...raw, tx: (fn) => (fails-- > 0 ? Promise.reject(new Error('store down')) : raw.tx(fn)) }
  const billing = createBilling({ docs: raw, now })
  const credits = createCredits({ docs: raw, billing, now })
  const nba = { wh: { summaries: new Map([['demo-game', { data: demoGames('events').get('demo-game').summary, at: now() }]]), logs: new Map(), at: {} }, espn: { summary: async () => null } }
  const b = createBreakdowns({ docs, engines: { nba }, credits, ai, now })
  return { raw, billing, credits, b, now }
}
const mine = { uid: 'u_me', email: 'me@example.com' }
const other = { uid: 'u_other', email: 'o@example.com' }
const boss = { uid: 'boss', admin: true }
async function rejectsWith(p, code) {
  await assert.rejects(p, (e) => e instanceof ApiError && e.code === code, `expected ${code}`)
}

test('owners only, members only: a free account sees its settlement and a preview', async () => {
  const { raw, billing, b } = setup()
  await raw.set('picks', 'pk_test1', { ...demoPick(), id: undefined, demo: undefined, uid: 'u_me' })
  await rejectsWith(b.get(null, 'pk_test1'), 'signin')
  await rejectsWith(b.get(other, 'pk_test1'), 'not_found')
  await rejectsWith(b.generate(other, 'pk_test1'), 'not_found')
  const locked = await b.get(mine, 'pk_test1')
  assert.equal(locked.locked, true)
  assert.deepEqual(locked.preview.legs.map((l) => l.status), ['win', 'win', 'loss'])
  assert.equal(locked.report, undefined, 'no analysis for a free account')
  await rejectsWith(b.generate(mine, 'pk_test1'), 'upgrade')
  await rejectsWith(b.ask(mine, 'pk_test1', 'which leg missed?'), 'upgrade')
  await billing.grant(boss, { uid: 'u_me', plan: 'pro', days: 30 })
  const none = await b.get(mine, 'pk_test1')
  assert.deepEqual([none.status, none.cost], ['none', 3], 'the cost shows before building')
  await rejectsWith(b.get(other, 'pk_test1'), 'not_found')
})

test('one charge per pick: parallel builds, repeat views, a failure refunded, a correction rebuilt free', async () => {
  const { raw, billing, credits, b } = setup({ failTx: 1 })
  await raw.set('picks', 'pk_test2', { ...demoPick(), id: undefined, demo: undefined, uid: 'u_me' })
  await billing.grant(boss, { uid: 'u_me', plan: 'pro', days: 30 })
  // the first build fails (the store is down): no credits used
  await rejectsWith(b.generate(mine, 'pk_test2'), 'breakdown_failed')
  assert.equal((await credits.status(mine)).left, 120)
  const [x, y] = await Promise.all([b.generate(mine, 'pk_test2'), b.generate(mine, 'pk_test2')])
  assert.equal(x.status, 'ready')
  assert.equal(y.status, 'ready')
  assert.equal((await credits.status(mine)).left, 117, 'two taps at once, one charge')
  assert.equal(x.report.legs[2].status, 'loss')
  assert.equal((await b.get(mine, 'pk_test2')).status, 'ready')
  await b.generate(mine, 'pk_test2')
  assert.equal((await credits.status(mine)).left, 117, 'looking again is free')
  const q = await b.ask(mine, 'pk_test2', 'Which leg missed, and by how much?')
  assert.match(q.text, /Player C’s Over 5\.5 Assists missed/)
  // a stat correction: Player C actually had 6 assists; the parlay wins
  const p = await raw.get('picks', 'pk_test2')
  p.legs[2] = { ...p.legs[2], value: 6, result: 'win' }
  await raw.set('picks', 'pk_test2', { ...p, result: 'win', profit: 5.24 })
  const stale = await b.get(mine, 'pk_test2')
  assert.equal(stale.status, 'outdated')
  await rejectsWith(b.ask(mine, 'pk_test2', 'which leg missed?'), 'outdated')
  const fresh = await b.generate(mine, 'pk_test2')
  assert.equal(fresh.report.parlay.result, 'win')
  assert.equal(fresh.versions.length, 1, 'the old report is kept')
  assert.match(fresh.versions[0].summary, /one missed/)
  assert.equal((await credits.status(mine)).left, 117, 'a corrected grade is rebuilt at no charge')
  assert.notEqual(settlementHash(p), settlementHash({ ...p, legs: p.legs.map((l, i) => (i === 2 ? { ...l, value: 4 } : l)) }))
})

test('a model narrates only when its words check out', async () => {
  const lies = { ready: () => true, complete: async () => ({ text: JSON.stringify({ summary: 'It was 80% bad luck.', legs: [{ index: 2, finding: 'He had 7 assists.', evidence: ['e1'] }] }) }) }
  const s1 = setup({ ai: lies })
  await s1.raw.set('picks', 'pk_test3', { ...demoPick(), id: undefined, demo: undefined, uid: 'u_me' })
  await s1.billing.grant(boss, { uid: 'u_me', plan: 'pro', days: 30 })
  const r1 = await s1.b.generate(mine, 'pk_test3')
  assert.equal(r1.narration, 'template', 'the made-up numbers fall back to the template')
  assert.equal(r1.report.summaryText, r1.report.summary)
  const honest = { ready: () => true, complete: async () => ({ text: JSON.stringify({ summary: 'Two legs won; Player C finished with 4 assists, 2 short.', legs: [{ index: 2, finding: 'He played 24 minutes; the event log records his fourth foul.', evidence: ['e1'] }], limitations: [], takeaways: [] }) }) }
  const s2 = setup({ ai: honest })
  await s2.raw.set('picks', 'pk_test4', { ...demoPick(), id: undefined, demo: undefined, uid: 'u_me' })
  await s2.billing.grant(boss, { uid: 'u_me', plan: 'pro', days: 30 })
  const r2 = await s2.b.generate(mine, 'pk_test4')
  assert.equal(r2.narration, 'model')
  assert.match(r2.report.summaryText, /^Two legs won; Player C finished with 4 assists/)
  assert.match(r2.report.legs[2].finding, /fourth foul/)
})

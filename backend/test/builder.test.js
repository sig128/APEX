// The parlay builder: profiles screen the board, one leg per player, no legs that pull against each
// other, a price near the target, the chance from the simulation, kept legs, posted prices, and
// the route (members, a credit a build, nothing charged when nothing fits).
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildParlays, readRequest, targetsFor, defaultTarget, profilesView, supportOf, movedAgainst, PROFILES, TARGET_RANGE } from '../src/nfl/analytics/builder.js'
import { legCorrelation } from '../src/nfl/analytics/lock.js'
import { simulateSlip } from '../src/nfl/analytics/sim.js'
import { RULES } from '../src/nfl/rules.js'
import { FOOTBALL_CORE } from '../src/nfl/markets.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { createStore } from '../src/lib/store.js'
import { createApexApp } from '../app.js'
import { fixtureHttp } from './helpers.js'
import { fakeChain, clock, withEnv, TREASURY, testAuth, USERS, bearer, serve } from './support.js'

const NOW = Date.parse('2026-10-25T12:00:00Z')
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString()
const LABEL = { passYds: 'Pass Yards', rushYds: 'Rush Yards', recYds: 'Rec Yards', rec: 'Receptions', anyTd: 'Anytime TD', longRec: 'Longest Reception' }

let seq = 0
/** A prop row with good support unless overridden. */
function row(over = {}) {
  seq++
  const market = over.market || 'recYds'
  const side = over.side || 'o'
  const line = over.line ?? 40.5
  const playerId = over.playerId || String(5000 + seq)
  return {
    id: `${playerId}.${market}.${side}.${line}`,
    kind: 'player',
    playerId,
    teamId: over.teamId || `T${seq}`,
    oppId: over.oppId || `O${seq}`,
    gameId: over.gameId || `G${seq}`,
    name: `Player ${seq}`,
    short: `P. ${seq}`,
    teamAbbr: 'AAA',
    oppAbbr: 'BBB',
    market,
    label: `${side === 'u' ? 'Under' : 'Over'} ${line} ${LABEL[market] || market}`,
    shortLabel: `${side === 'u' ? 'U' : 'O'} ${line}`,
    line,
    side,
    oneSided: false,
    prob: 0.6,
    probModel: 0.68,
    proj: line * 1.2,
    sd: Math.max(1, line * 0.4),
    sample: 16,
    role: 0.95,
    fit: 1,
    windows: [
      { key: 'L5', hits: 3, n: 5 },
      { key: 'L10', hits: 6, n: 10 },
      { key: 'season', hits: 7, n: 12 },
    ],
    recent: [
      { date: daysAgo(20), o: 'hit' },
      { date: daysAgo(13), o: 'miss' },
      { date: daysAgo(6), o: 'hit' },
    ],
    read: { lean: 'for' },
    price: null,
    move: null,
    ...over,
  }
}

/** A slate: eight games, a few legs each, a spread of chances. */
function slate() {
  const rows = []
  const probs = [0.52, 0.55, 0.58, 0.61, 0.64, 0.67, 0.7, 0.74]
  for (let g = 0; g < 8; g++) {
    const home = `H${g}`
    const away = `A${g}`
    rows.push(row({ gameId: `G${g}`, teamId: home, oppId: away, market: 'passYds', line: 240.5, prob: probs[g] }))
    rows.push(row({ gameId: `G${g}`, teamId: away, oppId: home, market: 'rushYds', line: 60.5, prob: probs[(g + 3) % 8] }))
    rows.push(row({ gameId: `G${g}`, teamId: home, oppId: away, market: 'rec', line: 4.5, prob: probs[(g + 5) % 8] }))
    rows.push(row({ gameId: `G${g}`, teamId: away, oppId: home, market: 'anyTd', line: 0.5, oneSided: true, prob: 0.3 + 0.05 * (g % 4), probModel: 0.32 + 0.05 * (g % 4) }))
  }
  return rows
}
const ln = Math.log
const decOf = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a)

test('targets for each profile and leg count: four payouts it can reach, shortest first', () => {
  for (const P of Object.values(PROFILES)) {
    for (let n = P.legs.min; n <= P.legs.max; n++) {
      const t = targetsFor(P.key, n)
      assert.ok(t.length >= 2 && t.length <= 4, `${P.key} ${n}`)
      assert.deepEqual([...t].sort((a, b) => a - b), t, 'shortest first')
      assert.ok(t.every((x) => x >= TARGET_RANGE.min && x <= TARGET_RANGE.max))
      assert.ok(t.includes(defaultTarget(P.key, n)))
    }
  }
  // more legs, bigger payouts
  assert.ok(targetsFor('balanced', 5)[0] > targetsFor('balanced', 3)[0])
  assert.ok(targetsFor('longshot', 4)[1] > targetsFor('safe', 4)[1])
  const view = profilesView()
  assert.deepEqual(view.map((p) => p.key), ['safe', 'balanced', 'longshot'])
  assert.ok(view.every((p) => p.targets[p.legs.def].includes(p.target)))
})

test('the request is read strictly: leg counts, targets, ids', () => {
  assert.deepEqual(readRequest({ risk: 'safe', legs: 3, target: 250 }), { risk: 'safe', legs: 3, adjusted: false, target: 250, keep: [], avoid: [], gameId: null })
  assert.equal(readRequest({ risk: 'nope' }).risk, 'balanced', 'an unknown profile falls back')
  assert.equal(readRequest({ risk: 'safe', legs: 7 }).legs, 4, 'a profile caps its legs')
  assert.equal(readRequest({ risk: 'safe', legs: 7 }).adjusted, true)
  assert.match(readRequest({ legs: 1 }).error, /2 to 8 legs/)
  assert.match(readRequest({ legs: 2.5 }).error, /legs/)
  assert.match(readRequest({ target: 50 }).error, /Target odds/)
  assert.match(readRequest({ target: 'big' }).error, /Target odds/)
  assert.equal(readRequest({ risk: 'balanced', legs: 4 }).target, defaultTarget('balanced', 4))
  assert.equal(readRequest({ gameId: '<script>' }).gameId, null)
  assert.equal(readRequest({ gameId: '401873011' }).gameId, '401873011')
  assert.equal(readRequest({ keep: Array.from({ length: 60 }, (_, i) => `${i}.rec.o.4.5`) }).keep.length, 40)
})

test('support: games behind it, role, the projection backing it, form and the read', () => {
  const strong = supportOf(row(), { now: NOW })
  assert.ok(strong > 0.75, `strong ${strong}`)
  assert.ok(supportOf(row({ sample: 5 }), { now: NOW }) < strong, 'fewer games behind it')
  assert.ok(supportOf(row({ role: 0.5 }), { now: NOW }) < strong, 'a shaky role')
  assert.ok(supportOf(row({ probModel: 0.5 }), { now: NOW }) < strong, 'the projection alone doesn’t back it')
  assert.ok(supportOf(row({ read: { lean: 'against' } }), { now: NOW }) < strong, 'the read says caution')
  assert.ok(supportOf(row(), { now: NOW, injury: { severity: 'questionable' } }) < strong - 0.1, 'questionable costs')
  assert.ok(supportOf(row({ market: 'longRec' }), { now: NOW, core: new Set(FOOTBALL_CORE) }) < strong, 'an unfamiliar market costs')
  assert.equal(movedAgainst(row({ move: { open: 45.5, delta: -5 } })), true, 'an over whose line came down')
  assert.equal(movedAgainst(row({ move: { open: 35.5, delta: 5 } })), false, 'moved toward the over')
})

test('a balanced build: one leg per player, nothing that pulls against itself, near the target, the simulation’s chance', () => {
  const rows = slate()
  const out = buildParlays(rows, { risk: 'balanced', legs: 3, target: 400, now: NOW, core: FOOTBALL_CORE })
  assert.equal(out.status, 'ok', out.reason)
  assert.equal(out.mode, 'fair', 'no posted prices: the payout is the fair one')
  assert.ok(out.builds.length >= 2, 'options to pick from')
  for (const b of out.builds) {
    assert.equal(b.legs.length, 3)
    const subjects = b.legs.map((l) => l.r.playerId)
    assert.equal(new Set(subjects).size, 3, 'one leg per player')
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(legCorrelation(b.legs[i].r, b.legs[j].r) >= RULES.corrFloor, 'no pair pulls against the other')
    assert.ok(b.legs.every((l) => l.r.prob >= PROFILES.balanced.minProb))
    // the chance is the simulation's: close to an independent run, and the fair price follows it
    const sim = simulateSlip(b.legs.map((l) => l.r), { iterations: 40_000, seed: 99 })
    assert.ok(Math.abs(sim.parlay.hitRate - b.chance) < 0.015, `${b.chance} vs ${sim.parlay.hitRate}`)
    assert.ok(Math.abs(ln(decOf(b.fair)) - ln(1 / b.chance)) < 0.02)
    assert.equal(b.onTarget, Math.abs(ln(decOf(b.fair)) - ln(5)) <= ln(1.3))
    assert.equal(b.multiplied, Math.round(b.legs.reduce((x, l) => x * l.r.prob, 1) * 1e4) / 1e4)
    for (const l of b.legs) assert.ok(l.swaps.length > 0 && l.swaps.every((s) => !b.legs.some((x) => x.r.id === s.r.id)), 'swaps are other legs')
  }
  assert.ok(out.builds[0].onTarget)
  // the options are different parlays
  const [a, b] = out.builds
  const shared = a.legs.filter((l) => b.legs.some((x) => x.r.playerId === l.r.playerId)).length
  assert.ok(shared <= 1, `options share ${shared} legs`)
})

test('legs that pull against each other never go in together', () => {
  // a QB's yards over and his own receiver's yards under: one of them has to lose
  const qb = row({ gameId: 'GX', teamId: 'TX', oppId: 'TY', market: 'passYds', line: 250.5, prob: 0.72 })
  const wr = row({ gameId: 'GX', teamId: 'TX', oppId: 'TY', market: 'recYds', line: 70.5, side: 'u', prob: 0.72 })
  assert.ok(legCorrelation(qb, wr) < RULES.corrFloor)
  const rows = [qb, wr, ...slate()]
  for (const legs of [2, 3, 4]) {
    const out = buildParlays(rows, { risk: 'balanced', legs, target: targetsFor('balanced', legs)[1], now: NOW, gameId: null })
    for (const b of out.builds) assert.ok(!(b.legs.some((l) => l.r.id === qb.id) && b.legs.some((l) => l.r.id === wr.id)), `${legs} legs`)
  }
  // two lines for the same player: never both
  const p1 = row({ playerId: '777', market: 'rec', line: 3.5, prob: 0.72 })
  const p2 = row({ playerId: '777', market: 'recYds', line: 30.5, prob: 0.7 })
  const out = buildParlays([p1, p2, ...slate()], { risk: 'safe', legs: 3, target: 250, now: NOW })
  for (const b of out.builds) assert.ok(b.legs.filter((l) => l.r.playerId === '777').length <= 1)
})

test('profiles screen the board: chance, injuries, yes-only markets, games behind it, role', () => {
  const rows = [
    row({ prob: 0.55 }), // under the safe 60%
    row({ prob: 0.7, sample: 4 }), // too few games
    row({ prob: 0.7, role: 0.5 }), // shaky role
    row({ prob: 0.7, playerId: 'hurt' }), // on the report
    row({ market: 'anyTd', oneSided: true, prob: 0.65 }), // yes-only: not for safe
    row({ prob: 0.9 }), // too short to beat the vig
    row({ market: 'longRec', prob: 0.7 }), // not a familiar market
    row({ prob: 0.7, move: { open: 45.5, delta: -5 } }), // the line moved away from it
    row({ prob: 0.7 }),
    row({ prob: 0.68 }),
  ]
  const injuryOf = (id) => (id === 'hurt' ? { status: 'Questionable', severity: 'questionable' } : null)
  const out = buildParlays(rows, { risk: 'safe', legs: 2, target: 120, now: NOW, injuryOf, core: FOOTBALL_CORE })
  assert.deepEqual(
    [out.funnel.chance, out.funnel.sample, out.funnel.role, out.funnel.injury, out.funnel.oneSided, out.funnel.short, out.funnel.markets, out.funnel.market, out.funnel.eligible],
    [1, 1, 1, 1, 1, 1, 1, 1, 2],
  )
  assert.equal(out.builds.length, 1)
  assert.deepEqual(out.builds[0].legs.map((l) => l.r.prob).sort(), [0.68, 0.7])
  // longshot lets the questionable player and the yes-only market in
  const ls = buildParlays(rows, { risk: 'longshot', legs: 3, target: 250, now: NOW, injuryOf, core: FOOTBALL_CORE })
  assert.equal(ls.funnel.injury, 0)
  assert.equal(ls.funnel.oneSided, 0)
  // out is out for everyone
  const out2 = buildParlays(rows, { risk: 'longshot', legs: 3, target: 250, now: NOW, injuryOf: (id) => (id === 'hurt' ? { status: 'Out', severity: 'out' } : null) })
  assert.equal(out2.funnel.injury, 1)
})

test('too few legs, a target out of reach, and legs to avoid', () => {
  const few = buildParlays([row({ prob: 0.7 }), row({ prob: 0.68 })], { risk: 'safe', legs: 3, target: 250, now: NOW })
  assert.equal(few.status, 'short')
  assert.equal(few.reason, 'Only 2 props from 2 players pass the safe screen on the board, and a 3-leg parlay needs 3 different players.')
  assert.equal(few.builds.length, 0)
  // four safe legs can't pay +120: the closest, said plainly
  const far = buildParlays(slate(), { risk: 'safe', legs: 4, target: 120, now: NOW })
  assert.equal(far.status, 'off_target')
  assert.match(far.reason, /^The closest 4-leg safe parlay on the board is fair at about \+\d+, not \+120\. Fewer legs gets closer\.$/)
  assert.equal(far.builds[0].onTarget, false)
  // a leg to avoid stays out
  const board = slate()
  const first = buildParlays(board, { risk: 'balanced', legs: 3, target: 400, now: NOW })
  const drop = first.builds[0].legs[0].r.id
  const again = buildParlays(board, { risk: 'balanced', legs: 3, target: 400, now: NOW, avoid: [drop] })
  assert.ok(again.builds.every((b) => b.legs.every((l) => l.r.id !== drop)))
  assert.equal(again.funnel.avoided, 1)
})

test('kept legs go in first; two that clash, or too many, are refused', () => {
  const rows = slate()
  const mine = rows.find((r) => r.market === 'rushYds' && r.prob === 0.61)
  const out = buildParlays(rows, { risk: 'balanced', legs: 3, target: 400, keepRows: [mine], now: NOW })
  assert.equal(out.status, 'ok', out.reason)
  for (const b of out.builds) {
    assert.equal(b.legs[0].r.id, mine.id)
    assert.equal(b.legs[0].kept, true)
    assert.deepEqual(b.legs[0].swaps, [], 'a kept leg isn’t swapped')
  }
  const qb = row({ gameId: 'GX', teamId: 'TX', market: 'passYds', line: 250.5, prob: 0.72 })
  const wr = row({ gameId: 'GX', teamId: 'TX', market: 'recYds', line: 70.5, side: 'u', prob: 0.72 })
  assert.equal(buildParlays(rows, { risk: 'balanced', legs: 3, keepRows: [qb, wr], now: NOW }).code, 'keep_conflict')
  assert.equal(buildParlays(rows, { risk: 'balanced', legs: 2, keepRows: [rows[0], rows[5]], now: NOW }).code, 'keep_too_many')
})

test('with posted prices on the board, the payout is the prices and expected value counts', () => {
  const price = (p, edge) => {
    // a price that implies `p - edge`, so the leg has that much edge
    const q = p - edge
    return { over: q > 0.5 ? -Math.round((q / (1 - q)) * 100) : Math.round(((1 - q) / q) * 100), under: null, book: 'DraftKings' }
  }
  const rows = slate().map((r, i) => ({ ...r, price: price(r.prob, i % 3 === 0 ? 0.06 : -0.02) }))
  const out = buildParlays(rows, { risk: 'balanced', legs: 3, target: 400, now: NOW })
  assert.equal(out.mode, 'book')
  const b = out.builds[0]
  assert.ok(b.price, 'the posted price of the parlay')
  const dec = b.legs.reduce((x, l) => x * decOf(l.r.price.over), 1)
  assert.ok(Math.abs(b.price.decimal - dec) < 0.01)
  assert.ok(Math.abs(b.price.ev - (b.chance * b.price.decimal - 1)) < 0.001)
  assert.ok(b.price.ev > 0, `the best build has an edge at the posted prices (${b.price.ev})`)
})

// ---- the route ----------------------------------------------------------------------------
const restoreEnv = withEnv({ APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, APEX_BILLING_NETWORK: 'base', APEX_BILLING_STORE: 'store', K_SERVICE: null, VERCEL: null, APEX_CREDITS_PRO: null, APEX_CREDIT_COSTS: null, APEX_LOG_LEVEL: 'error', APEX_AUTH: null, OPENAI_API_KEY: null })
test.after(() => restoreEnv())

test('the route: members only, a credit a build, a retry free, nothing charged when nothing fits', async () => {
  const now = clock()
  const docs = createStoreDocs(createStore({ driver: 'memory' }))
  const billing = createBilling({ docs, chainFor: () => fakeChain(), now })
  await docs.set('subscriptions', 'u_pro', { plan: 'pro', paidUntil: now() + 20 * 86_400_000, source: 'usdc', updatedAt: now() })
  const { http } = fixtureHttp()
  const made = createApexApp({ engineMode: 'lazy', http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS), billing, oddsKey: () => null, now })
  const api = await serve(made.app)
  try {
    await api.get('/api/nfl/home')
    const prof = await api.get('/api/nfl/build/profiles')
    assert.equal(prof.status, 200)
    assert.deepEqual(prof.body.profiles.map((p) => p.key), ['safe', 'balanced', 'longshot'])
    const body = { risk: 'balanced', legs: 3, target: 400, runKey: 'build-000001' }
    assert.equal((await api.post('/api/nfl/build', body)).status, 401)
    assert.equal((await api.post('/api/nfl/build', body, { headers: bearer('u_free') })).status, 402)
    assert.equal((await api.post('/api/nfl/build', { legs: 1 }, { headers: bearer('u_pro') })).body.code, 'bad_build')
    assert.equal((await api.post('/api/nfl/build', { keep: ['junk'] }, { headers: bearer('u_pro') })).body.code, 'bad_prop')

    const r = await api.post('/api/nfl/build', body, { headers: bearer('u_pro') })
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300))
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.ok(r.body.builds.length >= 1)
    assert.deepEqual([r.body.credits.cost, r.body.credits.left], [1, 119])
    const b = r.body.builds[0]
    assert.equal(b.legs.length, 3)
    assert.ok(b.legs.every((l) => l.id && l.label && l.sport === 'nfl' && typeof l.simHit === 'number'), 'legs come as board cards')
    assert.ok(b.chance > 0 && b.chance < 1 && b.iterations >= 10_000)
    assert.ok(b.legs.some((l) => l.swaps.length), 'other legs to swap in')

    now.add(10_000)
    const again = await api.post('/api/nfl/build', body, { headers: bearer('u_pro') })
    assert.deepEqual([again.body.credits.cost, again.body.credits.left], [0, 119], 'the same tap again is free')
    assert.equal(again.body.builds[0].id, b.id, 'same request, same data: same answer')

    // a kept leg from the slip goes in
    now.add(10_000)
    const keep = b.legs[1].id
    const kept = await api.post('/api/nfl/build', { risk: 'balanced', legs: 3, target: 400, keep: [keep], runKey: 'build-000002' }, { headers: bearer('u_pro') })
    assert.equal(kept.status, 200)
    assert.equal(kept.body.builds[0].legs[0].id, keep)
    assert.equal(kept.body.builds[0].legs[0].kept, true)
    assert.equal(kept.body.credits.left, 118)

    // nothing fits (four safe legs from one game with almost none that pass): no charge
    now.add(10_000)
    const none = await api.post('/api/nfl/build', { risk: 'safe', legs: 4, target: 600, gameId: '401873013', runKey: 'build-000003' }, { headers: bearer('u_pro') })
    assert.equal(none.status, 200)
    assert.equal(none.body.status, 'short')
    assert.equal(none.body.builds.length, 0)
    assert.match(none.body.reason, /^No props pass the safe screen in this game, and a 4-leg parlay needs 4 different players\./)
    assert.deepEqual([none.body.credits.cost, none.body.credits.refunded, none.body.credits.left], [0, true, 118])
    assert.equal((await api.get('/api/billing/credits', { headers: bearer('u_pro') })).body.left, 118, 'the credit came back')
    // a game that isn't on the board: refused, and no charge either
    now.add(10_000)
    const gone = await api.post('/api/nfl/build', { risk: 'balanced', legs: 3, gameId: '999999999', runKey: 'build-000004' }, { headers: bearer('u_pro') })
    assert.equal(gone.status, 400)
    assert.equal(gone.body.code, 'started')
    const left = (await api.get('/api/billing/credits', { headers: bearer('u_pro') })).body.left
    assert.equal(left, 118)
  } finally {
    await api.close()
    for (const e of Object.values(made.engines)) e.stop()
  }
})

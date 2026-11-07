// The public calibration page: graded props banded by the probability the model gave them, against
// how often they hit. Only wins and losses count; pushes, voids and postponed games sit beside
// them. Filters by league, prop type, window and season; a closed day's rows are public, an open
// one's never; and each closed day's fingerprint is written once and never written over.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { createStore } from '../src/lib/store.js'
import { createLimiter } from '../src/security/rateLimit.js'
import { COLS, createPropLog, summarizeDay } from '../src/nfl/proplog.js'
import { parsePropId } from '../src/nfl/analytics/core.js'
import { createCalibration, bandOf, canonicalLines, canonicalText, sha256Hex, seasonOf, seasonRange, seasonLabel, BANDS, FIELDS } from '../src/calibration/service.js'
import { calibrationRoutes } from '../src/calibration/routes.js'
import { createApexApp } from '../app.js'
import { createBilling } from '../src/billing/service.js'
import { createStoreDocs } from '../src/billing/docs.js'
import { fixtureHttp } from './helpers.js'
import { clock, serve, testAuth, USERS, withEnv } from './support.js'

const restoreEnv = withEnv({ OPENAI_API_KEY: null, APEX_PAYWALL: null, APEX_AUTH: null, K_SERVICE: null, VERCEL: null, APEX_LOG_LEVEL: 'silent', CRON_SECRET: null })
const C = Object.fromEntries(COLS.map((k, i) => [k, i]))
const HOUR = 3_600_000
const NOW = Date.parse('2026-11-05T17:00:00Z') // noon in New York: "today" is 2026-11-05
const CACHE = 'public, max-age=60, s-maxage=300'
const servers = []
after(async () => {
  for (const s of servers) await s.close()
  restoreEnv()
})

// ---- a prop log with days on file ---------------------------------------------------------------

let nextId = 1000
/** n rows of one kind, each its own player: the board's side at p (first look p0), and its result. */
function mk(n, { market = 'sog', side = 'o', line = 2.5, p, p0 = p, res, game = 'g1', line0 = line, val } = {}) {
  return Array.from({ length: n }, () => {
    const id = `${++nextId}.${market}.${side}.${line}`
    assert.ok(parsePropId(id), id)
    const a = Array(COLS.length).fill(null)
    Object.assign(a, {
      [C.id]: id,
      [C.game]: game,
      [C.p]: p,
      [C.price]: -110,
      [C.best]: -105,
      [C.book]: 'fanduel',
      [C.edge]: 0.02,
      [C.score]: 72,
      [C.p0]: p0,
      [C.price0]: -110,
      [C.line0]: line0,
      [C.t0]: 1_762_200_000_000 + nextId,
      [C.t1]: 1_762_210_000_000 + nextId,
      [C.res]: res ?? null,
      [C.val]: val !== undefined ? val : res === 'w' ? line + 1.5 : res === 'l' ? Math.max(0, line - 1.5) : res === 'p' ? line : null,
    })
    return a
  })
}

/** Put a day on file the way the log keeps it: the raw day, the index, and (closed) the monthly summary. */
async function putDay(store, sport, day, list, { done = true, summary = true } = {}) {
  const games = {}
  const pl = {}
  for (const r of list) {
    games[r[C.game]] = { k: Date.parse(`${day}T23:00:00Z`), n: 'AAA @ BBB' }
    const id = parsePropId(r[C.id])
    pl[id.playerId] = [`P. ${id.playerId}`, 'AAA', 'BBB', 'F']
  }
  const doc = { v: 1, sport, day, createdAt: 1, games, pl, rows: Object.fromEntries(list.map((r, i) => [`${r[C.game]}:${i}`, r])), done, ...(done ? { gradedAt: Date.parse(`${day}T23:00:00Z`) + 30 * HOUR } : {}) }
  await store.set(`proplog-${sport}`, day, doc)
  await indexDay(store, sport, day, { open: !done })
  if (done && summary) await store.update(`propsum-${sport}`, day.slice(0, 7), (cur) => ({ ...(cur || {}), days: { ...(cur?.days || {}), [day]: { ...summarizeDay(doc), at: 1 } } }))
  return doc
}
async function indexDay(store, sport, day, { open = false } = {}) {
  await store.update(`proplog-${sport}`, 'index', (v) => ({
    all: [...new Set([...(v?.all || []), day])].sort(),
    open: open ? [...new Set([...(v?.open || []), day])].sort() : (v?.open || []).filter((d) => d !== day),
  }))
}

/**
 * NHL: Nov 3 (closed), Oct 20 (closed), Aug 20 (closed, not in the summary), Mar 10 (closed),
 * Nov 4 (still open), Oct 25 (in the summary but its raw day is gone), today (a closed doc, never
 * public). NBA: Nov 2 (closed, with first looks that differ and a line that moved).
 */
async function fill(store) {
  const A = [
    // 70 to 75%: 21-9 at an average of 72%: 30 graded, not small
    ...mk(11, { p: 0.7, res: 'w' }),
    ...mk(4, { p: 0.7, res: 'l' }),
    ...mk(10, { p: 0.74, res: 'w' }),
    ...mk(5, { p: 0.74, res: 'l' }),
    // 60 to 65%: 10-10, plus 3 pushes and 2 voids that don't count: 20 graded, small
    ...mk(10, { p: 0.62, res: 'w' }),
    ...mk(10, { p: 0.62, res: 'l' }),
    ...mk(3, { p: 0.62, res: 'p', line: 2 }),
    ...mk(2, { p: 0.62, res: 'v' }),
    // the top band takes 90% exactly; 89.9% is still 85 to 90
    ...mk(5, { p: 0.93, res: 'w' }),
    ...mk(1, { p: 0.9, res: 'l' }),
    ...mk(1, { p: 0.899, res: 'w' }),
    // yes-only props under 50% sit outside the bands, not in 50 to 55
    ...mk(2, { market: 'anyGoal', line: 0.5, p: 0.31, res: 'w' }),
    ...mk(6, { market: 'anyGoal', line: 0.5, p: 0.31, res: 'l' }),
    // a game with no final: every row void, counted as postponed
    ...mk(4, { p: 0.66, res: 'v', game: 'g9' }),
  ]
  const days = {}
  days.A = await putDay(store, 'nhl', '2026-11-03', A)
  days.B = await putDay(store, 'nhl', '2026-10-20', [...mk(3, { market: 'saves', line: 25.5, p: 0.57, res: 'w' }), ...mk(2, { market: 'saves', line: 25.5, p: 0.57, res: 'l' }), ...mk(4, { p: 0.81, res: 'w' })])
  days.C = await putDay(store, 'nhl', '2026-08-20', [...mk(2, { p: 0.77, res: 'w' }), ...mk(1, { p: 0.77, res: 'l' })], { summary: false })
  days.D = await putDay(store, 'nhl', '2026-03-10', [...mk(1, { p: 0.76, res: 'w' }), ...mk(3, { p: 0.76, res: 'l' })])
  days.E = await putDay(store, 'nhl', '2026-11-04', mk(2, { p: 0.71 }), { done: false })
  days.T = await putDay(store, 'nhl', '2026-11-05', mk(1, { p: 0.7, res: 'w' }))
  // summarized once, raw day no longer there
  await store.update('propsum-nhl', '2026-10', (cur) => ({ ...cur, days: { ...cur.days, '2026-10-25': { ...summarizeDay({ rows: { a: mk(1, { p: 0.7, res: 'w' })[0] } }), at: 1 } } }))
  await indexDay(store, 'nhl', '2026-10-25')
  days.F = await putDay(store, 'nba', '2026-11-02', [
    ...mk(3, { market: 'pts', line: 24.5, p: 0.67, res: 'w' }),
    ...mk(1, { market: 'pts', line: 24.5, p: 0.67, res: 'l' }),
    // the first look was a coin flip at the same line
    ...mk(2, { market: 'pts', line: 24.5, p: 0.67, p0: 0.52, res: 'w' }),
    ...mk(2, { market: 'pts', line: 24.5, p: 0.67, p0: 0.52, res: 'l' }),
    // the first look was at 23.5: another bet, so it can't be graded as this one
    ...mk(1, { market: 'pts', line: 24.5, line0: 23.5, p: 0.67, p0: 0.61, res: 'w' }),
    ...mk(1, { market: 'pts', line: 24.5, line0: 23.5, p: 0.67, p0: 0.61, res: 'l' }),
  ])
  return days
}

function fakeEngine(key, store, now) {
  const e = { sport: { key }, wh: { games: new Map(), summaries: new Map(), logs: new Map(), season: 2026, aVersion: 1 }, espn: null, views: null }
  e.proplog = createPropLog({ engine: e, store, now })
  return e
}

async function setup({ perRequest, limiter } = {}) {
  const store = createStore({ driver: 'memory' })
  const now = clock(NOW)
  const engines = { nhl: fakeEngine('nhl', store, now), nba: fakeEngine('nba', store, now) }
  const days = await fill(store)
  const calibration = createCalibration({ engines, store, now, ...(perRequest ? { perRequest } : {}) })
  const app = express()
  app.use('/api/calibration', calibrationRoutes({ calibration, ...(limiter ? { limiter } : {}) }))
  const api = await serve(app)
  servers.push(api)
  return { store, now, engines, calibration, api, days }
}

const band = (body, key) => body.bands.find((b) => b.key === key)
const counts = (b) => [b.wins, b.losses, b.pushes, b.voids, b.postponed]
/** The fingerprint, worked out here from the published rows with nothing but node:crypto. */
function hashRows(rows) {
  const lines = rows.map((r) => JSON.stringify([r.id, r.p, r.p0, r.t0, r.t1, r.res, r.val])).sort()
  return crypto.createHash('sha256').update(lines.length ? `${lines.join('\n')}\n` : '').digest('hex')
}

// ---- the pieces -----------------------------------------------------------------------------------

test('bands: 5 points wide from 50%, 90% and up together, under 50% outside, no float edges', () => {
  const cases = [
    [0.5, '50'],
    [0.549, '50'],
    [0.55, '55'],
    [0.57, '55'],
    [0.6, '60'],
    [0.65, '65'],
    [0.7, '70'],
    [0.749, '70'],
    [0.85, '85'],
    [0.899, '85'],
    [0.9, '90'],
    [0.99, '90'],
    [0.499, 'lo'],
    [0.31, 'lo'],
    [null, null],
    [Number.NaN, null],
  ]
  for (const [p, want] of cases) assert.equal(bandOf(p), want, String(p))
  assert.deepEqual(BANDS, ['50', '55', '60', '65', '70', '75', '80', '85', '90'])
})

test('seasons run from the month after each league’s off months, named by the year they start', () => {
  assert.equal(seasonOf('nhl', '2026-11-03'), 2026)
  assert.equal(seasonOf('nhl', '2026-08-20'), 2025)
  assert.deepEqual(seasonRange('nhl', 2026), { from: '2026-10-01', to: '2027-09-30' })
  assert.equal(seasonLabel('nhl', 2026), '2026-27')
  assert.deepEqual(seasonRange('nfl', 2026), { from: '2026-08-01', to: '2027-07-31' })
  assert.equal(seasonLabel('nfl', 2026), '2026')
  assert.deepEqual(seasonRange('mlb', 2026), { from: '2026-03-01', to: '2027-02-28' })
  assert.equal(seasonOf('mlb', '2027-01-15'), 2026, 'the winter belongs to the season before')
})

test('the fingerprint text: one compact JSON line per graded row, sorted, newline-terminated', () => {
  const rows = [
    { id: '20.sog.o.2.5', p: 0.6, p0: 0.61, t0: 1, t1: 2, res: 'w', val: 3, price: -110 },
    { id: '1.sog.u.1.5', p: 0.55, p0: null, t0: 1, t1: 2, res: 'v', val: null },
    { id: '3.sog.o.2.5', p: 0.7, p0: 0.7, t0: 5, t1: 6, res: null, val: null }, // not graded: not in it
  ]
  const lines = canonicalLines(rows)
  assert.deepEqual(lines, ['["1.sog.u.1.5",0.55,null,1,2,"v",null]', '["20.sog.o.2.5",0.6,0.61,1,2,"w",3]'])
  const text = canonicalText(lines)
  assert.equal(text, '["1.sog.u.1.5",0.55,null,1,2,"v",null]\n["20.sog.o.2.5",0.6,0.61,1,2,"w",3]\n')
  assert.equal(sha256Hex(text), crypto.createHash('sha256').update(text).digest('hex'))
  // the log's arrays give the same lines as row objects, whatever order the rows come in
  const arrays = rows.map((o) => COLS.map((k) => o[k] ?? null))
  assert.deepEqual(canonicalLines(arrays.reverse()), lines)
  assert.equal(canonicalText([]), '')
  assert.deepEqual(FIELDS, ['id', 'p', 'p0', 't0', 't1', 'res', 'val'])
})

// ---- the page's numbers ----------------------------------------------------------------------------

test('banding: hit rate on wins and losses only, pushes, voids and postponed apart, small bands marked', async () => {
  const { api } = await setup()
  const res = await api.get('/api/calibration?league=nhl&window=30d')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), CACHE)
  const b = res.body
  assert.deepEqual(b.bands.map((x) => x.key), BANDS, 'every band, in order, even the empty ones')

  const b70 = band(b, '70')
  assert.equal(b70.n, 30)
  assert.equal(b70.hit, 0.7)
  assert.equal(b70.avg, 0.72)
  assert.equal(b70.small, false, '30 graded is enough')
  assert.ok(b70.low < 0.7 && b70.high > 0.7 && b70.low > 0.5, 'a 95% range around the hit rate')

  const b60 = band(b, '60')
  assert.deepEqual([b60.n, ...counts(b60)], [20, 10, 10, 3, 2, 0], 'pushes and voids are counted apart, never as misses')
  assert.equal(b60.hit, 0.5)
  assert.equal(b60.avg, 0.62)
  assert.equal(b60.small, true)

  const b65 = band(b, '65')
  assert.deepEqual([b65.n, ...counts(b65)], [0, 0, 0, 0, 0, 4], 'a game with no final is postponed, not a void and not a loss')
  assert.equal(b65.hit, null)
  assert.equal(b65.small, true)

  assert.deepEqual([band(b, '90').wins, band(b, '90').losses], [5, 1], '90% exactly is in the top band')
  assert.equal(band(b, '90').avg, 0.925)
  assert.deepEqual([band(b, '85').wins, band(b, '85').losses], [1, 0], '89.9% is 85 to 90')
  assert.deepEqual([band(b, '55').wins, band(b, '55').losses], [3, 2])
  assert.deepEqual([band(b, '80').wins, band(b, '80').losses], [4, 0])
  assert.equal(band(b, '50').n, 0, 'the yes-only props under 50% are not in 50 to 55')
  assert.deepEqual([b.outside.below50.wins, b.outside.below50.losses, b.outside.below50.avg], [2, 6, 0.31])

  assert.deepEqual([b.overall.n, b.overall.wins, b.overall.losses, b.overall.pushes, b.overall.voids, b.overall.postponed], [66, 44, 22, 3, 2, 4])
  assert.equal(b.small, 30)

  // the headline speaks for the biggest band at 60%+ with 30 graded, with its size
  assert.equal(b.headline.band, '70')
  assert.equal(b.headline.text, 'Props rated 70 to 75% hit 70.0% in the last 30 days')
  assert.equal(b.headline.n, 30)
  assert.match(b.headline.sub, /^30 graded props, average rating 72\.0%$/)
  assert.ok(b.headline.rule)

  // and it says exactly which days the numbers cover
  assert.equal(b.range.window, '30d')
  assert.equal(b.range.from, '2026-10-06')
  assert.equal(b.range.to, '2026-11-04')
  assert.equal(b.range.first, '2026-10-20')
  assert.equal(b.range.last, '2026-11-03')
  assert.equal(b.range.days, 2)
  assert.deepEqual(b.range.pending, [{ league: 'nhl', day: '2026-11-04' }], 'the open day is named, not counted')
  assert.deepEqual(b.range.missing, [{ league: 'nhl', day: '2026-10-25' }], 'a closed day whose rows are gone is named')
  assert.equal(b.range.complete, true)
  assert.deepEqual(b.range.reconciled, { days: 2, differ: [] }, 'the counts agree with the log’s own summary of each day')
  assert.match(b.range.note, /Oct 20, 2026 to Nov 3, 2026: 2 days\./)
  assert.deepEqual(b.markets.map((m) => m.key).sort(), ['anyGoal', 'saves', 'sog'])
  assert.deepEqual(b.leagues.map((l) => l.key), ['nhl', 'nba'])
})

test('filters: league, prop type, window, season and the first-look basis', async () => {
  const { api } = await setup()
  const get = async (q) => {
    const r = await api.get(`/api/calibration?${q}`)
    assert.equal(r.status, 200, q)
    return r.body
  }
  // season (the default): the NHL's 2026-27 season so far
  const season = await get('league=nhl')
  assert.equal(season.filters.window, 'season')
  assert.deepEqual(season.range.season, { key: 2026, label: '2026-27', from: '2026-10-01', to: '2027-09-30' })
  assert.equal(season.range.to, '2026-11-04', 'never past yesterday')
  assert.equal(season.range.days, 2)
  assert.equal(season.headline.text, 'Props rated 70 to 75% hit 70.0% this season')

  // 90 days reach back to Aug 7: the August day (not in the summary, closed in its raw day) comes in
  const d90 = await get('league=nhl&window=90d')
  assert.equal(d90.range.days, 3)
  assert.deepEqual([band(d90, '75').wins, band(d90, '75').losses], [2, 1])

  // last season by its start year: August and March 2026
  const s25 = await get('league=nhl&window=season&season=2025')
  assert.deepEqual(s25.range.season, { key: 2025, label: '2025-26', from: '2025-10-01', to: '2026-09-30' })
  assert.deepEqual([s25.range.first, s25.range.last, s25.range.days], ['2026-03-10', '2026-08-20', 2])
  const b75 = band(s25, '75')
  assert.deepEqual([b75.n, b75.wins, b75.losses, b75.hit, b75.avg], [7, 3, 4, 0.4286, 0.7643])
  assert.equal(s25.headline, null, 'no band has 30 graded props: no headline')
  assert.equal(s25.headline?.text, undefined)

  // everything on file, today's closed doc still left out
  const all = await get('league=nhl&window=all')
  assert.deepEqual([all.range.first, all.range.last, all.range.days], ['2026-03-10', '2026-11-03', 4])
  assert.match(all.headline.text, / since Mar 10, 2026$/)

  // every league: the NBA day joins
  const both = await get('window=30d')
  assert.equal(both.range.days, 3)
  assert.deepEqual([band(both, '65').wins, band(both, '65').losses, band(both, '65').postponed], [6, 4, 4])
  assert.equal(both.range.leagues.nba.days, 1)
  assert.match(both.range.note, /Oct 20, 2026 to Nov 3, 2026: 2 NHL and 1 NBA\./, 'days counted per league')

  // one prop type
  const pts = await get('market=pts&window=30d')
  assert.deepEqual(pts.bands.filter((x) => x.n).map((x) => [x.key, x.wins, x.losses]), [['65', 6, 4]])
  assert.deepEqual(pts.markets.map((m) => m.key).sort(), ['anyGoal', 'pts', 'saves', 'sog'], 'the prop types on offer stay listed')
  const saves = await get('league=nhl&market=saves&window=30d')
  assert.deepEqual(saves.bands.filter((x) => x.n).map((x) => [x.key, x.wins, x.losses]), [['55', 3, 2]])

  // the first look: banded by p0, and a first look at another line left out
  const p0 = await get('league=nba&basis=p0&window=30d')
  assert.equal(p0.basis.key, 'p0')
  assert.deepEqual(p0.bands.filter((x) => x.n).map((x) => [x.key, x.wins, x.losses]), [['50', 2, 2], ['65', 3, 1]])
  assert.equal(band(p0, '50').avg, 0.52)
  assert.deepEqual([p0.excluded.lineMoved.wins, p0.excluded.lineMoved.losses], [1, 1])
  const p = await get('league=nba&window=30d')
  assert.equal(p.excluded, null)
  assert.deepEqual(p.bands.filter((x) => x.n).map((x) => [x.key, x.wins, x.losses]), [['65', 6, 4]])
})

test('bad filters are 400s with a code, never cached', async () => {
  const { api } = await setup()
  const cases = [
    ['league=xfl', 'bad_league'],
    ['market=passYdz', 'bad_market'],
    ['window=7d', 'bad_window'],
    ['season=26', 'bad_season'],
    ['window=30d&season=2025', 'bad_season'],
    ['basis=p1', 'bad_basis'],
  ]
  for (const [q, code] of cases) {
    const r = await api.get(`/api/calibration?${q}`)
    assert.equal(r.status, 400, q)
    assert.equal(r.body.code, code, q)
    assert.ok(r.body.error, q)
    assert.equal(r.headers.get('cache-control'), 'no-store')
  }
})

// ---- one closed day, in the open ------------------------------------------------------------------

test('a closed day’s rows are public and reconcile; open days, today and the future are refused', async () => {
  const { api, now, days } = await setup()
  const r = await api.get('/api/calibration/day/nhl/2026-11-03')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), CACHE)
  const b = r.body
  assert.equal(b.closed, true)
  assert.equal(b.rows.length, Object.keys(days.A.rows).length)
  assert.deepEqual(b.counts, { rows: 74, wins: 39, losses: 26, pushes: 3, voids: 2, postponed: 4 })
  assert.equal(b.rows.filter((x) => x.postponed).length, 4)
  assert.deepEqual([band(b, '70').wins, band(b, '70').losses], [21, 9], 'the day’s own bands')
  // rows come in fingerprint order, and anyone can hash them to the published fingerprint
  const lines = b.rows.map((x) => JSON.stringify([x.id, x.p, x.p0, x.t0, x.t1, x.res, x.val]))
  assert.deepEqual(lines, [...lines].sort())
  assert.equal(b.fingerprint.sha256, hashRows(b.rows))
  assert.equal(b.computed.sha256, b.fingerprint.sha256)
  assert.equal(b.match, true)
  assert.equal(b.mismatch, null)
  assert.equal(b.fingerprint.at, now())
  assert.equal(b.fingerprint.rows, 74)
  const one = b.rows.find((x) => x.id.includes('.anyGoal.'))
  assert.deepEqual([one.market, one.side, one.line, one.band, one.team, one.game], ['anyGoal', 'yes', 0.5, 'lo', 'AAA', 'AAA @ BBB'])
  assert.match(one.name, /^P\. \d+$/)
  assert.equal(b.rows[0].gameId, 'g1')
  assert.ok(!('price' in b.rows[0]) && !('edge' in b.rows[0]), 'only what the calibration claim rests on')

  // the exact text the fingerprint is taken over
  const text = await api.raw('GET', '/api/calibration/day/nhl/2026-11-03?format=text')
  assert.equal(text.status, 200)
  assert.match(text.headers.get('content-type'), /^text\/plain/)
  const body = await text.text()
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), b.fingerprint.sha256)
  assert.equal(body.split('\n').length, 75, '74 lines and the final newline')

  const refused = [
    ['/api/calibration/day/nhl/2026-11-04', 409, 'day_open'], // waiting on results
    ['/api/calibration/day/nhl/2026-11-05', 409, 'day_open'], // today, even with every row graded
    ['/api/calibration/day/nhl/2026-11-20', 409, 'day_open'], // the future
    ['/api/calibration/day/nhl/2026-10-25', 404, 'not_found'], // nothing raw on file
    ['/api/calibration/day/nhl/2026-09-01', 404, 'not_found'],
    ['/api/calibration/day/xfl/2026-11-03', 404, 'unknown_league'],
    ['/api/calibration/day/nhl/2026-13-01', 400, 'bad_day'],
    ['/api/calibration/day/nhl/yesterday', 400, 'bad_day'],
    ['/api/calibration/day/nhl/2026-11-03?format=xml', 400, 'bad_format'],
  ]
  for (const [path, status, code] of refused) {
    const x = await api.get(path)
    assert.equal(x.status, status, path)
    assert.equal(x.body.code, code, path)
    assert.ok(x.body.error, path)
    assert.equal(x.headers.get('cache-control'), 'no-store', path)
    assert.equal(x.body.rows, undefined, `${path}: no rows`)
  }
})

test('fingerprints: taken the first time a closed day is read, written once, a change reported beside them', async () => {
  const { api, now, store, engines } = await setup()
  assert.equal(await store.get('calfp-nhl', '2026-11'), undefined, 'nothing until a closed day is read')

  // reading the page fingerprints the closed days it counts (and only those)
  await api.get('/api/calibration?league=nhl&window=30d')
  const nov = await store.get('calfp-nhl', '2026-11')
  const first = nov.days['2026-11-03']
  assert.match(first.sha256, /^[0-9a-f]{64}$/)
  assert.equal(first.at, NOW)
  assert.equal(first.rows, 74)
  assert.deepEqual(first.counts, { w: 39, l: 26, p: 3, v: 6 })
  assert.ok(first.gradedAt)
  assert.ok((await store.get('calfp-nhl', '2026-10')).days['2026-10-20'])
  assert.equal(nov.days['2026-11-04'], undefined, 'never an open day')
  assert.equal(nov.days['2026-11-05'], undefined, 'never today')

  const list = await api.get('/api/calibration/fingerprints?league=nhl&window=30d')
  assert.equal(list.status, 200)
  assert.equal(list.headers.get('cache-control'), CACHE)
  assert.deepEqual(list.body.days.map((d) => d.day), ['2026-11-03', '2026-10-20'], 'newest first')
  assert.equal(list.body.days[0].sha256, first.sha256)
  assert.equal(list.body.days[0].url, '/api/calibration/day/nhl/2026-11-03')
  assert.equal(list.body.verify.format, 'proppickz-calibration-v1')

  // a row changes after the fact: the fingerprint stays, the change is reported
  now.add(HOUR)
  const doc = await store.get('proplog-nhl', '2026-11-03')
  const lost = Object.keys(doc.rows).find((k) => doc.rows[k][C.res] === 'l')
  doc.rows[lost][C.res] = 'w'
  await store.set('proplog-nhl', '2026-11-03', doc)
  const changed = await api.get('/api/calibration/day/nhl/2026-11-03')
  assert.equal(changed.status, 200)
  assert.equal(changed.body.match, false)
  assert.equal(changed.body.fingerprint.sha256, first.sha256, 'the original is kept')
  assert.equal(changed.body.fingerprint.at, NOW)
  assert.notEqual(changed.body.computed.sha256, first.sha256)
  assert.equal(changed.body.computed.sha256, hashRows(changed.body.rows), 'the rows handed out are the ones on file now')
  assert.deepEqual([changed.body.mismatch.sha256, changed.body.mismatch.at], [changed.body.computed.sha256, NOW + HOUR])
  assert.equal(changed.body.counts.wins, 40)

  // another change: still the original, and the first different hash is the one noted
  now.add(HOUR)
  const again = await store.get('proplog-nhl', '2026-11-03')
  const other = Object.keys(again.rows).find((k) => again.rows[k][C.res] === 'l')
  again.rows[other][C.res] = 'w'
  await store.set('proplog-nhl', '2026-11-03', again)
  const twice = await api.get('/api/calibration/day/nhl/2026-11-03')
  assert.equal(twice.body.fingerprint.sha256, first.sha256)
  assert.equal(twice.body.mismatch.sha256, changed.body.computed.sha256)
  assert.equal(twice.body.mismatch.at, NOW + HOUR)

  // a server with nothing in memory doesn't write over it either
  const fresh = createCalibration({ engines, store, now })
  const out = await fresh.closedDay('nhl', '2026-11-03')
  assert.equal(out.body.fingerprint.sha256, first.sha256)
  assert.equal(out.body.match, false)
  const kept = await store.get('calfp-nhl', '2026-11')
  assert.deepEqual(kept.days['2026-11-03'], first, 'the stored fingerprint never changed')
  assert.equal(kept.mismatch['2026-11-03'].sha256, changed.body.computed.sha256)

  // the list shows the change too
  const listed = (await fresh.fingerprints({ league: 'nhl', window: '30d' })).days.find((d) => d.day === '2026-11-03')
  assert.equal(listed.sha256, first.sha256)
  assert.equal(listed.mismatch.sha256, changed.body.computed.sha256)

  // put back as it was: it matches again (and the change stays on record)
  doc.rows[lost][C.res] = 'l'
  await store.set('proplog-nhl', '2026-11-03', doc)
  const back = await fresh.closedDay('nhl', '2026-11-03')
  assert.equal(back.body.match, true)
  assert.ok(back.body.mismatch)
})

test('a request boils down a bounded number of closed days; the rest follow, and a short cache says so', async () => {
  const { api, store } = await setup({ perRequest: 1 })
  const first = await api.get('/api/calibration?league=nhl&window=all')
  assert.equal(first.status, 200)
  assert.equal(first.body.range.complete, false)
  assert.ok(first.body.range.unprocessed >= 1)
  assert.equal(first.headers.get('cache-control'), 'public, max-age=5, s-maxage=10')
  assert.match(first.body.range.note, /still being added/)
  let last = first
  for (let i = 0; i < 6 && !last.body.range.complete; i++) last = await api.get('/api/calibration?league=nhl&window=all')
  assert.equal(last.body.range.complete, true)
  assert.equal(last.body.range.days, 4)
  assert.equal(last.headers.get('cache-control'), CACHE)
  assert.ok((await store.get('calday-nhl', '2026-03')).days['2026-03-10'], 'counts kept for the next reader')
})

test('public reads are rate limited per address', async () => {
  const { api } = await setup({ limiter: createLimiter({ burst: 4, perSec: 0.001 }) })
  assert.equal((await api.get('/api/calibration/day/nhl/2026-11-03')).status, 200, 'a day costs 3')
  const r = await api.get('/api/calibration?league=nhl')
  assert.equal(r.status, 200)
  const slow = await api.get('/api/calibration?league=nhl')
  assert.equal(slow.status, 429)
  assert.equal(slow.body.code, 'slow_down')
  assert.ok(Number(slow.headers.get('retry-after')) > 0)
  assert.equal(slow.headers.get('cache-control'), 'no-store')
})

test('after the daily run, the days it closed are fingerprinted without anyone visiting', async () => {
  const store = createStore({ driver: 'memory' })
  const now = clock(NOW)
  const engines = { nhl: fakeEngine('nhl', store, now) }
  await putDay(store, 'nhl', '2026-11-03', [...mk(3, { p: 0.7, res: 'w' }), ...mk(1, { p: 0.7, res: 'l' })])
  await putDay(store, 'nhl', '2026-11-04', mk(2, { p: 0.7 }), { done: false })
  const calibration = createCalibration({ engines, store, now })
  let ran = 0
  const metrics = { daily: async () => ({ nhl: { ran: ++ran } }), overview: () => 'kept' }
  const wrapped = calibration.afterDaily(metrics)
  assert.equal(wrapped.overview(), 'kept')
  assert.deepEqual(await wrapped.daily(), { nhl: { ran: 1 } }, 'the daily run’s own answer, unchanged')
  const fp = await store.get('calfp-nhl', '2026-11')
  assert.ok(fp.days['2026-11-03'].sha256)
  assert.equal(fp.days['2026-11-04'], undefined)
  assert.ok((await store.get('calday-nhl', '2026-11')).days['2026-11-03'])
  // a failing sweep never fails the daily run
  const broken = createCalibration({ engines: { nhl: { proplog: { index: async () => { throw new Error('down') } } } }, store, now })
  assert.deepEqual(await broken.afterDaily(metrics).daily(), { nhl: { ran: 2 } })
})

test('the whole app serves it at /api/calibration, no sign-in needed', async () => {
  const store = createStore({ driver: 'memory' })
  const now = clock(NOW)
  await putDay(store, 'nhl', '2026-11-03', [...mk(20, { p: 0.72, res: 'w' }), ...mk(10, { p: 0.72, res: 'l' })])
  const { http } = fixtureHttp()
  const made = createApexApp({ engineMode: 'lazy', http, store, auth: testAuth(USERS), billing: createBilling({ docs: createStoreDocs(store), now }), oddsKey: () => null, listUsers: async () => [], now })
  const api = await serve(made.app)
  servers.push(api)
  try {
    const r = await api.get('/api/calibration?league=nhl&window=30d')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('cache-control'), CACHE)
    assert.equal(r.body.headline.text, 'Props rated 70 to 75% hit 66.7% in the last 30 days')
    assert.ok(r.body.leagues.some((l) => l.key === 'nfl'))
    const d = await api.get('/api/calibration/day/nhl/2026-11-03')
    assert.equal(d.status, 200)
    assert.equal(d.body.fingerprint.sha256, hashRows(d.body.rows))
    const missing = await api.get('/api/calibration/nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, 'not_found')
    assert.equal(made.engines.nhl.started?.() || false, false, 'reading the record never starts a league')
  } finally {
    for (const e of Object.values(made.engines)) e.stop()
  }
})

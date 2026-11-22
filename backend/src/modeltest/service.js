// The model test: are our formulas or a language model (OpenAI, or Claude when that's the key on
// the server) better at saying how likely a prop is to hit?
//
// It takes props the board has already graded (the prop log, src/nfl/proplog.js) and rebuilds what
// was known before each game from the saved game logs: the player's games before it for that stat,
// the line and side, home or away, the opponent, the matchup note and the sportsbook price when one
// was logged. The model is asked for its own chance that the side hits. It never sees our number,
// the result or the web. Both are then scored on the same props:
//   - Brier score: the average of (chance - result)^2. 0 is a perfect forecaster and a coin flip
//     called at 50% scores 0.25, so lower is better. The paired difference says whether the gap is
//     bigger than chance would make.
//   - bands: when it said 60 to 70%, how often that side hit
//   - money: one unit on every prop where each saw value against the logged price, settled at that
//     price. The market's own chance (the no-vig price the board's edge was measured against) is
//     scored too, as the bar to beat.
//
// One run at a time, in the store's 'modeltest' namespace. The plan (which props, written out in
// batches of 20) is saved when the run starts, and each step asks about the next few batches and
// saves the answers, so a run outlives the time limit on one request and any page reload.
import crypto from 'node:crypto'
import { rowObj } from '../nfl/proplog.js'
import { parsePropId, marketRows, hitCount } from '../nfl/analytics/core.js'
import { MARKETS } from '../nfl/markets.js'
import { SPORTS } from '../sports/index.js'
import { americanToDecimal } from '../lib/odds.js'
import { ApiError } from '../lib/router.js'
import { clamp, mapLimit } from '../lib/util.js'
import { log, errText } from '../lib/log.js'
import { scrubKeys } from '../ai/llm.js'

export const NS = 'modeltest'
export const BATCH = 20
const PARALLEL = 3
const STALE_MS = 4 * 60_000 // a claimed batch whose step died is free again after this
export const SIZES = { min: 60, max: 1200, fallback: 600 }
const MIN_GAMES = 3 // games before the prop needed to say anything about it

export const SYSTEM = `You estimate the chance that sports player props hit, from the numbers given.
For each numbered prop, give the probability (0.01 to 0.99) that the side named wins: for "Over" the stat goes over the line, for "Under" it stays under, and for a yes-only prop the player does it.
Use the numbers given and your general knowledge of the sport. You don't know how these games went, so don't guess at results.
Be calibrated: of all the props you give 0.70, about 70% should hit.
Answer with JSON only, no other text: {"p":[{"i":1,"p":0.62},{"i":2,"p":0.41}]}`

export const providerName = (p) => (p === 'anthropic' ? 'Claude' : 'OpenAI')

// ---- the plan --------------------------------------------------------------------------------

/** A seeded shuffle, so a run's sample can be rebuilt from its id. */
function shuffled(list, seed) {
  let s = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Every graded player prop (won or lost) on the closed days of one league. */
export async function gradedProps(store, lg) {
  const ns = `proplog-${lg}`
  const idx = await store.get(ns, 'index').catch(() => null)
  const days = Array.isArray(idx?.all) ? idx.all : []
  const docs = await mapLimit(days, 6, (d) => store.get(ns, d).catch(() => null))
  const out = []
  for (const doc of docs) {
    if (!doc?.done || !doc.rows) continue
    for (const row of Object.values(doc.rows)) {
      const r = rowObj(row)
      if (r.res !== 'w' && r.res !== 'l') continue
      if (!(r.p > 0 && r.p < 1)) continue
      const id = parsePropId(r.id)
      if (!id || id.teamId || !MARKETS[id.market]) continue
      const pl = doc.pl?.[id.playerId]
      const g = doc.games?.[r.game]
      if (!pl || !Number.isFinite(g?.k)) continue
      out.push({
        lg,
        d: doc.day,
        id: r.id,
        pid: id.playerId,
        market: id.market,
        side: id.side,
        line: id.line,
        game: String(r.game),
        ko: g.k,
        name: pl[0] || 'Player',
        team: pl[1] || '',
        opp: pl[2] || '',
        pos: pl[3] || '',
        home: r.home,
        mu: r.mu,
        p: r.p,
        // the market's chance the board's edge was measured against: p - edge
        m: Number.isFinite(r.edge) ? clamp(r.p - r.edge, 0.01, 0.99) : null,
        o: Number.isFinite(r.price) ? r.price : null,
        y: r.res === 'w' ? 1 : 0,
      })
    }
  }
  return out
}

/** The saved game logs of one league: player id -> rows (oldest first). */
export async function savedLogs(store, lg) {
  const teams = await store.get(lg, 'logteams').catch(() => null)
  const docs = Array.isArray(teams) ? await mapLimit(teams, 8, (tid) => store.get(lg, `logs:${tid}`).catch(() => null)) : []
  const m = new Map()
  for (const doc of docs) for (const [pid, x] of Object.entries(doc || {})) m.set(String(pid), Array.isArray(x?.rows) ? x.rows : [])
  return m
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
const avgOf = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

/** The side in words: "Over 24.5 Points", "Anytime Goalscorer (yes)". */
export function sideLabel(market, side, line) {
  const mk = MARKETS[market]
  const name = mk?.long || mk?.label || market
  if (mk?.oneSided) return `${name} (yes)`
  return `${side === 'u' ? 'Under' : 'Over'} ${line} ${name}`
}

/**
 * What was known before the game, in plain lines for the model: never our chance, the result or
 * the stat. Null when the player has fewer than MIN_GAMES games before it for this stat.
 */
export function brief(c, logs, i) {
  const before = (logs || []).filter((r) => String(r.eventId) !== c.game && Date.parse(r.date) < c.ko - 60_000)
  const rows = marketRows(before, c.market)
  if (rows.length < MIN_GAMES) return null
  const vals = rows.map((r) => r.v)
  const hit = (list) => {
    const { hits, n } = hitCount(list.map((r) => r.v), c.line, c.side)
    return n ? `${hits}/${n}` : null
  }
  const season = rows.at(-1).season
  const parts = [`last 5 ${hit(rows.slice(-5))}`]
  if (rows.length > 5) parts.push(`last 10 ${hit(rows.slice(-10))}`)
  if (rows.length > 10) parts.push(`last 20 ${hit(rows.slice(-20))}`)
  const cur = rows.filter((r) => r.season === season && !r.post)
  if (cur.length) parts.push(`this season ${hit(cur)}`)
  if (c.opp) {
    const h2h = rows.filter((r) => r.oppAbbr && r.oppAbbr === c.opp)
    if (h2h.length) parts.push(`vs ${c.opp} ${hit(h2h)}`)
  }
  if (c.home === 1 || c.home === 0) {
    const venue = rows.filter((r) => Boolean(r.home) === (c.home === 1)).slice(-10)
    if (venue.length >= 3) parts.push(`${c.home === 1 ? 'home' : 'away'} ${hit(venue)}`)
  }
  const last = vals.slice(-10).reverse()
  const where = c.home === 1 ? 'vs' : c.home === 0 ? 'at' : 'vs'
  const who = `${c.name} (${[c.pos, c.team].filter(Boolean).join(', ') || 'player'})`
  const avg10 = avgOf(vals.slice(-10))
  const avg20 = vals.length >= 20 ? avgOf(vals.slice(-20)) : null
  const mu = c.mu === 'h' ? 'The matchup favors this side.' : c.mu === 'x' ? 'The matchup works against this side.' : c.mu === 'n' ? 'Neutral matchup.' : ''
  const price = Number.isFinite(c.o) ? `Sportsbook price for this side: ${c.o > 0 ? `+${c.o}` : c.o}.` : 'No sportsbook price.'
  return [
    `${i}. ${who} ${where} ${c.opp || 'the opponent'}: ${sideLabel(c.market, c.side, c.line)}`,
    `   Last ${last.length} games, newest first: ${last.map(fmt).join(', ')} (average ${fmt(Math.round(avg10 * 10) / 10)}${avg20 != null ? `; last 20 average ${fmt(Math.round(avg20 * 10) / 10)}` : ''})`,
    `   This side hit: ${parts.join(', ')}`,
    `   ${[mu, price].filter(Boolean).join(' ')}`,
  ].join('\n')
}

/** The user message for one batch: one league, numbered props. */
export function batchText(lg, lines) {
  const name = SPORTS[lg]?.name || lg.toUpperCase()
  return `${name} player props. For each one: the side to price, the player's games before this one for that stat, how often this side has hit, the matchup and the price.\n\n${lines.join('\n\n')}\n\nAnswer with JSON only: {"p":[{"i":1,"p":0.5}, ...]} with one entry for each of the ${lines.length} props.`
}

/** The model's answer: prop number -> chance. Takes fences, percents and a bare array. */
export function parseAnswer(text, count) {
  const s = String(text || '')
  const a = s.search(/[[{]/)
  const b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
  if (a < 0 || b <= a) return new Map()
  let j
  try {
    j = JSON.parse(s.slice(a, b + 1))
  } catch {
    return new Map()
  }
  const list = Array.isArray(j?.p) ? j.p : Array.isArray(j) ? j : []
  const out = new Map()
  for (const x of list) {
    const i = Number(x?.i)
    let p = Number(x?.p)
    if (p > 1 && p <= 100) p /= 100
    if (Number.isInteger(i) && i >= 1 && i <= count && p > 0 && p < 1) out.set(i, clamp(p, 0.01, 0.99))
  }
  return out
}

// ---- the score -------------------------------------------------------------------------------

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null)
const BANDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]

function money(rows, pick) {
  let bets = 0
  let wins = 0
  let profit = 0
  for (const r of rows) {
    if (r.o == null || r.m == null || !pick(r)) continue
    const dec = americanToDecimal(r.o)
    if (!dec) continue
    bets++
    if (r.y) {
      wins++
      profit += dec - 1
    } else profit -= 1
  }
  return { bets, wins, hit: bets ? r4(wins / bets) : null, units: Math.round(profit * 100) / 100, roi: bets ? r4(profit / bets) : null }
}

/** How sure, either way: right when it backed the side that hit. */
function sure(rows, key, at = 0.6) {
  const list = rows.filter((r) => Math.max(r[key], 1 - r[key]) >= at)
  const right = list.filter((r) => (r[key] >= 0.5) === (r.y === 1)).length
  return { n: list.length, right, rate: list.length ? r4(right / list.length) : null }
}

function brierStats(rows, a, b) {
  const sq = (p, y) => (p - y) ** 2
  const n = rows.length
  const d = rows.map((r) => sq(r[a], r.y) - sq(r[b], r.y))
  const md = d.reduce((s, x) => s + x, 0) / n
  const sd = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - md) ** 2, 0) / (n - 1)) : 0
  const se = sd / Math.sqrt(n)
  return { diff: r4(md), z: se > 0 ? Math.round((md / se) * 100) / 100 : 0 }
}

/** Scores the answered props: overall, on priced props, by league, by band, and in units. */
export function scoreRun(items, { provider = 'openai' } = {}) {
  const who = providerName(provider)
  const rows = items.filter((x) => Number.isFinite(x.a) && (x.y === 0 || x.y === 1) && x.p > 0 && x.p < 1)
  const n = rows.length
  if (!n) return null
  const sq = (p, y) => (p - y) ** 2
  const ll = (p, y) => {
    const q = clamp(p, 0.01, 0.99)
    return -(y ? Math.log(q) : Math.log(1 - q))
  }
  const avg = (list, f) => (list.length ? list.reduce((s, r) => s + f(r), 0) / list.length : null)
  const side = (key) => ({ brier: r4(avg(rows, (r) => sq(r[key], r.y))), logloss: r4(avg(rows, (r) => ll(r[key], r.y))), sure: sure(rows, key) })
  const pair = brierStats(rows, 'a', 'p')
  const closer = { model: 0, formula: 0, same: 0 }
  for (const r of rows) {
    const da = Math.abs(r.a - r.y)
    const dp = Math.abs(r.p - r.y)
    if (Math.abs(da - dp) < 0.005) closer.same++
    else if (da < dp) closer.model++
    else closer.formula++
  }
  const agree = rows.filter((r) => (r.a >= 0.5) === (r.p >= 0.5)).length
  const priced = rows.filter((r) => r.m != null && r.o != null)
  const pricedScore = priced.length
    ? {
        n: priced.length,
        formula: r4(avg(priced, (r) => sq(r.p, r.y))),
        model: r4(avg(priced, (r) => sq(r.a, r.y))),
        market: r4(avg(priced, (r) => sq(r.m, r.y))),
      }
    : null
  const leagues = []
  for (const lg of [...new Set(rows.map((r) => r.lg))]) {
    const list = rows.filter((r) => r.lg === lg)
    const st = list.length > 1 ? brierStats(list, 'a', 'p') : { diff: 0, z: 0 }
    leagues.push({
      key: lg,
      name: SPORTS[lg]?.name || lg.toUpperCase(),
      n: list.length,
      formula: r4(avg(list, (r) => sq(r.p, r.y))),
      model: r4(avg(list, (r) => sq(r.a, r.y))),
      winner: list.length < 60 ? 'few' : st.z <= -2 ? 'model' : st.z >= 2 ? 'formula' : 'tie',
    })
  }
  leagues.sort((x, y) => y.n - x.n)
  const band = (key) =>
    BANDS.map((lo, i) => {
      const hi = BANDS[i + 1] ?? 1.0001
      const list = rows.filter((r) => r[key] >= lo && r[key] < hi)
      return { from: lo, to: Math.min(hi, 1), n: list.length, avg: r4(avg(list, (r) => r[key])), hit: list.length ? r4(list.filter((r) => r.y === 1).length / list.length) : null }
    })
  const f = side('p')
  const m = side('a')
  let verdict
  if (n < 100) verdict = { winner: 'few', text: `Only ${n} props answered so far: too few for a verdict.` }
  else if (pair.z <= -2) verdict = { winner: 'model', text: `${who} was closer than our formulas: a Brier score of ${m.brier.toFixed(3)} against ${f.brier.toFixed(3)} on ${n} graded props (lower is better).` }
  else if (pair.z >= 2) verdict = { winner: 'formula', text: `Our formulas were closer than ${who}: a Brier score of ${f.brier.toFixed(3)} against ${m.brier.toFixed(3)} on ${n} graded props (lower is better).` }
  else verdict = { winner: 'tie', text: `Too close to call: our formulas scored ${f.brier.toFixed(3)} and ${who} ${m.brier.toFixed(3)} on ${n} graded props, a gap chance alone could make.` }
  return {
    n,
    verdict,
    formula: f,
    model: m,
    pair,
    closer,
    agree: r4(agree / n),
    priced: pricedScore,
    money: {
      all: money(rows, () => true),
      formula: money(rows, (r) => r.p > r.m),
      model: money(rows, (r) => r.a > r.m),
      both: money(rows, (r) => r.p > r.m && r.a > r.m),
    },
    leagues,
    bands: { formula: band('p'), model: band('a') },
  }
}

// ---- the run ---------------------------------------------------------------------------------

export function createModelTest({ store, ai, leagues = Object.keys(SPORTS), now = () => Date.now() }) {
  const need = () => {
    if (!store) throw new ApiError(503, 'no_store', 'This server has no database to keep the test in.')
  }
  const label = () => providerName(ai?.provider?.())

  function view(run) {
    const base = { ready: Boolean(ai?.ready?.()), provider: ai?.provider?.() || null, who: label(), model: ai?.model?.('insight') || null, sizes: SIZES }
    if (!run) return { ...base, run: null }
    const answered = run.items.filter((x) => Number.isFinite(x.a)).length
    const done = Object.keys(run.done || {}).length
    return {
      ...base,
      run: {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        finishedAt: run.finishedAt || null,
        size: run.items.length,
        leagues: run.leagues,
        batches: run.batches,
        batchesDone: done,
        answered,
        calls: run.calls || 0,
        tokens: run.tokens || { in: 0, out: 0 },
        provider: run.provider,
        who: providerName(run.provider),
        model: run.model || null,
        errors: run.errors || [],
        results: run.results || (answered >= 30 ? scoreRun(run.items, { provider: run.provider }) : null),
      },
    }
  }

  async function status() {
    need()
    return view(await store.get(NS, 'run'))
  }

  async function start({ size, restart = false } = {}) {
    need()
    if (!ai?.ready?.()) throw new ApiError(503, 'no_model', 'No language model key is set on this server (OPENAI_API_KEY).')
    const cur = await store.get(NS, 'run')
    if (cur?.status === 'running' && !restart && now() - (cur.updatedAt || 0) < STALE_MS) throw new ApiError(409, 'running', 'A test is already running. Stop it first, or wait for it to finish.')
    const want = clamp(Math.round(Number(size) || SIZES.fallback), SIZES.min, SIZES.max)
    const id = `mt_${crypto.randomBytes(6).toString('hex')}`

    // every graded prop, by league; leagues with too few to say anything are left out
    const pools = {}
    for (const lg of leagues) {
      const list = await gradedProps(store, lg).catch((e) => {
        log.warn('model test: prop log read failed', { lg, err: errText(e) })
        return []
      })
      if (list.length >= 40) pools[lg] = shuffled(list, `${id}:${lg}`)
    }
    const keys = Object.keys(pools)
    if (!keys.length) throw new ApiError(409, 'no_data', 'There are no graded props on file yet. The test needs closed game days.')

    // an equal share per league, the leftovers to the leagues with more; each prop needs its
    // player's games before it, so a prop without them is skipped and the next one taken
    const picked = {}
    const logsBy = {}
    let left = want
    const order = keys.slice().sort((a, b) => pools[a].length - pools[b].length)
    for (let k = 0; k < order.length; k++) {
      const lg = order[k]
      const share = Math.floor(left / (order.length - k))
      const logs = (logsBy[lg] = await savedLogs(store, lg))
      picked[lg] = []
      for (const c of pools[lg]) {
        if (picked[lg].length >= share) break
        if (brief(c, logs.get(c.pid), 0)) picked[lg].push(c)
      }
      left -= picked[lg].length
    }
    const items = []
    const batches = []
    for (const lg of keys) {
      const logs = logsBy[lg]
      for (let i = 0; i < picked[lg].length; i += BATCH) {
        const group = picked[lg].slice(i, i + BATCH)
        const lines = []
        const idx = []
        group.forEach((c, j) => {
          lines.push(brief(c, logs.get(c.pid), j + 1))
          idx.push(items.length)
          items.push({ lg: c.lg, d: c.d, id: c.id, p: c.p, m: c.m, o: c.o, y: c.y, a: null })
        })
        batches.push({ run: id, n: batches.length, lg, idx, text: batchText(lg, lines) })
      }
    }
    if (items.length < SIZES.min) throw new ApiError(409, 'no_data', `Only ${items.length} graded props have the player's earlier games on file. The test needs at least ${SIZES.min}.`)
    await mapLimit(batches, 8, (b) => store.set(NS, `b:${b.n}`, b))
    const t = now()
    const run = {
      v: 1,
      id,
      status: 'running',
      startedAt: t,
      updatedAt: t,
      provider: ai.provider?.() || 'openai',
      model: ai.model?.('insight') || null,
      leagues: Object.fromEntries(keys.map((lg) => [lg, picked[lg].length])),
      items,
      batches: batches.length,
      done: {},
      taken: {},
      fails: {},
      calls: 0,
      tokens: { in: 0, out: 0 },
      errors: [],
    }
    await store.set(NS, 'run', run)
    log.info('model test started', { id, props: items.length, batches: batches.length, leagues: run.leagues })
    return view(run)
  }

  async function ask(run, n) {
    const b = await store.get(NS, `b:${n}`).catch(() => null)
    if (!b || b.run !== run.id) return { n, ok: false, error: 'This batch is missing. Start a new test.' }
    try {
      const res = await ai.complete({ feature: 'insight', system: SYSTEM, messages: [{ role: 'user', content: b.text }], maxTokens: 700, webSearch: null })
      const got = parseAnswer(res?.text, b.idx.length)
      if (!got.size) return { n, ok: false, called: true, error: 'The answer had no chances in it.' }
      return { n, ok: true, answers: [...got].map(([i, p]) => [b.idx[i - 1], p]), usage: res?.usage || null, model: res?.model || null }
    } catch (e) {
      return { n, ok: false, called: true, error: scrubKeys(errText(e)).slice(0, 200) }
    }
  }

  /** Asks about the next few batches and saves the answers; finishes the run after the last. */
  async function step({ parallel = PARALLEL } = {}) {
    need()
    if (!ai?.ready?.()) throw new ApiError(503, 'no_model', 'No language model key is set on this server (OPENAI_API_KEY).')
    const t = now()
    let mine = []
    const run = await store.update(NS, 'run', (r) => {
      mine = []
      if (!r || r.status !== 'running') return undefined
      for (let n = 0; n < r.batches && mine.length < parallel; n++) {
        if (r.done?.[n]) continue
        const at = r.taken?.[n]
        if (at && t - at < STALE_MS) continue
        mine.push(n)
      }
      if (!mine.length) return undefined
      const taken = { ...(r.taken || {}) }
      for (const n of mine) taken[n] = t
      return { ...r, taken, updatedAt: t }
    })
    if (!run || run.status !== 'running' || !mine.length) return view(run)
    const outs = await Promise.all(mine.map((n) => ask(run, n)))
    const next = await store.update(NS, 'run', (r) => {
      if (!r || r.id !== run.id) return undefined
      const items = r.items.slice()
      const done = { ...(r.done || {}) }
      const taken = { ...(r.taken || {}) }
      const fails = { ...(r.fails || {}) }
      const tokens = { in: r.tokens?.in || 0, out: r.tokens?.out || 0 }
      let calls = r.calls || 0
      let errors = (r.errors || []).slice()
      let model = r.model
      for (const o of outs) {
        delete taken[o.n]
        if (o.called || o.ok) calls++
        if (o.ok) {
          for (const [i, p] of o.answers) if (items[i]) items[i] = { ...items[i], a: p }
          done[o.n] = 1
          tokens.in += Number(o.usage?.input_tokens) || 0
          tokens.out += Number(o.usage?.output_tokens) || 0
          if (o.model) model = o.model
        } else {
          fails[o.n] = (fails[o.n] || 0) + 1
          errors = [{ at: now(), text: o.error }, ...errors].slice(0, 5)
          // two tries per batch; after that it's left out rather than holding up the run
          if (fails[o.n] >= 2) done[o.n] = 1
        }
      }
      const out = { ...r, items, done, taken, fails, tokens, calls, errors, model, updatedAt: now() }
      if (Object.keys(done).length >= r.batches && r.status === 'running') {
        out.status = 'done'
        out.finishedAt = now()
        out.results = scoreRun(items, { provider: r.provider })
        log.info('model test finished', { id: r.id, answered: items.filter((x) => Number.isFinite(x.a)).length, verdict: out.results?.verdict?.winner })
      }
      return out
    })
    return view(next)
  }

  async function stop() {
    need()
    const next = await store.update(NS, 'run', (r) => {
      if (!r || r.status !== 'running') return undefined
      return { ...r, status: 'stopped', finishedAt: now(), updatedAt: now(), taken: {}, results: scoreRun(r.items, { provider: r.provider }) }
    })
    return view(next)
  }

  return { status, start, step, stop }
}

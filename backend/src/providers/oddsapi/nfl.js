// Optional: multi-book player prop prices from The Odds API (https://the-odds-api.com).
// ESPN gives DraftKings lines without prices; with a key we add real prices for the edge math.
// Every event-odds call costs credits (markets x regions), so spend is capped per day and the
// counter lives in the shared store, which all instances read before spending.
import { nameKey } from '../../lib/util.js'
import { log, errText } from '../../lib/log.js'

const BASE = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl'
const MARKETS = {
  player_pass_yds: 'passYds',
  player_pass_attempts: 'passAtt',
  player_pass_completions: 'passCmp',
  player_pass_tds: 'passTd',
  player_pass_interceptions: 'passInt',
  player_rush_yds: 'rushYds',
  player_rush_attempts: 'rushAtt',
  player_receptions: 'rec',
  player_reception_yds: 'recYds',
  player_rush_reception_yds: 'rushRecYds',
  player_anytime_td: 'anyTd',
}
const BOOKS = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'espnbet']

function dayKey(t) {
  return new Date(t).toISOString().slice(0, 10)
}

export function createOddsApi({ http, store, apiKey, now = () => Date.now(), dailyCredits = Number(process.env.APEX_ODDS_DAILY_CREDITS) || 400, perGameEveryMs = 3 * 3600e3 }) {
  let events = null
  let eventsAt = 0
  const snapshots = new Map() // espnGameId -> { at, rows }
  let loaded = false
  const state = { spentToday: 0, lastError: null, lastRefresh: 0 }

  async function loadSnapshots() {
    if (loaded || !store) return
    loaded = true
    try {
      const saved = await store.get('oddsprops', 'all')
      for (const [id, s] of saved || []) snapshots.set(id, s)
    } catch (e) {
      log.warn('odds snapshot load failed', { err: errText(e) })
    }
  }

  /** Reserve credits in the shared counter. Returns false when today's budget is spent. */
  async function spend(cost) {
    if (!store) return true
    const day = dayKey(now())
    let ok = false
    await store.update('oddsprops', `spend:${day}`, (cur) => {
      const used = cur?.used || 0
      if (used + cost > dailyCredits) {
        ok = false
        return undefined
      }
      ok = true
      return { used: used + cost, day }
    })
    const cur = await store.get('oddsprops', `spend:${day}`)
    state.spentToday = cur?.used || 0
    return ok
  }

  async function listEvents() {
    if (events && now() - eventsAt < 30 * 60e3) return events
    events = await http.getJson(`${BASE}/events?apiKey=${encodeURIComponent(apiKey)}`, { priority: 'background', retries: 1 })
    eventsAt = now()
    return events
  }

  function matchEvent(g) {
    const t = Date.parse(g.date)
    return (events || []).find((e) => {
      const close = Math.abs(Date.parse(e.commence_time) - t) < 6 * 3600e3
      return close && nameKey(e.home_team) === nameKey(g.home?.name) && nameKey(e.away_team) === nameKey(g.away?.name)
    })
  }

  function parse(g, json, players) {
    const byName = new Map()
    for (const p of players.values()) if (p.teamId === g.home?.id || p.teamId === g.away?.id) byName.set(nameKey(p.name), p.id)
    const rows = []
    for (const b of json?.bookmakers || []) {
      for (const m of b.markets || []) {
        const market = MARKETS[m.key]
        if (!market) continue
        for (const o of m.outcomes || []) {
          const pid = byName.get(nameKey(o.description))
          if (!pid) continue
          const line = market === 'anyTd' ? 0.5 : Number(o.point)
          if (!Number.isFinite(line)) continue
          rows.push({ pid, market, line, side: /under|no/i.test(o.name) ? 'under' : market === 'anyTd' ? 'yes' : 'over', price: Number(o.price), book: b.key })
        }
      }
    }
    return rows
  }

  function toPrices() {
    const out = new Map()
    for (const s of snapshots.values()) {
      for (const r of s.rows) {
        const key = `${r.pid}:${r.market}:${r.line}`
        const cur = out.get(key) || { books: {} }
        const bk = (cur.books[r.book] ||= {})
        bk[r.side] = r.price
        out.set(key, cur)
      }
    }
    // headline price: DraftKings when it has both sides, else the first complete book
    for (const v of out.values()) {
      const order = BOOKS.filter((b) => v.books[b]).concat(Object.keys(v.books).filter((b) => !BOOKS.includes(b)))
      const pick = order.find((b) => v.books[b].over != null && v.books[b].under != null) || order.find((b) => v.books[b].yes != null) || order[0]
      const bk = v.books[pick] || {}
      v.book = pick
      v.over = bk.over ?? null
      v.under = bk.under ?? null
      v.yes = bk.yes ?? null
    }
    return out
  }

  return {
    status: () => ({ enabled: true, ...state, games: snapshots.size, budget: dailyCredits }),
    async refresh({ games, players }) {
      await loadSnapshots()
      try {
        await listEvents()
      } catch (e) {
        state.lastError = errText(e)
        return snapshots.size ? toPrices() : null
      }
      let changed = false
      for (const g of games) {
        const prev = snapshots.get(g.id)
        if (prev && now() - prev.at < perGameEveryMs) continue
        const ev = matchEvent(g)
        if (!ev) continue
        const markets = Object.keys(MARKETS)
        const cost = markets.length
        if (!(await spend(cost))) break
        try {
          const url = `${BASE}/events/${ev.id}/odds?apiKey=${encodeURIComponent(apiKey)}&regions=us&oddsFormat=american&markets=${markets.join(',')}&bookmakers=${BOOKS.join(',')}`
          const json = await http.getJson(url, { priority: 'background', retries: 0 })
          snapshots.set(g.id, { at: now(), rows: parse(g, json, players) })
          changed = true
        } catch (e) {
          state.lastError = errText(e)
        }
      }
      state.lastRefresh = now()
      if (changed && store) {
        try {
          await store.set('oddsprops', 'all', [...snapshots])
        } catch (e) {
          log.warn('odds snapshot save failed', { err: errText(e) })
        }
      }
      return snapshots.size ? toPrices() : null
    },
  }
}

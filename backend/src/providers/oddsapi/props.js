// Optional: multi-book player prop prices from The Odds API (https://the-odds-api.com), for any
// league. ESPN carries one book (DraftKings, and for the NFL no prices at all); with a key we add
// every book's prices for line shopping and the edge math. Every event-odds call costs credits
// (markets x regions), so spend is capped per league per day and the counter lives in the shared
// store, which all instances read before spending.
import { nameKey } from '../../lib/util.js'
import { log, errText } from '../../lib/log.js'
import { takeOddsCredits } from '../../lib/oddsBudget.js'
import { MARKETS as APEX_MARKETS } from '../../nfl/markets.js'
import { keyRing } from './keys.js'

const FOOTBALL = {
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
const BASKETBALL = {
  player_points: 'pts',
  player_rebounds: 'reb',
  player_assists: 'ast',
  player_threes: 'threes',
  player_blocks: 'blk',
  player_steals: 'stl',
  player_blocks_steals: 'stlBlk',
  player_points_rebounds_assists: 'pra',
  player_points_rebounds: 'pr',
  player_points_assists: 'pa',
  player_rebounds_assists: 'ra',
}
const HOCKEY = {
  player_points: 'hPts',
  player_assists: 'hAst',
  player_goals: 'goals',
  player_shots_on_goal: 'sog',
  player_total_saves: 'saves',
  player_goal_scorer_anytime: 'anyGoal',
}
const BASEBALL = {
  batter_hits: 'hits',
  batter_total_bases: 'tb',
  batter_home_runs: 'hr',
  batter_rbis: 'rbi',
  batter_runs_scored: 'runs',
  batter_hits_runs_rbis: 'hrr',
  batter_singles: 'singles',
  batter_doubles: 'doubles',
  batter_walks: 'bbB',
  batter_strikeouts: 'soB',
  batter_stolen_bases: 'sbB',
  pitcher_strikeouts: 'kP',
  pitcher_outs: 'outs',
  pitcher_earned_runs: 'erP',
  pitcher_hits_allowed: 'haP',
  pitcher_walks: 'bbP',
}
/** APEX league -> The Odds API sport key and the player markets it carries there. */
export const ODDS_SPORTS = {
  nfl: { key: 'americanfootball_nfl', markets: FOOTBALL },
  ncaaf: { key: 'americanfootball_ncaaf', markets: FOOTBALL },
  nba: { key: 'basketball_nba', markets: BASKETBALL },
  ncaab: { key: 'basketball_ncaab', markets: BASKETBALL },
  wnba: { key: 'basketball_wnba', markets: BASKETBALL },
  nhl: { key: 'icehockey_nhl', markets: HOCKEY },
  mlb: { key: 'baseball_mlb', markets: BASEBALL },
}
// Line shopping: every book the feed carries for US player props. Up to ten bookmakers cost the
// same credits as one region. bet365 has no US feed; Fanatics and Caesars need a paid plan.
export const BOOKS = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'fanatics', 'betrivers', 'espnbet']


const decimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a)

/** Only plain https links to the books themselves go to the browser. */
export function safeLink(u) {
  if (typeof u !== 'string' || u.length > 600) return null
  try {
    const url = new URL(u)
    if (url.protocol !== 'https:') return null
    const h = url.hostname.toLowerCase()
    const ok = /(^|\.)(draftkings|fanduel|betmgm|caesars|williamhill|fanatics|betrivers|rushstreetinteractive|thescore|espnbet|bet365)\.(com|bet|us)$/.test(h) || h === 'thescore.bet'
    return ok ? url.toString() : null
  } catch {
    return null
  }
}

export function createOddsApi({ http, store, apiKey, sport = 'nfl', now = () => Date.now(), dailyCredits = Number(process.env.APEX_ODDS_DAILY_CREDITS) || 400, perGameEveryMs = 3 * 3600e3 }) {
  const conf = ODDS_SPORTS[sport] || ODDS_SPORTS.nfl
  const BASE = `https://api.the-odds-api.com/v4/sports/${conf.key}`
  const MARKETS = conf.markets
  // the NFL keeps the keys it always had
  const SNAP = sport === 'nfl' ? 'all' : `all-${sport}`
  // the paid key first, the backup when the API turns the first one down (see keys.js)
  const keys = keyRing(apiKey)
  let events = null
  let eventsAt = 0
  const snapshots = new Map() // espnGameId -> { at, rows }
  let loaded = false
  const state = { spentToday: 0, lastError: null, lastRefresh: 0 }

  async function loadSnapshots() {
    if (loaded || !store) return
    loaded = true
    try {
      const saved = await store.get('oddsprops', SNAP)
      for (const [id, s] of saved || []) snapshots.set(id, s)
    } catch (e) {
      log.warn('odds snapshot load failed', { err: errText(e) })
    }
  }

  /** Reserve credits in the shared counter. Returns false when today's budget is spent. */
  async function spend(cost) {
    if (!store) return true
    const { ok, used } = await takeOddsCredits(store, cost, { pool: sport, daily: dailyCredits, now })
    state.spentToday = used
    return ok
  }

  async function listEvents() {
    if (events && now() - eventsAt < 30 * 60e3) return events
    events = await keys.run((k) => http.getJson(`${BASE}/events?apiKey=${encodeURIComponent(k)}`, { priority: 'background', retries: 1 }))
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
          // "yes only" markets (anytime TD, anytime goal) sit at their fixed line
          const one = APEX_MARKETS[market]?.oneSided
          if (one && /^no$/i.test(o.name)) continue
          const line = one ? APEX_MARKETS[market].fixedLine ?? 0.5 : Number(o.point)
          if (!Number.isFinite(line)) continue
          // the deepest link the book gives: the selection on its bet slip, then the market, then the event
          const link = safeLink(o.link) || safeLink(m.link) || safeLink(b.link) || null
          rows.push({ pid, market, line, side: one ? 'yes' : /under/i.test(o.name) ? 'under' : 'over', price: Number(o.price), book: b.key, link, deep: Boolean(safeLink(o.link)) })
        }
      }
    }
    return rows
  }

  function toPrices() {
    const out = new Map()
    for (const s of snapshots.values()) {
      for (const r of s.rows) {
        if (!Number.isFinite(r.price)) continue
        const key = `${r.pid}:${r.market}:${r.line}`
        const cur = out.get(key) || { books: {} }
        const bk = (cur.books[r.book] ||= {})
        bk[r.side] = r.price
        if (r.link) (bk.links ||= {})[r.side] = r.link
        if (r.deep) (bk.deep ||= {})[r.side] = true
        out.set(key, cur)
      }
    }
    for (const v of out.values()) {
      // headline pair from one book (DraftKings first): the no-vig market math needs both sides
      // from the same book, or the "fair" price would borrow the best of two books
      const order = BOOKS.filter((b) => v.books[b]).concat(Object.keys(v.books).filter((b) => !BOOKS.includes(b)))
      const pick = order.find((b) => v.books[b].over != null && v.books[b].under != null) || order.find((b) => v.books[b].yes != null) || order[0]
      const bk = v.books[pick] || {}
      v.book = pick
      v.over = bk.over ?? null
      v.under = bk.under ?? null
      v.yes = bk.yes ?? null
      // line shopping: the best price on each side across every book
      v.best = {}
      for (const side of ['over', 'under', 'yes']) {
        let top = null
        for (const b of order) {
          const a = v.books[b][side]
          if (a == null) continue
          if (!top || decimal(a) > decimal(top.price)) top = { price: a, book: b }
        }
        if (top) v.best[side] = top
      }
    }
    return out
  }

  return {
    status: () => ({ enabled: true, sport, ...state, games: snapshots.size, budget: dailyCredits, keys: keys.status() }),
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
          const url = (k) => `${BASE}/events/${ev.id}/odds?apiKey=${encodeURIComponent(k)}&oddsFormat=american&markets=${markets.join(',')}&bookmakers=${BOOKS.join(',')}&includeLinks=true`
          const json = await keys.run((k) => http.getJson(url(k), { priority: 'background', retries: 0 }))
          snapshots.set(g.id, { at: now(), rows: parse(g, json, players) })
          changed = true
        } catch (e) {
          state.lastError = errText(e)
        }
      }
      state.lastRefresh = now()
      if (changed && store) {
        try {
          await store.set('oddsprops', SNAP, [...snapshots])
        } catch (e) {
          log.warn('odds snapshot save failed', { err: errText(e) })
        }
      }
      return snapshots.size ? toPrices() : null
    },
  }
}

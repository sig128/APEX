// Read models for the API, memoized by data version so repeated requests are cheap.
import { buildPropRow, buildTeamRow, diverse, cheatsheets, parlays } from '../analytics/props.js'
import { buildDvp } from '../analytics/defense.js'
import { teamForm, teamPointRows, trendLines } from '../analytics/teams.js'
import { parsePropId, marketRows, outcome } from '../analytics/core.js'
import { wilsonLower } from '../../lib/stats.js'
import { MARKETS, marketOf } from '../markets.js'
import * as football from '../../sports/football.js'
import { injurySeverity } from '../../providers/espn/normalize.js'
import { progressFor as progressAt, boxLeaders, winCurve } from './live.js'
import { nameKey, round, mean, median } from '../../lib/util.js'
import { findLock } from '../analytics/lock.js'

export function createViews(engine) {
  const wh = engine.wh
  const S = engine.sport || { key: 'nfl', calendar: 'week', espn: { league: 'nfl' } }
  const fam = S.fam || football
  const CLOCK = fam.clockFor(S.espn?.league)
  const progressFor = (row, g, s) => progressAt(row, g, s, CLOCK)
  const CORE = fam.CORE
  const memo = new Map()
  function cached(key, version, fn) {
    const hit = memo.get(key)
    if (hit && hit.v === version) return hit.value
    const value = fn()
    memo.set(key, { v: version, value })
    if (memo.size > 400) memo.delete(memo.keys().next().value)
    return value
  }

  // ---- context and rows ------------------------------------------------------------------------
  function ctx() {
    return cached('ctx', wh.aVersion, () => {
      const season = engine.season()
      const injuriesByTeam = new Map()
      for (const [tid, list] of wh.injuries) injuriesByTeam.set(tid, list)
      const dvp = buildDvp({ logs: wh.logs, players: wh.players, season, fam })
      return { players: wh.players, logs: wh.logs, dvp, injuriesByTeam, prices: wh.priceMap ? wh.priceMap() : wh.prices, season, lastSeason: season - 1, teamAbbr: wh.teamAbbr, fam, sport: S.key }
    })
  }

  function gameForTeam(teamId) {
    for (const g of wh.games.values()) if (g.home?.id === teamId || g.away?.id === teamId) return g
    return null
  }

  function rowsForGame(g) {
    const c = ctx()
    const lines = wh.lines.get(g.id)?.props || []
    const rows = []
    let pending = 0
    for (const l of lines) {
      if (l.athleteId) {
        const player = wh.players.get(l.athleteId)
        if (!player) {
          pending++
          continue
        }
        const sev = injurySeverity(wh.injuryOf(player.id)?.status)
        if (sev === 'out') continue
        const row = buildPropRow({ player, market: l.market, line: l.line, game: g, ctx: c, meta: { main: l.line, open: l.open, alts: l.alts, book: l.book, updated: l.updated } })
        if (row?.pending) pending++
        else if (row) rows.push(row)
      } else if (l.teamId && l.market === 'teamPts') {
        const team = wh.teams.get(l.teamId)
        const sched = wh.schedules.get(l.teamId)?.games
        if (!team || !sched) continue
        const row = buildTeamRow({ team, line: l.line, game: g, schedule: sched, ctx: c, meta: { main: l.line, alts: l.alts, open: l.open } })
        if (row) rows.push(row)
      }
    }
    return { rows, pending }
  }

  function allRows() {
    return cached('rows', wh.aVersion, () => {
      const rows = []
      let pending = 0
      for (const g of wh.games.values()) {
        const r = rowsForGame(g)
        rows.push(...r.rows)
        pending += r.pending
      }
      const byId = new Map(rows.map((r) => [r.id, r]))
      const byGame = new Map()
      for (const r of rows) {
        if (!byGame.has(r.gameId)) byGame.set(r.gameId, [])
        byGame.get(r.gameId).push(r)
      }
      return { rows, pending, byId, byGame }
    })
  }

  /** One game's rows, from the shared memo (live score changes don't rebuild analytics). */
  const gameRows = (id) => allRows().byGame.get(String(id)) || []

  // ---- shapes ----------------------------------------------------------------------------------
  const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th']
  /** The game clock the way each sport says it: "Q3 5:21", "H2 4:10", "2nd 12:33", "Top 5th". */
  function clockText(st) {
    if (!st || st.state !== 'in') return null
    if (st.halftime) return 'Halftime'
    if (S.family === 'baseball' || st.name === 'STATUS_END_PERIOD') return st.short || null
    const p = st.period || 0
    const c = st.clock && st.clock !== '0:00' ? ` ${st.clock}` : ''
    const n = CLOCK.periods
    if (p > n) return S.family === 'hockey' ? st.short || `OT${c}` : `${p - n > 1 ? p - n : ''}OT${c}`
    if (S.family === 'hockey') return `${ORD[p] || `P${p}`}${c}`
    return `${n === 2 ? 'H' : 'Q'}${p}${c}`
  }
  const statusOut = (st) => (st && st.state === 'in' ? { ...st, text: clockText(st) } : st)
  const gameCard = (g) => ({
    id: g.id,
    date: g.date,
    shortName: g.shortName,
    status: statusOut(g.status),
    home: g.home && { id: g.home.id, abbr: g.home.abbr, name: g.home.name, short: g.home.short, logo: g.home.logo, color: g.home.color, score: g.home.score, record: g.home.record?.total || null },
    away: g.away && { id: g.away.id, abbr: g.away.abbr, name: g.away.name, short: g.away.short, logo: g.away.logo, color: g.away.color, score: g.away.score, record: g.away.record?.total || null },
    broadcast: g.broadcast,
    odds: g.odds && { details: g.odds.details, total: g.odds.total, homeSpread: g.odds.homeSpread, homeMl: g.odds.homeMl, awayMl: g.odds.awayMl },
    situation: g.situation && { text: g.situation.text, possessionAbbr: g.situation.possessionAbbr, redZone: g.situation.redZone, possessionText: g.situation.possessionText },
  })

  /** Compact prop for lists: enough for a row with sparkline bars. */
  const card = (r) =>
    r && {
      id: r.id,
      sport: S.key,
      kind: r.kind,
      playerId: r.playerId || null,
      teamId: r.teamId,
      name: r.name,
      short: r.short,
      pos: r.pos || null,
      headshot: r.headshot || null,
      logo: r.logo || null,
      teamAbbr: r.teamAbbr,
      oppAbbr: r.oppAbbr,
      home: r.home,
      gameId: r.gameId,
      kickoff: r.kickoff,
      market: r.market,
      marketLabel: r.marketLabel,
      label: r.label,
      shortLabel: r.shortLabel,
      line: r.line,
      side: r.side,
      oneSided: r.oneSided || false,
      prob: r.prob,
      fair: r.fair,
      score: r.score,
      rank: r.rank ?? r.score,
      role: r.role ?? 1,
      proj: r.proj,
      streak: r.streak,
      best: r.best,
      l5: r.windows.find((w) => w.key === 'L5') || null,
      l10: r.windows.find((w) => w.key === 'L10') || null,
      spark: r.recent.slice(-10).map((x) => [x.v, x.o === 'hit' ? 1 : x.o === 'push' ? 2 : 0]),
      move: r.move,
      boost: r.boost ? { short: r.boost.short, lift: r.boost.lift } : null,
      matchupRank: r.matchup?.rank ?? null,
      price: r.price ? { over: r.price.over, under: r.price.under, yes: r.price.yes, book: r.price.book } : null,
      // line shopping: the best price on this side, and where
      shop: r.price?.best?.[r.oneSided ? 'yes' : r.side === 'u' ? 'under' : 'over'] || null,
      edge: r.edge ?? null,
      posted: r.posted ?? null,
      // the bottom line and the most telling note, for lists (the prop page has them all)
      read: r.read || null,
      note: r.notes?.[0] || null,
      // when someone picks it: the strongest reason for it and the biggest one against
      pro: r.notes?.find((n) => n.tone === 'for') || null,
      con: r.notes?.find((n) => n.tone === 'against') || null,
    }

  function strip() {
    return cached('strip', wh.version, () => ({ sport: S.key, calendar: S.calendar, week: wh.week, season: wh.season, games: [...wh.games.values()].map(gameCard), at: wh.at.scoreboard || null }))
  }

  // ---- the week -------------------------------------------------------------------------------
  function home() {
    return cached('home', `${wh.aVersion}:${wh.version}`, () => {
      const { rows, pending } = allRows()
      const upcoming = rows.filter((r) => wh.games.get(r.gameId)?.status.state === 'pre')
      const players = upcoming.filter((r) => r.kind === 'player')
      const roles = players.filter((r) => r.role >= 0.6)
      const tabs = {
        apex: diverse(roles, { limit: 20, perPlayer: 1, perGame: 4 }).map(card),
        streaks: diverse(roles.filter((r) => r.streak >= 5 && r.fit >= 0.85), { limit: 15, perPlayer: 1, perGame: 5, key: (r) => r.streak * 100 + r.rank }).map(card),
        matchups: diverse(roles.filter((r) => r.matchup && r.fit >= 0.85 && ((r.side === 'o' && r.matchup.rank <= 6) || (r.side === 'u' && r.matchup.rank > r.matchup.of - 6))), { limit: 15, perPlayer: 1, perGame: 4 }).map(card),
        moves: diverse(roles.filter((r) => r.move && r.line >= 2 && Math.abs(r.move.delta) >= Math.max(1, r.line * 0.04)), { limit: 15, perPlayer: 1, perGame: 5, key: (r) => (Math.abs(r.move.delta) / Math.max(1, r.line)) * 1000 + r.rank }).map(card),
        [fam.SPECIAL_TAB.key]: diverse(players.filter(fam.SPECIAL_TAB.filter), { limit: 15, perPlayer: 1, perGame: 6, key: (r) => r.prob * 1000 }).map(card),
      }
      // each cheatsheet row carries the window that earned it its place (e.g. 4/4 vs this team)
      const sheetWin = (key, r) => {
        const w = (k) => r.windows.find((x) => x.key === k)
        if (key === 'form') return w('L10')?.n >= 6 && w('L10').hits === w('L10').n ? w('L10') : w('L5')
        return w(key) || null
      }
      const sheets = cheatsheets(upcoming).map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...card(r), win: sheetWin(s.key, r) })) }))
      const live = [...wh.games.values()].filter((g) => g.status.state === 'in').length
      return {
        sport: S.key,
        calendar: S.calendar,
        slate: engine.slate ? engine.slate() : wh.week,
        special: { key: fam.SPECIAL_TAB.key, label: fam.SPECIAL_TAB.label },
        season: wh.season,
        week: wh.week,
        games: strip().games,
        counts: { games: wh.games.size, props: rows.length, live, pending },
        tabs,
        cheatsheets: sheets,
        parlays: parlays(upcoming.filter((r) => r.kind === 'player')).map((p) => ({ ...p, cards: p.legs.map((id) => card(allRows().byId.get(id))) })),
        at: { scoreboard: wh.at.scoreboard || null, lines: wh.at.lines || null, logs: wh.at.logs || null },
      }
    })
  }

  // ---- props explorer ---------------------------------------------------------------------------
  function props(q = {}) {
    const { rows, pending } = allRows()
    const markets = String(q.market || 'core')
    const wantMarkets = markets === 'all' ? null : markets === 'core' ? new Set(CORE) : new Set(markets.split(',').filter((m) => fam.MARKETS[m]))
    const kind = q.kind === 'teams' ? 'team' : 'player'
    const pos = q.pos ? new Set(String(q.pos).toUpperCase().split(',')) : null
    const side = q.side === 'o' || q.side === 'u' ? q.side : null
    const win = ['L5', 'L10', 'L20', 'season', 'last', 'h2h', 'venue'].includes(q.window) ? q.window : 'L10'
    const minHit = Math.max(0, Math.min(1, Number(q.minHit) || 0))
    const game = q.game ? new Set(String(q.game).split(',').filter((x) => /^\d{6,12}$/.test(x)).slice(0, 16)) : null
    const name = q.q ? nameKey(q.q) : ''
    // every filter but the bet type and the side, so each bet type and side can say how many
    // props it would show with the rest of the filters as they are
    const base = rows.filter((r) => {
      if (r.kind !== kind) return false
      if (pos && !pos.has(fam.posGroup(r.pos))) return false
      if (game && game.size && !game.has(r.gameId)) return false
      if (name && !nameKey(r.name).includes(name)) return false
      if (!name && q.all !== '1' && (r.role ?? 1) < 0.45) return false
      if (minHit > 0) {
        const w = r.windows.find((x) => x.key === win)
        if (!w || !w.n || w.hits / w.n < minHit) return false
      }
      const st = wh.games.get(r.gameId)?.status.state
      if (q.live !== '1' && st && st !== 'pre') return false
      return true
    })
    const marketOk = (r) => kind !== 'player' || !wantMarkets || wantMarkets.has(r.market)
    const perMarket = {}
    const perSide = { o: 0, u: 0 }
    let core = 0
    for (const r of base) {
      if (!side || r.side === side) {
        perMarket[r.market] = (perMarket[r.market] || 0) + 1
        if (CORE.includes(r.market)) core++
      }
      if (marketOk(r) && (r.side === 'o' || r.side === 'u')) perSide[r.side]++
    }
    let list = base.filter((r) => marketOk(r) && (!side || r.side === side))
    // Sort by one number, highest first (start time: earliest first); dir flips it. Props
    // without that number (no price, no sample) stay at the bottom either way, and ties go to
    // the better APEX read.
    const SORT = {
      score: (r) => r.rank ?? r.score,
      prob: (r) => r.prob,
      hit: (r) => (rate(r, win) >= 0 ? rate(r, win) : null),
      streak: (r) => r.streak ?? 0,
      move: (r) => Math.abs(r.move?.delta || 0),
      edge: (r) => (Number.isFinite(r.edge) ? r.edge : null),
      line: (r) => (Number.isFinite(r.line) ? r.line : null),
      kickoff: (r) => (Date.parse(r.kickoff) || null),
    }
    const sortKey = Object.hasOwn(SORT, q.sort) ? q.sort : 'score'
    const natural = sortKey === 'kickoff' ? 'asc' : 'desc'
    const dir = q.dir === 'asc' || q.dir === 'desc' ? q.dir : natural
    const metric = SORT[sortKey]
    const better = (a, b) => (b.rank ?? b.score) - (a.rank ?? a.score) || b.score - a.score
    list.sort((a, b) => {
      const x = metric(a)
      const y = metric(b)
      if (x == null || y == null) return x == null && y == null ? better(a, b) : x == null ? 1 : -1
      return (dir === 'asc' ? x - y : y - x) || better(a, b)
    })
    const total = list.length
    const offset = Math.max(0, Number(q.offset) || 0)
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 40))
    list = list.slice(offset, offset + limit)
    return {
      total,
      // props on games still to start, before any filter (0 = nothing posted yet)
      available: rows.filter((r) => r.kind === kind && wh.games.get(r.gameId)?.status.state === 'pre').length,
      // lines whose players' game logs are still loading (a fresh server fills these in)
      pending,
      offset,
      limit,
      window: win,
      sort: sortKey,
      dir,
      rows: list.map((r) => ({ ...card(r), win: r.windows.find((w) => w.key === win) || null })),
      facets: {
        // count: props of that bet type the other filters let through (the side included)
        markets: Object.entries(fam.MARKETS).map(([k, m]) => ({ key: k, label: m.label, core: CORE.includes(k), count: perMarket[k] || 0 })),
        marketTotals: { core, all: Object.values(perMarket).reduce((s, n) => s + n, 0) },
        sides: perSide,
        groups: fam.GROUPS.map((g) => ({ key: g, label: fam.GROUP_NAMES?.[g] || g })),
        games: [...wh.games.values()].filter((g) => g.status.state === 'pre').map((g) => ({ id: g.id, label: g.shortName, date: g.date })),
      },
    }
  }

  function rate(r, win) {
    const w = r.windows.find((x) => x.key === win)
    return w && w.n ? w.hits / w.n : -1
  }

  // ---- one game -------------------------------------------------------------------------------
  function game(id) {
    const g = wh.games.get(String(id))
    if (!g) return null
    return cached(`game:${id}`, `${wh.aVersion}:${wh.version}`, () => {
      const s = wh.summaries.get(g.id)?.data || null
      const rows = gameRows(g.id)
      const side = (t) => {
        const sched = wh.schedules.get(t.id)?.games || []
        const form = teamForm(sched, { home: t.id === g.home.id })
        const pts = teamPointRows(sched)
        const tt = (wh.lines.get(g.id)?.props || []).find((l) => l.teamId === t.id && l.market === 'teamPts')?.line ?? null
        const spread = g.odds?.homeSpread != null ? (t.id === g.home.id ? g.odds.homeSpread : -g.odds.homeSpread) : null
        return {
          team: { id: t.id, abbr: t.abbr, name: t.name, short: t.short, logo: t.logo, color: t.color, record: t.record },
          form,
          trends: trendLines({ team: t, form, rows: pts, total: g.odds?.total ?? null, teamTotal: tt, spread }),
          lastFive: s?.lastFive?.[t.id] || null,
          leaders: s?.leaders?.[t.id] || [],
          injuries: (wh.injuries.get(t.id) || []).map((i) => ({ ...i, severity: injurySeverity(i.status), boosts: boostsFrom(rows, i.athleteId) })),
          implied: g.odds?.total != null && spread != null ? round(g.odds.total / 2 - spread / 2, 1) : null,
        }
      }
      const playerRows = rows.filter((r) => r.kind === 'player').sort((a, b) => b.rank - a.rank || b.score - a.score)
      return {
        game: gameCard(g),
        venue: g.venue || s?.venue || null,
        weather: s?.weather || g.weather || null,
        odds: s?.odds || g.odds || null,
        predictor: s?.predictor || null,
        home: side(g.home),
        away: side(g.away),
        props: playerRows.map(card),
        teamProps: rows.filter((r) => r.kind === 'team').map(card),
        parlays: parlays(playerRows, { gameId: g.id, sizes: [2, 3], count: 2, minScore: 75 }).map((p) => ({ ...p, cards: p.legs.map((lid) => card(rows.find((r) => r.id === lid))) })),
        live: g.status.state !== 'pre' ? liveGame(g.id) : null,
      }
    })
  }

  function boostsFrom(rows, teammateId) {
    return rows.filter((r) => r.boost?.teammateId === teammateId).slice(0, 4).map((r) => ({ id: r.id, short: r.short, label: r.shortLabel, lift: r.boost.lift }))
  }

  // ---- live -------------------------------------------------------------------------------------
  function liveGame(id) {
    const g = wh.games.get(String(id))
    if (!g) return null
    return cached(`live:${id}`, wh.version, () => {
      const s = wh.summaries.get(g.id)?.data || null
      const rows = gameRows(g.id)
      const tracked = rows
        .map((r) => ({ r, p: progressFor(r, g, s) }))
        .filter((x) => x.p && !x.p.untracked)
        .sort((a, b) => order(a.p.status) - order(b.p.status) || b.r.score - a.r.score)
      return {
        id: g.id,
        status: statusOut(g.status),
        home: gameCard(g).home,
        away: gameCard(g).away,
        situation: g.situation,
        drive: s?.drive || null,
        lastDrive: s?.lastDrive || null,
        winProb: winCurve(s),
        homeWinPct: s?.homeWinPct ?? null,
        leaders: s ? { [g.home.id]: boxLeaders(s, g.home.id), [g.away.id]: boxLeaders(s, g.away.id) } : {},
        scoring: (s?.scoring || []).slice(-6),
        props: tracked.slice(0, 160).map(({ r, p }) => ({ ...card(r), live: p })),
      }
    })
  }

  const ORDER = { at_risk: 0, behind: 1, on_pace: 2, hit: 3, push: 4, miss: 5 }
  const order = (s) => ORDER[s] ?? 9

  function live() {
    return cached('liveall', wh.version, () => {
      const gs = [...wh.games.values()].filter((g) => g.status.state === 'in' || (g.status.state === 'post' && Date.parse(g.date) > engine.now() - 30 * 3600e3))
      return { games: gs.map((g) => liveGame(g.id)), at: wh.at.summaries || null }
    })
  }

  let lastTracker = new Map()
  /** Changed live prop values since the last call (for the tracker stream). */
  function trackerDiff() {
    const diff = {}
    const next = new Map()
    for (const g of wh.games.values()) {
      if (g.status.state !== 'in' && g.status.state !== 'post') continue
      const s = wh.summaries.get(g.id)?.data
      for (const r of gameRows(g.id)) {
        const p = progressFor(r, g, s)
        if (!p || p.untracked) continue
        const sig = `${p.cur}|${p.status}`
        next.set(r.id, sig)
        if (lastTracker.get(r.id) !== sig) diff[r.id] = p
      }
    }
    lastTracker = next
    return diff
  }

  /** Slip tracking: rows for any prop ids, with live progress when their game has started. */
  function track(ids) {
    const out = []
    for (const raw of ids.slice(0, 40)) {
      const row = findProp(raw)
      if (!row) {
        out.push({ id: raw, missing: true })
        continue
      }
      const g = wh.games.get(row.gameId)
      const s = g ? wh.summaries.get(g.id)?.data : null
      out.push({ ...card(row), game: g ? gameCard(g) : null, live: g ? progressFor(row, g, s) : null })
    }
    return { legs: out, at: wh.at.summaries || wh.at.scoreboard || null }
  }

  // ---- player and prop pages ------------------------------------------------------------------
  /** Any prop id, including alternate lines and the other side. */
  function findProp(id) {
    const p = parsePropId(id)
    if (!p) return null
    const hit = allRows().byId.get(p.id)
    if (hit) return hit
    return cached(`find:${p.id}`, wh.aVersion, () => {
      if (p.teamId) {
        const team = wh.teams.get(p.teamId)
        const sched = wh.schedules.get(p.teamId)?.games
        if (!team || !sched) return null
        const tg = gameForTeam(p.teamId)
        const tl = tg ? (wh.lines.get(tg.id)?.props || []).find((x) => !x.athleteId && x.teamId === p.teamId && x.market === p.market) : null
        return buildTeamRow({ team, line: p.line, side: p.side, game: tg, schedule: sched, ctx: ctx(), meta: tl ? { main: tl.line, alts: tl.alts, open: tl.line === p.line ? tl.open : null } : {} })
      }
      const player = wh.players.get(p.playerId)
      if (!player) return null
      const g = gameForTeam(player.teamId)
      const l = g ? (wh.lines.get(g.id)?.props || []).find((x) => x.athleteId === player.id && x.market === p.market) : null
      const row = buildPropRow({ player, market: p.market, line: p.line, side: p.side, game: g, ctx: ctx(), meta: l ? { main: l.line, open: l.line === p.line ? l.open : null, alts: l.alts, book: l.book, updated: l.updated } : {} })
      return row && !row.pending ? row : null
    })
  }

  function prop(id) {
    const row = findProp(id)
    if (!row) return null
    const g = row.gameId ? wh.games.get(row.gameId) : null
    const others = allRows().rows.filter((r) => r.kind === row.kind && (row.kind === 'player' ? r.playerId === row.playerId : r.teamId === row.teamId) && r.id !== row.id).sort((a, b) => b.score - a.score)
    const altRows = (row.alts || [])
      .slice(0, 6)
      .map((line) => findProp(`${row.kind === 'team' ? `t${row.teamId}` : row.playerId}.${row.market}.${row.side}.${line}`))
      .filter(Boolean)
      .map((r) => ({ id: r.id, line: r.line, prob: r.prob, fair: r.fair, score: r.score }))
    const injury = row.playerId ? wh.injuryOf(row.playerId) : null
    return {
      prop: row,
      game: g ? gameCard(g) : null,
      injury,
      others: others.slice(0, 12).map(card),
      alts: altRows,
      live: g && g.status.state !== 'pre' ? progressFor(row, g, wh.summaries.get(g.id)?.data) : null,
    }
  }

  function player(id) {
    const p = wh.players.get(String(id))
    if (!p) return null
    return cached(`player:${id}`, wh.aVersion, () => {
      const g = gameForTeam(p.teamId)
      const rows = allRows().rows.filter((r) => r.playerId === p.id).sort((a, b) => b.score - a.score)
      const logs = (wh.logs.get(p.id) || []).slice(-20).reverse()
      const team = wh.teams.get(p.teamId) || null
      const markets = new Set(rows.map((r) => r.market))
      const group = fam.posGroup(p.pos)
      const cols = fam.LOG_COLS(group)
      return {
        player: { id: p.id, name: p.name, short: p.short, pos: p.pos, jersey: p.jersey, headshot: p.headshot, teamId: p.teamId, team: team && { id: team.id, abbr: team.abbr, name: team.name, logo: team.logo, color: team.color } },
        injury: wh.injuryOf(p.id),
        next: g ? gameCard(g) : null,
        props: rows.map(card),
        markets: [...markets],
        log: { cols, labels: fam.STAT_LABELS || null, rows: logs.map((r) => ({ id: r.eventId, date: r.date, opp: r.oppAbbr, home: r.home, result: r.result, score: r.score, season: r.season, s: Object.fromEntries(cols.map((c) => [c, r.s?.[c] ?? null])) })) },
      }
    })
  }

  // ---- search, defense, rankings --------------------------------------------------------------
  function search(q) {
    const k = nameKey(q)
    if (k.length < 2) return { players: [], teams: [] }
    const { rows } = allRows()
    const withProps = new Set(rows.map((r) => r.playerId).filter(Boolean))
    const players = [...wh.players.values()]
      .filter((p) => nameKey(p.name).includes(k))
      .sort((a, b) => Number(withProps.has(b.id)) - Number(withProps.has(a.id)) || nameKey(a.name).indexOf(k) - nameKey(b.name).indexOf(k))
      .slice(0, 8)
      .map((p) => ({ id: p.id, name: p.name, pos: p.pos, teamAbbr: wh.teamAbbr(p.teamId), headshot: p.headshot, hasProps: withProps.has(p.id) }))
    const teams = [...wh.teams.values()].filter((t) => nameKey(t.name).includes(k) || t.abbr?.toLowerCase() === k).slice(0, 4).map((t) => ({ id: t.id, abbr: t.abbr, name: t.name, logo: t.logo, gameId: gameForTeam(t.id)?.id || null }))
    return { players, teams }
  }

  function dvp() {
    return cached('dvp', wh.aVersion, () => {
      const d = ctx().dvp
      const out = {}
      for (const group of Object.keys(fam.DVP_STATS)) {
        out[group] = {}
        for (const stat of Object.keys(d.league[group] || {})) {
          out[group][stat] = Object.entries(d.byDef)
            .filter(([, x]) => x[group]?.[stat]?.rank)
            .map(([def, x]) => ({ teamId: def, abbr: wh.teamAbbr(def), rank: x[group][stat].rank, perGame: round(x[group][stat].perGame, 1), games: x[group][stat].games }))
            .sort((a, b) => a.rank - b.rank)
        }
      }
      return { groups: out, league: d.league, labels: Object.fromEntries(Object.entries(fam.MARKETS).map(([k, m]) => [k, m.label])), groupNames: fam.GROUP_NAMES || null }
    })
  }

  function rankings() {
    return cached('rankings', wh.aVersion, () => {
      const { rows } = allRows()
      const pre = rows.filter((r) => r.kind === 'player' && wh.games.get(r.gameId)?.status.state === 'pre')
      return Object.fromEntries(CORE.map((m) => [m, diverse(pre.filter((r) => r.market === m), { limit: 10, perPlayer: 1, perGame: 3 }).map(card)]))
    })
  }

  function teamProps(teamId) {
    const { rows } = allRows()
    return rows.filter((r) => r.teamId === teamId && r.kind === 'team').map(card)
  }

  /** Data the AI read of a prop gets as context. */
  function propContext(id) {
    const data = prop(id)
    if (!data) return null
    const r = data.prop
    const g = data.game
    const logs = r.kind === 'player' ? marketRows(wh.logs.get(r.playerId) || [], r.market).slice(-12) : []
    return { ...data, logs: logs.map((x) => ({ date: x.date?.slice(0, 10), opp: x.oppAbbr, home: x.home, v: x.v })), gameInfo: g }
  }

  // ---- head to head -----------------------------------------------------------------------------
  /**
   * One game through the matchup: each prop ranked by how the player has done against this
   * opponent (two seasons of logs, 2+ meetings), blended with the APEX probability, plus the
   * recent meetings between the teams.
   */
  function h2h(id) {
    const g = wh.games.get(String(id))
    if (!g) return null
    return cached(`h2h:${g.id}`, wh.aVersion, () => {
      const out = []
      for (const r of gameRows(g.id)) {
        if (r.kind !== 'player' || !r.oppId) continue
        const games = marketRows(wh.logs.get(r.playerId) || [], r.market).filter((x) => x.oppId === r.oppId)
        const res = games.map((x) => ({ date: x.date ? String(x.date).slice(0, 10) : null, season: x.season, v: x.v, o: outcome(x.v, r.line, r.side) }))
        const graded = res.filter((x) => x.o === 'hit' || x.o === 'miss')
        if (graded.length < 2) continue
        const hits = graded.filter((x) => x.o === 'hit').length
        const vals = games.map((x) => x.v)
        const wl = wilsonLower(hits, graded.length)
        out.push({ ...card(r), h2h: { hits, n: graded.length, avg: round(mean(vals), 1), median: median(vals), games: res.slice(-6) }, h2hScore: round(0.6 * wl + 0.4 * r.prob, 4) })
      }
      out.sort((a, b) => b.h2hScore - a.h2hScore || b.prob - a.prob)
      // the two teams' meetings, from the players' logs (two seasons), home team's view
      const seen = new Map()
      for (const logs of wh.logs.values()) {
        for (const x of logs) {
          if (seen.has(x.eventId) || !x.score) continue
          const homeSide = x.teamId === g.home.id && x.oppId === g.away.id
          const awaySide = x.teamId === g.away.id && x.oppId === g.home.id
          if (!homeSide && !awaySide) continue
          const [a, b] = String(x.score).split('-').map(Number)
          if (!Number.isFinite(a) || !Number.isFinite(b)) continue
          // the log's score is "31-24" from either side; the result says which number is theirs
          const mine = x.result === 'W' ? Math.max(a, b) : x.result === 'L' ? Math.min(a, b) : a
          const theirs = a + b - mine
          const homePts = homeSide ? mine : theirs
          const awayPts = homeSide ? theirs : mine
          seen.set(x.eventId, { id: x.eventId, date: x.date ? String(x.date).slice(0, 10) : null, season: x.season, home: homePts, away: awayPts, winner: homePts > awayPts ? g.home.abbr : awayPts > homePts ? g.away.abbr : null })
        }
      }
      const meetings = [...seen.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 6)
      return { game: gameCard(g), rows: out.slice(0, 80), total: out.length, meetings }
    })
  }

  // ---- the 3-Leg Lock ----------------------------------------------------------------------------
  /**
   * Every prop on games that haven't kicked off, plus the posted alternate lines on the same
   * side that are easier to clear (a lower over, a higher under).
   */
  function lockRows() {
    const t = engine.now()
    const open = new Set([...wh.games.values()].filter((g) => g.status?.state === 'pre' && Date.parse(g.date) - t > 5 * 60_000).map((g) => g.id))
    const rows = allRows().rows.filter((r) => open.has(r.gameId))
    const out = [...rows]
    for (const r of rows) {
      if (r.oneSided || !(r.prob >= 0.5) || !r.alts?.length) continue
      const subject = r.kind === 'team' ? `t${r.teamId}` : r.playerId
      const easier = r.alts.filter((x) => (r.side === 'u' ? x > r.line : x < r.line)).slice(0, 4)
      for (const line of easier) {
        const alt = findProp(`${subject}.${r.market}.${r.side}.${line}`)
        if (alt) out.push(alt)
      }
    }
    return out
  }

  /** The week's lock, recomputed when the data moves (and at least every 15 minutes for recency). */
  function lock() {
    const t = engine.now()
    return cached('lock', `${wh.aVersion}:${Math.floor(t / (15 * 60_000))}`, () => {
      const out = findLock(lockRows(), { now: t, injuryOf: (id) => wh.injuryOf(id) })
      if (out.lock) out.lock.legs = out.lock.legs.map((l) => ({ ...l, sport: S.key }))
      return { ...out, sport: S.key, calendar: S.calendar, season: wh.season, week: engine.slate ? engine.slate() : wh.week, at: t }
    })
  }

  return { ctx, allRows, strip, home, props, game, liveGame, live, trackerDiff, track, findProp, prop, player, search, dvp, rankings, teamProps, propContext, card, lockRows, lock, h2h }
}

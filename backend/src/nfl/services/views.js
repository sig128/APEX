// Read models for the API, memoized by data version so repeated requests are cheap.
import { buildPropRow, buildTeamRow, diverse, cheatsheets, parlays } from '../analytics/props.js'
import { buildDvp, DVP_GROUPS } from '../analytics/defense.js'
import { teamForm, teamPointRows, trendLines } from '../analytics/teams.js'
import { parsePropId, marketRows } from '../analytics/core.js'
import { MARKETS, CORE_MARKETS, marketOf, POS_GROUP } from '../markets.js'
import { injurySeverity } from '../../providers/espn/normalize.js'
import { progressFor, boxLeaders, winCurve } from './live.js'
import { nameKey, round } from '../../lib/util.js'
import { findLock } from '../analytics/lock.js'

export function createViews(engine) {
  const wh = engine.wh
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
      const dvp = buildDvp({ logs: wh.logs, players: wh.players, season })
      return { players: wh.players, logs: wh.logs, dvp, injuriesByTeam, prices: wh.prices, season, lastSeason: season - 1, teamAbbr: wh.teamAbbr }
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
  const gameCard = (g) => ({
    id: g.id,
    date: g.date,
    shortName: g.shortName,
    status: g.status,
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
    }

  function strip() {
    return cached('strip', wh.version, () => ({ week: wh.week, season: wh.season, games: [...wh.games.values()].map(gameCard), at: wh.at.scoreboard || null }))
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
        tds: diverse(players.filter((r) => r.market === 'anyTd'), { limit: 15, perPlayer: 1, perGame: 6, key: (r) => r.prob * 1000 }).map(card),
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
    const { rows } = allRows()
    const markets = String(q.market || 'core')
    const wantMarkets = markets === 'all' ? null : markets === 'core' ? new Set(CORE_MARKETS) : new Set(markets.split(',').filter((m) => marketOf(m)))
    const kind = q.kind === 'teams' ? 'team' : 'player'
    const pos = q.pos ? new Set(String(q.pos).toUpperCase().split(',')) : null
    const side = q.side === 'o' || q.side === 'u' ? q.side : null
    const win = ['L5', 'L10', 'L20', 'season', 'last', 'h2h', 'venue'].includes(q.window) ? q.window : 'L10'
    const minHit = Math.max(0, Math.min(1, Number(q.minHit) || 0))
    const game = q.game ? String(q.game) : null
    const name = q.q ? nameKey(q.q) : ''
    let list = rows.filter((r) => {
      if (r.kind !== kind) return false
      if (kind === 'player' && wantMarkets && !wantMarkets.has(r.market)) return false
      if (pos && !pos.has(POS_GROUP(r.pos))) return false
      if (side && r.side !== side) return false
      if (game && r.gameId !== game) return false
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
    const sorters = {
      score: (a, b) => (b.rank ?? b.score) - (a.rank ?? a.score) || b.score - a.score,
      prob: (a, b) => b.prob - a.prob,
      hit: (a, b) => rate(b, win) - rate(a, win) || (b.rank ?? 0) - (a.rank ?? 0),
      streak: (a, b) => b.streak - a.streak || b.score - a.score,
      move: (a, b) => Math.abs(b.move?.delta || 0) - Math.abs(a.move?.delta || 0),
      edge: (a, b) => (b.edge ?? -1) - (a.edge ?? -1),
      kickoff: (a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || b.score - a.score,
    }
    list.sort(sorters[q.sort] || sorters.score)
    const total = list.length
    const offset = Math.max(0, Number(q.offset) || 0)
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 40))
    list = list.slice(offset, offset + limit)
    return {
      total,
      offset,
      limit,
      window: win,
      rows: list.map((r) => ({ ...card(r), win: r.windows.find((w) => w.key === win) || null })),
      facets: {
        markets: Object.entries(MARKETS).map(([k, m]) => ({ key: k, label: m.label, core: CORE_MARKETS.includes(k) })),
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
        status: g.status,
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
      const group = POS_GROUP(p.pos)
      const cols = group === 'QB' ? ['passCmp', 'passAtt', 'passYds', 'passTd', 'passInt', 'rushAtt', 'rushYds'] : group === 'RB' ? ['rushAtt', 'rushYds', 'rushTd', 'rec', 'recYds', 'targets'] : group === 'WR' || group === 'TE' ? ['rec', 'targets', 'recYds', 'recTd', 'longRec'] : group === 'K' ? ['fgMade', 'xpMade', 'kickPts'] : ['tackles', 'solo', 'sacks']
      return {
        player: { id: p.id, name: p.name, short: p.short, pos: p.pos, jersey: p.jersey, headshot: p.headshot, teamId: p.teamId, team: team && { id: team.id, abbr: team.abbr, name: team.name, logo: team.logo, color: team.color } },
        injury: wh.injuryOf(p.id),
        next: g ? gameCard(g) : null,
        props: rows.map(card),
        markets: [...markets],
        log: { cols, rows: logs.map((r) => ({ id: r.eventId, date: r.date, opp: r.oppAbbr, home: r.home, result: r.result, score: r.score, season: r.season, s: Object.fromEntries(cols.map((c) => [c, r.s?.[c] ?? null])) })) },
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
      for (const group of DVP_GROUPS) {
        out[group] = {}
        for (const stat of Object.keys(d.league[group] || {})) {
          out[group][stat] = Object.entries(d.byDef)
            .filter(([, x]) => x[group]?.[stat]?.rank)
            .map(([def, x]) => ({ teamId: def, abbr: wh.teamAbbr(def), rank: x[group][stat].rank, perGame: round(x[group][stat].perGame, 1), games: x[group][stat].games }))
            .sort((a, b) => a.rank - b.rank)
        }
      }
      return { groups: out, league: d.league, labels: Object.fromEntries(Object.entries(MARKETS).map(([k, m]) => [k, m.label])) }
    })
  }

  function rankings() {
    return cached('rankings', wh.aVersion, () => {
      const { rows } = allRows()
      const pre = rows.filter((r) => r.kind === 'player' && wh.games.get(r.gameId)?.status.state === 'pre')
      return Object.fromEntries(CORE_MARKETS.map((m) => [m, diverse(pre.filter((r) => r.market === m), { limit: 10, perPlayer: 1, perGame: 3 }).map(card)]))
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
      return { ...out, season: wh.season, week: wh.week, at: t }
    })
  }

  return { ctx, allRows, strip, home, props, game, liveGame, live, trackerDiff, track, findProp, prop, player, search, dvp, rankings, teamProps, propContext, card, lockRows, lock }
}

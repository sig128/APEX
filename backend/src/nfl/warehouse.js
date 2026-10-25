// In-memory state for the current NFL week, plus snapshot/restore for the persistent store.
import { injurySeverity } from '../providers/espn/normalize.js'

export function createWarehouse() {
  const w = {
    version: 0,
    aVersion: 0, // bumps when anything the prop analytics read changes (not live box scores)
    season: null,
    seasonType: null,
    week: null,
    games: new Map(),
    summaries: new Map(), // id -> { data, at }
    teams: new Map(),
    rosters: new Map(), // teamId -> { at }
    players: new Map(),
    schedules: new Map(), // teamId -> { games, at, season }
    logs: new Map(), // playerId -> rows (all loaded seasons, oldest first)
    logMeta: new Map(), // playerId -> { [season]: fetchedAt }
    lines: new Map(), // gameId -> { props, at }
    prices: new Map(), // `${playerId}:${market}:${line}` -> { over, under, yes, book }
    injuries: new Map(), // teamId -> [{ athleteId, status, ... }]
    at: {}, // task -> last success time
    dirty: new Set(),
  }

  w.bump = (what) => {
    w.version++
    if (what !== 'live') w.aVersion++
    if (what) w.dirty.add(what)
  }

  w.teamAbbr = (id) => w.teams.get(String(id))?.abbr || ''

  w.setScoreboard = (sb, at = Date.now()) => {
    let changed = false
    if (sb.season && sb.season !== w.season) w.season = sb.season
    if (sb.seasonType) w.seasonType = sb.seasonType
    if (sb.week && sb.week !== w.week) {
      w.week = sb.week
      changed = true
    }
    const ids = new Set(sb.games.map((g) => g.id))
    for (const id of [...w.games.keys()]) {
      if (!ids.has(id)) {
        w.games.delete(id)
        changed = true
      }
    }
    const transitions = []
    let structural = changed
    for (const g of sb.games) {
      const prev = w.games.get(g.id)
      const sig = gameSig(g)
      if (!prev || prev._sig !== sig) {
        changed = true
        if (!prev || prev.status.state !== g.status.state || prev.date !== g.date) structural = true
        if (prev && prev.status.state !== g.status.state) transitions.push({ id: g.id, from: prev.status.state, to: g.status.state })
        for (const t of [g.home, g.away]) if (t && !w.teams.has(t.id)) w.teams.set(t.id, { id: t.id, abbr: t.abbr, name: t.name, short: t.short, nick: t.nick, color: t.color, alt: t.alt, logo: t.logo })
        w.games.set(g.id, { ...g, _sig: sig })
      }
    }
    w.at.scoreboard = at
    // Scores and clocks only move live views; new games or state changes move the analytics too.
    if (changed) w.bump(structural ? 'core' : 'live')
    return { changed, transitions }
  }

  w.setTeams = (list, at = Date.now()) => {
    for (const t of list) w.teams.set(t.id, { ...(w.teams.get(t.id) || {}), ...t })
    w.at.teams = at
    w.bump('core')
  }

  w.setRoster = (teamId, list, at = Date.now()) => {
    for (const p of list) {
      const prev = w.players.get(p.id)
      w.players.set(p.id, { ...(prev || {}), ...p })
    }
    w.rosters.set(String(teamId), { at, size: list.length })
    w.bump('rosters')
  }

  w.setSchedule = (teamId, games, season, at = Date.now()) => {
    w.schedules.set(String(teamId), { games, season, at })
    w.bump('schedules')
  }

  w.setSummary = (id, data, at = Date.now()) => {
    w.summaries.set(String(id), { data, at })
    if (data?.injuries) {
      const byTeam = new Map()
      for (const i of data.injuries) {
        if (!byTeam.has(i.teamId)) byTeam.set(i.teamId, [])
        byTeam.get(i.teamId).push(i)
      }
      for (const [tid, list] of byTeam) w.injuries.set(tid, list)
    }
    // players seen in a live box score but missing from rosters (call-ups) still need a name
    for (const p of Object.values(data?.players || {})) {
      if (!w.players.has(p.id)) w.players.set(p.id, { id: p.id, name: p.name, short: p.short, pos: '', teamId: p.teamId, jersey: p.jersey, headshot: `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png` })
    }
    w.bump(data?.status?.state === 'in' ? 'live' : 'core')
  }

  w.setLogs = (playerId, season, rows, at = Date.now()) => {
    const pid = String(playerId)
    const other = (w.logs.get(pid) || []).filter((r) => r.season !== Number(season))
    const merged = other.concat(rows.map((r) => ({ ...r, season: Number(season) }))).sort((a, b) => String(a.date).localeCompare(String(b.date)))
    w.logs.set(pid, merged)
    const meta = w.logMeta.get(pid) || {}
    meta[season] = at
    w.logMeta.set(pid, meta)
    w.bump('logs')
  }

  w.setLines = (gameId, props, at = Date.now()) => {
    const prev = w.lines.get(String(gameId))
    const sig = props.map((p) => `${p.athleteId || p.teamId}:${p.market}:${p.line}`).sort().join('|')
    w.lines.set(String(gameId), { props, at, sig })
    if (!prev || prev.sig !== sig) {
      w.bump('core')
      return true
    }
    return false
  }

  w.injuryOf = (playerId) => {
    const p = w.players.get(String(playerId))
    const list = p ? w.injuries.get(p.teamId) || [] : []
    const hit = list.find((i) => i.athleteId === String(playerId))
    return hit ? { status: hit.status, severity: injurySeverity(hit.status), detail: hit.detail } : p?.injury ? { status: p.injury, severity: injurySeverity(p.injury) } : null
  }

  // ---- persistence -------------------------------------------------------------------------
  w.snapshotCore = () => ({
    v: 2,
    season: w.season,
    seasonType: w.seasonType,
    week: w.week,
    games: [...w.games.values()].map(({ _sig, ...g }) => g),
    teams: [...w.teams.values()],
    lines: [...w.lines].map(([id, l]) => [id, { props: l.props, at: l.at }]),
    injuries: [...w.injuries],
    summaries: [...w.summaries]
      .filter(([, s]) => s.data?.status?.state !== 'in')
      .map(([id, s]) => [id, { at: s.at, data: { ...s.data, players: s.data?.status?.state === 'post' ? s.data.players : {} } }]),
    at: w.at,
    savedAt: Date.now(),
  })
  w.snapshotRosters = () => ({ players: [...w.players.values()], rosters: [...w.rosters], savedAt: Date.now() })
  w.snapshotSchedules = () => ({ schedules: [...w.schedules], savedAt: Date.now() })
  /** Logs grouped by team so the store holds ~32 documents instead of hundreds. */
  w.snapshotLogs = () => {
    const byTeam = new Map()
    for (const [pid, rows] of w.logs) {
      const tid = w.players.get(pid)?.teamId || 'none'
      if (!byTeam.has(tid)) byTeam.set(tid, {})
      byTeam.get(tid)[pid] = { rows, meta: w.logMeta.get(pid) || {} }
    }
    return byTeam
  }

  w.restore = ({ core, rosters, schedules, logs }) => {
    if (core?.v === 2) {
      w.season = core.season
      w.seasonType = core.seasonType
      w.week = core.week
      for (const g of core.games || []) w.games.set(g.id, { ...g, _sig: gameSig(g) })
      for (const t of core.teams || []) w.teams.set(t.id, t)
      for (const [id, l] of core.lines || []) w.lines.set(id, { ...l, sig: '' })
      for (const [tid, list] of core.injuries || []) w.injuries.set(tid, list)
      for (const [id, s] of core.summaries || []) w.summaries.set(id, s)
      w.at = { ...(core.at || {}) }
    }
    w.aVersion++
    if (rosters) {
      for (const p of rosters.players || []) w.players.set(p.id, p)
      for (const [tid, r] of rosters.rosters || []) w.rosters.set(tid, r)
    }
    if (schedules) for (const [tid, s] of schedules.schedules || []) w.schedules.set(tid, s)
    for (const doc of logs || []) {
      for (const [pid, x] of Object.entries(doc || {})) {
        w.logs.set(pid, x.rows || [])
        w.logMeta.set(pid, x.meta || {})
      }
    }
    w.version++
  }

  return w
}

function gameSig(g) {
  return [g.status?.state, g.status?.period, g.status?.clock, g.home?.score, g.away?.score, g.situation?.text, g.situation?.possession, g.odds?.total, g.odds?.homeSpread, g.odds?.homeMl, g.status?.short].join('|')
}

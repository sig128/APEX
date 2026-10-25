// The NFL data engine. Keeps the week's games, lines, rosters and game logs fresh and pushes
// changes to SSE subscribers.
//
// daemon mode (backend/server.js): a scheduler runs the tasks on adaptive intervals.
// lazy mode (Cloud Functions): no idle timers; requests refresh whatever is stale and the live
// loop only runs while someone is connected to the stream.
import { createEspnClient } from '../providers/espn/client.js'
import { createOddsApi } from '../providers/oddsapi/nfl.js'
import { createWarehouse } from './warehouse.js'
import { createScheduler } from '../lib/scheduler.js'
import { createViews } from './services/views.js'
import { log, errText } from '../lib/log.js'
import { mapLimit } from '../lib/util.js'

const MIN = 60_000
const HOUR = 60 * MIN

export function createEngine({ mode = 'daemon', http, store, hub, oddsApiKey = process.env.THE_ODDS_API_KEY, now = () => Date.now(), backfillBatch } = {}) {
  const espn = createEspnClient({ http })
  const wh = createWarehouse()
  const odds = oddsApiKey ? createOddsApi({ http, store, apiKey: oddsApiKey, now }) : null
  let started = null
  let restored = false
  const staleLogs = new Set() // players whose current-season log needs a refetch (their game ended)
  const running = new Map() // task -> promise (single flight)

  // ---- helpers -----------------------------------------------------------------------------
  const games = () => [...wh.games.values()]
  const liveGames = () => games().filter((g) => g.status.state === 'in')
  const kickoffIn = () => {
    const t = now()
    const next = games().filter((g) => g.status.state === 'pre').map((g) => Date.parse(g.date) - t).filter((x) => Number.isFinite(x))
    return next.length ? Math.min(...next) : Infinity
  }
  const season = () => wh.season || new Date(now()).getUTCFullYear() - (new Date(now()).getUTCMonth() < 2 ? 1 : 0)
  const age = (k) => now() - (wh.at[k] || 0)

  function publish(topic, event, data) {
    if (hub) hub.publish(topic, event, data)
  }

  // ---- tasks ---------------------------------------------------------------------------------
  async function scoreboardTask() {
    const sb = await espn.scoreboard({}, { priority: liveGames().length ? 'live' : 'normal' })
    const { changed, transitions } = wh.setScoreboard(sb, now())
    for (const tr of transitions) {
      const g = wh.games.get(tr.id)
      if (tr.to === 'post' && g) {
        for (const p of wh.players.values()) if (p.teamId === g.home?.id || p.teamId === g.away?.id) staleLogs.add(p.id)
        for (const t of [g.home?.id, g.away?.id]) if (t && wh.schedules.has(t)) wh.schedules.get(t).at = 0
      }
    }
    if (changed) publish('scoreboard', 'update', views.strip())
    return changed
  }

  async function summariesTask() {
    const t = now()
    const todo = []
    for (const g of games()) {
      const s = wh.summaries.get(g.id)
      const ageMs = s ? t - s.at : Infinity
      if (g.status.state === 'in') todo.push([g, 'live'])
      else if (g.status.state === 'post' && (!s || s.data?.status?.state !== 'post')) todo.push([g, 'normal'])
      else if (g.status.state === 'pre') {
        const until = Date.parse(g.date) - t
        const maxAge = until < 3 * HOUR ? 10 * MIN : until < 36 * HOUR ? 30 * MIN : 3 * HOUR
        if (ageMs > maxAge) todo.push([g, 'background'])
      }
    }
    await mapLimit(todo, 4, async ([g, priority]) => {
      try {
        const s = await espn.summary(g.id, { priority })
        wh.setSummary(g.id, s, now())
        if (g.status.state === 'in' || s.status.state === 'in') {
          publish(`game:${g.id}`, 'update', views.liveGame(g.id))
        }
      } catch (e) {
        log.warn('summary failed', { game: g.id, err: errText(e) })
      }
    })
    if (liveGames().length) {
      const diff = views.trackerDiff()
      if (diff && Object.keys(diff).length) publish('tracker', 'update', diff)
    }
    wh.at.summaries = now()
  }

  async function linesTask() {
    const t = now()
    const pre = games().filter((g) => g.status.state === 'pre')
    await mapLimit(pre, 3, async (g) => {
      const cur = wh.lines.get(g.id)
      const until = Date.parse(g.date) - t
      const maxAge = until < 3 * HOUR ? 4 * MIN : 12 * MIN
      if (cur && t - cur.at < maxAge) return
      try {
        const props = await espn.propBets(g.id, { priority: 'normal' })
        if (wh.setLines(g.id, props, now(), { keepMissing: until < 45 * MIN })) publish(`props:${g.id}`, 'update', { gameId: g.id, at: now() })
      } catch (e) {
        log.warn('prop lines failed', { game: g.id, err: errText(e) })
      }
    })
    wh.at.lines = now()
  }

  async function rostersTask() {
    const teams = new Set(games().flatMap((g) => [g.home?.id, g.away?.id]).filter(Boolean))
    const t = now()
    const todo = [...teams].filter((tid) => !wh.rosters.has(tid) || t - wh.rosters.get(tid).at > 6 * HOUR)
    await mapLimit(todo, 4, async (tid) => {
      try {
        wh.setRoster(tid, await espn.roster(tid, { priority: 'background' }), now())
      } catch (e) {
        log.warn('roster failed', { team: tid, err: errText(e) })
      }
    })
    if (!wh.at.teams || t - wh.at.teams > 24 * HOUR) {
      try {
        wh.setTeams(await espn.teams({ priority: 'background' }), now())
      } catch (e) {
        log.warn('teams failed', { err: errText(e) })
      }
    }
    wh.at.rosters = now()
  }

  async function schedulesTask() {
    const teams = new Set(games().flatMap((g) => [g.home?.id, g.away?.id]).filter(Boolean))
    const t = now()
    const yr = season()
    const todo = [...teams].filter((tid) => {
      const s = wh.schedules.get(tid)
      return !s || s.season !== yr || t - s.at > 6 * HOUR
    })
    await mapLimit(todo, 4, async (tid) => {
      try {
        wh.setSchedule(tid, await espn.schedule(tid, yr, { priority: 'background' }), yr, now())
      } catch (e) {
        log.warn('schedule failed', { team: tid, err: errText(e) })
      }
    })
    wh.at.schedules = now()
  }

  /** Players whose logs we need: everyone with a line this week, plus injured starters (for "without" splits). */
  function wantedPlayers() {
    const ids = new Set()
    for (const l of wh.lines.values()) for (const p of l.props) if (p.athleteId) ids.add(p.athleteId)
    const playing = new Set(games().flatMap((g) => [g.home?.id, g.away?.id]))
    for (const [tid, list] of wh.injuries) {
      if (!playing.has(tid)) continue
      for (const i of list) if (['QB', 'RB', 'WR', 'TE'].includes(i.pos)) ids.add(i.athleteId)
    }
    return [...ids]
  }

  async function logsTask(limit = backfillBatch ?? (mode === 'lazy' ? 24 : 60)) {
    const yr = season()
    const t = now()
    const todo = []
    for (const pid of wantedPlayers()) {
      const meta = wh.logMeta.get(pid) || {}
      if (!meta[yr] || staleLogs.has(pid) || t - meta[yr] > 18 * HOUR) todo.push([pid, yr])
      if (!meta[yr - 1]) todo.push([pid, yr - 1])
    }
    // current season first, then last season
    todo.sort((a, b) => b[1] - a[1])
    const batch = todo.slice(0, limit)
    await mapLimit(batch, 6, async ([pid, yr2]) => {
      try {
        const rows = await espn.gamelog(pid, yr2, { priority: 'background' })
        wh.setLogs(pid, yr2, rows, now())
        if (yr2 === yr) staleLogs.delete(pid)
      } catch (e) {
        // A 404 usually means the player has no log that season (rookie). Remember it so we don't retry forever.
        if (e.status === 404) wh.setLogs(pid, yr2, [], now())
        else log.warn('gamelog failed', { player: pid, season: yr2, err: errText(e) })
      }
    })
    wh.at.logs = now()
    return { done: batch.length, left: todo.length - batch.length }
  }

  async function oddsTask() {
    if (!odds) return
    const upcoming = games().filter((g) => g.status.state === 'pre' && Date.parse(g.date) - now() < 30 * HOUR)
    const prices = await odds.refresh({ games: upcoming, players: wh.players, teamAbbr: wh.teamAbbr })
    if (prices) {
      wh.prices = prices
      wh.bump('core')
    }
    wh.at.odds = now()
  }

  // ---- persistence -------------------------------------------------------------------------
  async function persist(force = false) {
    if (!store) return
    if (!force && !wh.dirty.size) return
    const dirty = new Set(wh.dirty)
    wh.dirty.clear()
    try {
      if (force || dirty.has('core') || dirty.has('live')) await store.set('nfl', 'core', wh.snapshotCore())
      if (force || dirty.has('rosters')) await store.set('nfl', 'rosters', wh.snapshotRosters())
      if (force || dirty.has('schedules')) await store.set('nfl', 'schedules', wh.snapshotSchedules())
      if (force || dirty.has('logs')) {
        const byTeam = wh.snapshotLogs()
        await mapLimit([...byTeam], 4, ([tid, doc]) => store.set('nfl', `logs:${tid}`, doc))
        await store.set('nfl', 'logteams', [...byTeam.keys()])
      }
    } catch (e) {
      for (const d of dirty) wh.dirty.add(d)
      log.warn('persist failed', { err: errText(e) })
    }
  }

  async function restore() {
    if (!store || restored) return
    restored = true
    try {
      const [core, rosters, schedules, teams] = await Promise.all([store.get('nfl', 'core'), store.get('nfl', 'rosters'), store.get('nfl', 'schedules'), store.get('nfl', 'logteams')])
      const logs = teams ? await mapLimit(teams, 6, (tid) => store.get('nfl', `logs:${tid}`)) : []
      wh.restore({ core, rosters, schedules, logs })
      if (core) log.info('restored nfl snapshot', { games: wh.games.size, players: wh.players.size, logs: wh.logs.size, ageMin: Math.round((now() - (core.savedAt || 0)) / MIN) })
    } catch (e) {
      log.warn('restore failed', { err: errText(e) })
    }
  }

  // ---- running tasks -------------------------------------------------------------------------
  const TASKS = {
    scoreboard: { run: scoreboardTask, every: () => (liveGames().length ? 15_000 : kickoffIn() < 2 * HOUR ? MIN : kickoffIn() < 24 * HOUR ? 5 * MIN : 15 * MIN) },
    summaries: { run: summariesTask, every: () => (liveGames().length ? 20_000 : 5 * MIN) },
    lines: { run: linesTask, every: () => (kickoffIn() < 3 * HOUR ? 2 * MIN : 6 * MIN) },
    rosters: { run: rostersTask, every: () => 30 * MIN },
    schedules: { run: schedulesTask, every: () => 30 * MIN },
    logs: { run: () => logsTask(), every: () => (wantedPlayers().some((p) => !wh.logMeta.get(p)) || staleLogs.size ? 15_000 : 10 * MIN) },
    odds: { run: oddsTask, every: () => 30 * MIN },
    persist: { run: () => persist(), every: () => (mode === 'lazy' ? 20_000 : 60_000), runAtStart: false },
  }

  function runTask(name) {
    if (running.has(name)) return running.get(name)
    const p = (async () => {
      try {
        await TASKS[name].run()
      } catch (e) {
        log.warn('task error', { task: name, err: errText(e) })
      } finally {
        running.delete(name)
      }
    })()
    running.set(name, p)
    return p
  }

  const scheduler = createScheduler({
    tasks: Object.entries(TASKS).map(([name, t]) => ({ name, run: t.run, every: t.every, runAtStart: t.runAtStart })),
  })
  let liveLoop = null

  /** Everything needed for the first page: restore the snapshot, then the scoreboard. */
  async function bootstrap() {
    await restore()
    const needScoreboard = !wh.games.size || age('scoreboard') > 2 * MIN
    if (needScoreboard) await runTask('scoreboard')
    if (mode === 'daemon') {
      scheduler.start()
      return
    }
    // lazy: make sure lines/rosters exist before the first board renders (bounded wait)
    const first = []
    if (!wh.lines.size || age('lines') > 10 * MIN) first.push(runTask('lines'))
    if (!wh.rosters.size || age('rosters') > 6 * HOUR) first.push(runTask('rosters'))
    await Promise.race([Promise.all(first), new Promise((r) => setTimeout(r, 6000))])
    touch()
  }

  /** Lazy mode: kick off whatever is stale, without waiting. */
  function touch() {
    if (mode !== 'lazy' || !started) return
    const live = liveGames().length > 0
    const due = {
      scoreboard: age('scoreboard') > (live ? 15_000 : 2 * MIN),
      summaries: age('summaries') > (live ? 20_000 : 10 * MIN),
      lines: age('lines') > 6 * MIN,
      rosters: age('rosters') > 6 * HOUR,
      schedules: age('schedules') > 6 * HOUR,
      logs: age('logs') > 20_000 && (staleLogs.size > 0 || wantedPlayers().some((p) => !wh.logMeta.get(p)) || age('logs') > 3 * HOUR),
      odds: Boolean(odds) && age('odds') > 30 * MIN,
      persist: wh.dirty.size > 0 && age('persist') > 15_000,
    }
    for (const [name, isDue] of Object.entries(due)) {
      if (!isDue) continue
      if (name === 'persist') wh.at.persist = now()
      runTask(name)
    }
  }

  /** Lazy mode: while anyone holds a stream open, keep live data moving. */
  function onSubscribersChanged(count) {
    if (mode !== 'lazy') return
    if (count > 0 && !liveLoop) {
      liveLoop = setInterval(() => touch(), 5000)
    } else if (count === 0 && liveLoop) {
      clearInterval(liveLoop)
      liveLoop = null
    }
  }

  const engine = {
    mode,
    wh,
    espn,
    hub,
    now,
    season,
    ensureStarted() {
      if (!started) {
        started = bootstrap().catch((e) => {
          log.error('engine bootstrap failed', { err: errText(e) })
          started = null
          throw e
        })
      } else touch()
      return started
    },
    touch,
    runTask,
    logsTask,
    persist,
    onSubscribersChanged,
    stop() {
      scheduler.stop()
      if (liveLoop) clearInterval(liveLoop)
      liveLoop = null
    },
    status() {
      return {
        mode,
        season: wh.season,
        week: wh.week,
        games: wh.games.size,
        live: liveGames().length,
        props: [...wh.lines.values()].reduce((s, l) => s + l.props.length, 0),
        players: wh.players.size,
        logs: wh.logs.size,
        wanted: wantedPlayers().length,
        at: wh.at,
        tasks: mode === 'daemon' ? scheduler.status() : undefined,
        http: http.stats?.(),
        hub: hub?.stats?.(),
        odds: odds ? odds.status() : { enabled: false },
        version: wh.version,
      }
    },
  }
  const views = createViews(engine)
  engine.views = views
  return engine
}

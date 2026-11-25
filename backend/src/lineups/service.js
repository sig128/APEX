// Lineups for a prop's game: the lineup view on the prop page (./build.js lays them out).
//
// The data comes from ESPN: team depth charts for football, basketball, hockey and baseball, and a
// match's announced lineups for soccer. RotoWire sells the same data under licence. A RotoWire
// provider only has to answer the same three calls as the ESPN client (depthChart(teamId),
// gameLineups(gameId), probables(day)); pass it as `provider` and nothing else changes.
//
// Depth charts are cached for three hours and a match's lineups for ten minutes (they're announced
// about an hour before kickoff). A stale entry is served while a fresh one loads.
import { buildView, chartFromStarters, ordinal } from './build.js'
import { etDay } from '../nfl/engine.js'
import { log, errText } from '../lib/log.js'

const DEPTH_MS = 3 * 3600_000
const GAME_MS = 10 * 60_000
const MAX_MEMO = 600

const NOTES = {
  depth: 'Projected from each team’s depth chart. A starter listed as out is replaced by the next player on it.',
  box: 'No depth chart for this league: each team’s five starters from its last game.',
  lineup: 'The announced starting lineups.',
  last: 'Each team’s lineup from its last match. Today’s are announced about an hour before kickoff.',
  rotation: 'ESPN hasn’t named a starting pitcher for this game yet, so the mound shows the top of the rotation.',
}

export function createLineups({ engine, provider = engine?.espn, now = () => Date.now() }) {
  const S = engine.sport || {}
  const family = S.family || 'football'
  const memo = new Map()

  /** Cached by key: a fresh value as is, a stale one while it reloads, one load at a time. */
  function cached(key, ttl, load) {
    const hit = memo.get(key)
    const fresh = hit && 'value' in hit && now() - hit.at < ttl
    if (fresh) return Promise.resolve(hit.value)
    if (!hit?.loading) {
      const loading = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            memo.set(key, { value, at: now() })
            if (memo.size > MAX_MEMO) memo.delete(memo.keys().next().value)
            return value
          },
          (e) => {
            log.warn('lineups: load failed', { sport: S.key, key, err: errText(e) })
            // keep what we had; with nothing, remember the miss for two minutes rather than retry each view
            if (hit && 'value' in hit) memo.set(key, { value: hit.value, at: hit.at })
            else memo.set(key, { value: null, at: now() - ttl + 120_000 })
            return hit && 'value' in hit ? hit.value : null
          },
        )
      memo.set(key, { ...(hit || {}), loading })
      if (hit && 'value' in hit) return Promise.resolve(hit.value)
      return loading
    }
    return 'value' in hit ? Promise.resolve(hit.value) : hit.loading
  }

  const depth = (teamId) => cached(`d:${teamId}`, DEPTH_MS, () => provider.depthChart(teamId, { priority: 'normal' }))
  const lineups = (gameId) => cached(`g:${gameId}`, GAME_MS, () => provider.gameLineups(gameId, { priority: 'normal' }))
  const dayProbables = (day) => cached(`p:${day}`, GAME_MS, () => provider.probables(day, { priority: 'normal' }))

  /** The team's last finished game before `before`. */
  function lastGame(teamId, before) {
    const s = engine.wh.schedules.get(String(teamId))
    return (
      (s?.games || [])
        .filter((g) => g.completed && Date.parse(g.date) < before)
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0]?.id || null
    )
  }

  /** Newer injury news than the depth chart's, where the injury report has the player. */
  function withInjuries(charts) {
    return (charts || []).map((c) => ({
      ...c,
      slots: Object.fromEntries(
        Object.entries(c.slots || {}).map(([k, s]) => [
          k,
          {
            ...s,
            players: (s.players || []).map((p) => {
              const inj = engine.wh.injuryOf?.(p.id)
              return inj?.status ? { ...p, inj: { status: inj.status, note: inj.detail || p.inj?.note || '' } } : p
            }),
          },
        ]),
      ),
    }))
  }

  const teamOf = (side) => side && { id: String(side.id), abbr: side.abbr || '', name: side.name || side.abbr || '', logo: side.logo || null, color: side.color || null }

  // ESPN's photo of a player, by id, from the league's own folder
  const photoOf = (id) => (S.headshots ? `https://a.espncdn.com/i/headshots/${S.headshots}/players/full/${id}.png` : null)

  /**
   * Everyone drawn, by id: his photo, number and what the roster says about him (size, age, years
   * in, school), and his props in this game, best first. A depth chart only has names.
   */
  function peopleOf(view, gameId) {
    const ids = new Set()
    const add = (p) => p?.id && ids.add(String(p.id))
    for (const u of [view.top, view.bottom]) {
      for (const s of u?.slots || []) {
        add(s.player)
        add(s.out)
      }
    }
    for (const m of view.matchups || []) {
      for (const p of m.players || []) {
        add(p)
        add(p.out)
      }
    }
    let rows = []
    try {
      rows = engine.views.allRows?.().byGame?.get(String(gameId)) || []
    } catch (e) {
      log.warn('lineups: props for people failed', { sport: S.key, err: errText(e) })
    }
    const byPlayer = new Map()
    for (const r of rows) {
      if (r.kind !== 'player' || !r.playerId) continue
      const k = String(r.playerId)
      if (!byPlayer.has(k)) byPlayer.set(k, [])
      byPlayer.get(k).push(r)
    }
    const out = {}
    for (const id of ids) {
      const p = engine.wh.players.get(id)
      const mine = (byPlayer.get(id) || []).sort((a, b) => (b.score || 0) - (a.score || 0))
      out[id] = {
        photo: photoOf(id),
        ...(p?.jersey ? { jersey: String(p.jersey) } : {}),
        ...(p?.bio ? { bio: p.bio } : {}),
        ...(mine.length ? { props: mine.slice(0, 3).map((r) => ({ id: r.id, label: r.shortLabel || r.label, prob: r.prob })), propCount: mine.length } : {}),
        // the player page needs him in the warehouse
        ...(p ? { page: true } : {}),
      }
    }
    return out
  }

  async function chartsFor(teamId, before) {
    let charts = withInjuries(await depth(teamId))
    let source = 'depth'
    const usable = charts.some((c) => Object.values(c.slots || {}).some((s) => s.players?.length))
    if (!usable && family === 'basketball') {
      const last = lastGame(teamId, before)
      const box = last ? await lineups(last) : null
      const starters = box?.starters?.[teamId]
      charts = starters?.length ? withInjuries([chartFromStarters(starters)]) : []
      source = 'box'
    }
    return { charts, source }
  }

  async function elevenFor(teamId, gameId, before) {
    const now_ = await lineups(gameId)
    if (now_?.match?.[teamId]) return { lineup: now_.match[teamId], source: 'lineup' }
    const last = lastGame(teamId, before)
    const then = last ? await lineups(last) : null
    return then?.match?.[teamId] ? { lineup: { ...then.match[teamId], last: true }, source: 'last' } : { lineup: null, source: 'last' }
  }

  /** The lineup view for one prop, or { view: null, reason } when there's nothing to draw. */
  async function forProp(id) {
    const v = engine.views.prop(id)
    if (!v?.prop) return null
    const row = v.prop
    const g = row.gameId ? engine.wh.games.get(row.gameId) : null
    const base = { sport: S.key, family, provider: 'espn', at: now() }
    if (!g?.home || !g?.away) return { ...base, view: null, reason: 'No game for this prop on the slate.' }
    const mineSide = String(g.home.id) === String(row.teamId) ? g.home : g.away
    const theirSide = mineSide === g.home ? g.away : g.home
    const myTeam = teamOf(mineSide)
    const oppTeam = teamOf(theirSide)
    const focusId = row.kind === 'player' && row.playerId ? String(row.playerId) : null
    const focusPos = focusId ? engine.wh.players.get(focusId)?.pos || row.pos || '' : ''
    const before = Date.parse(g.date) || now()
    const input = { myTeam, oppTeam, focusId, focusPos }
    const sources = new Set()
    if (family === 'soccer') {
      const [mine, theirs] = await Promise.all([elevenFor(myTeam.id, g.id, before), elevenFor(oppTeam.id, g.id, before)])
      input.myLineup = mine.lineup
      input.theirLineup = theirs.lineup
      sources.add(mine.source).add(theirs.source)
    } else {
      const [mine, theirs] = await Promise.all([chartsFor(myTeam.id, before), chartsFor(oppTeam.id, before)])
      input.mine = mine.charts
      input.theirs = theirs.charts
      sources.add(mine.source).add(theirs.source)
      if (family === 'baseball') {
        const fromGame = (await lineups(g.id))?.probables || {}
        const probables = Object.keys(fromGame).length ? fromGame : (await dayProbables(etDay(before)))?.[String(g.id)] || {}
        input.probables = probables
        if (!probables[oppTeam.id]) sources.add('rotation')
      }
    }
    const view = buildView(family, input)
    if (!view) return { ...base, view: null, reason: family === 'soccer' ? 'The lineups aren’t out yet, and there’s no earlier match on file.' : 'No depth chart for these teams yet.' }
    const f = view.focus
    let focusNote = null
    if (focusId && !f) focusNote = `${row.short || row.name} isn’t on the depth chart for this game.`
    else if (f?.rank > 1) focusNote = `${row.short || row.name} is listed ${ordinal(f.rank)} at ${f.pos}${f.behind ? `, behind ${f.behind.short || f.behind.name}` : ''}.`
    return {
      ...base,
      game: { id: String(g.id), date: g.date, state: g.status?.state || 'pre' },
      focusName: focusId ? row.short || row.name : null,
      focusNote,
      notes: [...sources].map((s) => NOTES[s]).filter(Boolean),
      view,
      people: peopleOf(view, g.id),
    }
  }

  return { forProp }
}

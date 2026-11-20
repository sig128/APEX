// Lineup and injury news: every change on the injury report for a player on the slate, with a
// note on what it means for the board. His own props, and the teammates who produced more in the
// games he missed (from their game logs: how many games, the average without him, the average
// overall). Changes are kept from the moment they're seen, so the feed reads in order. Notes are
// built from the numbers, never guessed.

const WORD = { out: 'out', doubtful: 'doubtful', questionable: 'questionable', daytoday: 'day-to-day', probable: 'probable', returning: 'returning' }
const SEV = { probable: 0, returning: 0, daytoday: 1, questionable: 1, doubtful: 2, out: 3 }
const KEEP = 80

/** A note for one player's status, from the board's rows (his and his teammates'). */
export function noteFor({ player, tag, from, detail, own = [], lifts = [] }) {
  const name = player.short || player.name
  const why = detail ? ` (${detail})` : ''
  const parts = []
  if (tag === 'out') parts.push(`${name} is out${why}.${own.length ? ` His ${own.length === 1 ? 'prop comes' : 'props come'} off the board; books usually void bets on players who don’t play.` : ''}`)
  else if (!tag) parts.push(`${name} is off the injury report${from ? ` (was ${WORD[from] || from})` : ''}.`)
  else parts.push(`${name} is listed ${WORD[tag] || tag}${why}${from && from !== tag ? `, ${SEV[tag] > SEV[from] ? 'down' : 'up'} from ${WORD[from] || from}` : ''}.`)
  if (tag && tag !== 'out' && own.length) parts.push(`${own.length} of his props ${own.length === 1 ? 'is' : 'are'} on the board; if he plays limited, the numbers can fall short.`)
  if (lifts.length && tag && SEV[tag] >= 1) {
    const list = lifts.slice(0, 3).map((l) => `${l.short} averaged ${l.withoutAvg} ${l.stat} in ${l.games} games without him, against ${l.avg} overall`)
    parts.push(`${tag === 'out' ? 'Without him' : 'If he sits'}: ${list.join('; ')}.`)
  }
  if (!tag && lifts.length) parts.push('Teammates’ bumps from his absences no longer apply.')
  return parts.join(' ')
}

export function createNews({ engine, store, now = () => Date.now() }) {
  const sport = engine.sport?.key || 'nfl'
  const NS = `news-${sport}`

  /** Everyone on the slate's teams with a status now, with his own props and teammates' lifts. */
  function snapshot() {
    const v = engine.views
    const wh = engine.wh
    const rows = v.allRows().rows
    const slateTeams = new Set([...wh.games.values()].filter((g) => g.status?.state !== 'post').flatMap((g) => [g.home?.id, g.away?.id].filter(Boolean).map(String)))
    const out = new Map()
    for (const [tid, list] of wh.injuries) {
      if (!slateTeams.has(String(tid))) continue
      for (const i of list) {
        const p = wh.players.get(String(i.athleteId))
        if (!p) continue
        const st = v.statusOf(String(p.id))
        const tag = st?.tag || null
        if (!tag || tag === 'returning') continue
        out.set(String(p.id), { player: { id: String(p.id), name: p.name, short: p.short || p.name, teamId: String(tid), headshot: p.headshot || null, pos: p.pos || null }, tag, detail: i.detail || st?.detail || null })
      }
    }
    // his props, and teammates whose numbers went up when he missed games
    for (const x of out.values()) {
      x.own = rows.filter((r) => String(r.playerId) === x.player.id).map((r) => ({ id: r.id, label: r.shortLabel || r.label }))
      // one line per teammate (his biggest bump), on stats that read as averages (not yes/no props)
      const best = new Map()
      for (const r of rows) {
        if (!r.boost || String(r.boost.teammateId) !== x.player.id || r.boost.games < 2 || r.oneSided) continue
        const k = String(r.playerId)
        if (!best.has(k) || r.boost.lift > best.get(k).boost.lift) best.set(k, r)
      }
      x.lifts = [...best.values()]
        .sort((a, b) => b.boost.lift - a.boost.lift)
        .slice(0, 3)
        .map((r) => ({ id: r.id, short: r.short, stat: String(r.marketLabel || r.market).toLowerCase(), withoutAvg: r.boost.withoutAvg, avg: r.boost.avg, games: r.boost.games, lift: r.boost.lift }))
    }
    return out
  }

  /** Compare with what was last seen; keep each change from the moment it's noticed. */
  async function refresh() {
    const t = now()
    const cur = snapshot()
    const doc = await store.update(NS, 'state', (old) => {
      const d = old || { seen: {}, items: [], seeded: false }
      const items = [...(d.items || [])]
      const seen = { ...(d.seen || {}) }
      let changed = !old
      for (const [id, x] of cur) {
        const was = seen[id]?.tag || null
        if (was !== x.tag) {
          // the first look only records the report as it stands; changes after that are news
          if (d.seeded) items.unshift({ at: t, kind: 'change', id, player: x.player, tag: x.tag, from: was, detail: x.detail, note: noteFor({ ...x, from: was }) })
          seen[id] = { tag: x.tag, at: t }
          changed = true
        }
      }
      for (const id of Object.keys(seen)) {
        if (cur.has(id)) continue
        if (d.seeded) {
          const p = engine.wh.players.get(id)
          if (p) items.unshift({ at: t, kind: 'change', id, player: { id, name: p.name, short: p.short || p.name, headshot: p.headshot || null }, tag: null, from: seen[id].tag, detail: null, note: noteFor({ player: { name: p.name, short: p.short || p.name }, tag: null, from: seen[id].tag }) })
        }
        delete seen[id]
        changed = true
      }
      if (!d.seeded) changed = true
      return changed ? { seen, items: items.slice(0, KEEP), seeded: true, updatedAt: t } : undefined
    })
    return { doc, cur }
  }

  /** The feed: changes first (newest first), then the report as it stands, biggest impact first. */
  async function view({ member }) {
    const { doc, cur } = await refresh()
    const changes = (doc?.items || []).slice(0, 30)
    const report = [...cur.values()]
      .map((x) => ({ at: doc?.seen?.[x.player.id]?.at || null, kind: 'report', id: x.player.id, player: x.player, tag: x.tag, detail: x.detail, props: x.own.length, note: noteFor(x), impact: x.own.length + x.lifts.length * 2 + (SEV[x.tag] || 0) }))
      .filter((x) => x.props > 0 || x.impact > 2)
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 30)
    const strip = (x) => (member ? x : { ...x, note: null })
    return { sport, at: now(), locked: !member, changes: changes.map(strip), report: report.map(strip) }
  }

  return { view, refresh, snapshot }
}

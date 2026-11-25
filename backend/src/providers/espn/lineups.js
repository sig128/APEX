// ESPN's lineup data, normalized for the lineup view (src/lineups):
//   - team depth charts (football, basketball, hockey, baseball): each chart ("3WR 1TE", "Base 3-4 D",
//     "Depth Chart") is a map of position keys to players in depth order, with injury notes
//   - a match's announced lineups (soccer): the starting eleven, their positions and the formation
//   - a game's starters from its box score (basketball, when a league has no depth charts)
//   - probable pitchers on a scoreboard or summary (baseball)

const str = (x) => (x == null ? '' : String(x))

function athleteOf(a) {
  if (!a?.id) return null
  const inj = (a.injuries || []).find((i) => i?.status) || null
  return {
    id: str(a.id),
    name: a.displayName || a.fullName || '',
    short: a.shortName || '',
    inj: inj ? { status: str(inj.status), note: str(inj.shortComment || inj.type?.description || '') } : null,
  }
}

/** A depth chart: [{ id, name, slots: { key: { key, pos, label, players: [...] } } }]. */
export function normDepth(j) {
  const charts = []
  for (const c of j?.depthchart || []) {
    const slots = {}
    for (const [k, v] of Object.entries(c?.positions || {})) {
      const key = k.toLowerCase()
      const players = (v?.athletes || [])
        .map((a, i) => ({ ...athleteOf(a), rank: Number(a?.rank) || i + 1 }))
        .filter((a) => a.id)
        .sort((a, b) => a.rank - b.rank)
      slots[key] = { key, pos: str(v?.position?.abbreviation || k).toUpperCase(), label: str(v?.position?.displayName || v?.position?.name).trim(), players }
    }
    charts.push({ id: str(c?.id), name: str(c?.name).trim(), slots })
  }
  return charts
}

/** A match's starting elevens: { [teamId]: { formation, players: [{ id, name, short, jersey, pos, place }] } }. */
export function normMatchLineups(j) {
  const out = {}
  for (const side of j?.rosters || []) {
    const teamId = str(side?.team?.id)
    if (!teamId) continue
    const players = (side.roster || [])
      .filter((r) => r?.starter === true && r.athlete?.id)
      .map((r) => ({
        id: str(r.athlete.id),
        name: r.athlete.displayName || r.athlete.fullName || '',
        short: r.athlete.shortName || '',
        jersey: str(r.jersey || r.athlete.jersey),
        pos: str(r.position?.abbreviation || r.athlete.position?.abbreviation).toUpperCase(),
        place: Number(r.formationPlace) || null,
      }))
    if (players.length >= 7) out[teamId] = { formation: str(side.formation) || null, players }
  }
  return out
}

/** A game's starters from its box score: { [teamId]: [{ id, name, short, pos }] }. */
export function normBoxStarters(j) {
  const out = {}
  for (const t of j?.boxscore?.players || []) {
    const teamId = str(t?.team?.id)
    const list = []
    for (const group of t.statistics || []) {
      for (const a of group.athletes || []) {
        if (a?.starter !== true || !a.athlete?.id) continue
        if (list.some((x) => x.id === str(a.athlete.id))) continue
        list.push({ id: str(a.athlete.id), name: a.athlete.displayName || '', short: a.athlete.shortName || '', pos: str(a.athlete.position?.abbreviation).toUpperCase() })
      }
    }
    if (teamId && list.length) out[teamId] = list
  }
  return out
}

/** Probable starting pitchers by team id, from a scoreboard event or a summary header. */
export function probablesOf(competitors) {
  const out = {}
  for (const c of competitors || []) {
    const teamId = str(c?.team?.id || c?.id)
    const a = (c?.probables || []).map((p) => p?.athlete).find((x) => x?.id)
    if (teamId && a) out[teamId] = { id: str(a.id), name: a.displayName || a.fullName || '', short: a.shortName || '', inj: null }
  }
  return out
}

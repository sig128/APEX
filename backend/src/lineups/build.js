// The lineup view: both teams laid out the way the sport lines up, the player in focus marked and
// the opponents he faces picked out. Pure functions over normalized lineups (src/providers/espn/
// lineups.js); fetching and caching live in ./service.js.
//
//   football    the defense across the top, the offense below it, like a broadcast graphic
//   basketball  two starting fives, each position over its counterpart
//   hockey      a forward line, a defense pair and the goalie for each team
//   baseball    each team's fielders on a diamond, the starting pitcher on the mound
//   soccer      both elevens in formation, one team in each half
//
// Each slot carries x and y as fractions of its team's half (x across, y down), so one renderer
// draws every sport. The top team faces down, so where sides matter its left is drawn on the right.

const OUT_RE = /^(out|injured reserve|ir$|suspen|pup|nfi|inactive|not active)/i
export const isOut = (p) => OUT_RE.test(String(p?.inj?.status || ''))

const lite = (p) => p && { id: p.id, name: p.name, short: p.short || p.name, inj: p.inj || null, ...(p.jersey ? { jersey: p.jersey } : {}) }

/** The first healthy player at a slot not already used; and the listed starter he stands in for. */
function pick(slot, used, at = 0) {
  const list = (slot?.players || []).filter((p) => !used.has(p.id))
  const from = list.slice(Math.min(at, Math.max(0, list.length - 1)))
  const player = from.find((p) => !isOut(p)) || null
  if (player) used.add(player.id)
  const listed = from[0]
  return { player: lite(player), out: listed && player && listed.id !== player.id && isOut(listed) ? lite(listed) : null }
}

/** Slots from a chart at fixed spots: [key, x, y]. */
function place(chart, specs, used) {
  const slots = []
  for (const [key, x, y, at] of specs) {
    const s = chart?.slots?.[key]
    if (!s?.players?.length) continue
    const { player, out } = pick(s, used, at || 0)
    if (player) slots.push({ key, pos: s.pos, x, y, player, ...(out ? { out } : {}) })
  }
  return slots
}

/** A row of whichever of `keys` the chart has, spread evenly between x0 and x1. */
function row(chart, keys, y, x0, x1) {
  const have = keys.filter((k) => chart?.slots?.[k]?.players?.length)
  if (!have.length) return []
  const step = have.length > 1 ? (x1 - x0) / (have.length - 1) : 0
  return have.map((k, i) => [k, have.length > 1 ? x0 + step * i : (x0 + x1) / 2, y])
}

const listedAt = (chart, id) => {
  for (const s of Object.values(chart?.slots || {})) {
    const i = (s.players || []).findIndex((p) => p.id === id)
    if (i >= 0) return { key: s.key, pos: s.pos, rank: i + 1, slot: s }
  }
  return null
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`

/** Marks the focus player in a unit; a backup is noted against the starter he's behind. */
function markFocus(unit, chart, id) {
  if (!unit || !id) return null
  const at = unit.slots.find((s) => s.player?.id === id)
  if (at) {
    at.focus = true
    return { key: at.key, pos: at.pos, rank: 1 }
  }
  const listed = listedAt(chart, id)
  if (!listed) return null
  const s = unit.slots.find((x) => x.key === listed.key)
  if (s) s.focus = 'behind'
  return { key: listed.key, pos: listed.pos, rank: listed.rank, behind: s?.player || null }
}

/** The nearest players across from a slot, from the other team's keys. */
function nearest(from, unit, keys, count) {
  if (!from) return []
  return unit.slots
    .filter((s) => keys.includes(s.key) && s.player)
    .sort((a, b) => Math.abs(a.x - from.x) - Math.abs(b.x - from.x) || Math.abs(a.y - from.y) - Math.abs(b.y - from.y))
    .slice(0, count)
}

function matchup(title, slots, strong = true) {
  const players = slots.filter((s) => s?.player)
  if (!players.length) return null
  for (const s of players) s.match = strong ? 2 : Math.max(s.match || 0, 1)
  return { title, players: players.map((s) => ({ ...s.player, pos: s.pos, ...(s.out ? { out: s.out } : {}) })) }
}

// ---- football --------------------------------------------------------------------------------

const DL = ['rde', 'rdt', 'nt', 'ldt', 'lde']
const LB = ['wlb', 'rilb', 'mlb', 'lilb', 'slb']
const CB = ['rcb', 'lcb', 'nb']
const SAF = ['fs', 'ss']
const WR = ['wr1', 'wr2', 'wr3']
const OL = ['lt', 'lg', 'c', 'rg', 'rt']
const DEF_POS = /^(DE|DT|NT|DL|LB|ILB|OLB|MLB|CB|S|FS|SS|DB|EDGE)$/i

const defOf = (charts) => (charts || []).find((c) => c.slots.lcb || c.slots.rcb || c.slots.fs || c.slots.ss) || null
const offOf = (charts) => (charts || []).find((c) => c.slots.qb) || null

function defenseUnit(team, chart) {
  const used = new Set()
  const specs = [['fs', 0.3, 0.14], ['ss', 0.7, 0.14], ['rcb', 0.07, 0.5], ['lcb', 0.93, 0.5], ['nb', 0.19, 0.66], ...row(chart, LB, 0.5, 0.33, 0.67), ...row(chart, DL, 0.84, 0.33, 0.67)]
  return { team, label: 'Defense', formation: chart?.name || null, slots: place(chart, specs, used) }
}

function offenseUnit(team, chart) {
  const used = new Set()
  const fb = Boolean(chart?.slots?.fb?.players?.length)
  const specs = [['wr1', 0.07, 0.12], ['wr3', 0.2, 0.3], ['lt', 0.32, 0.12], ['lg', 0.41, 0.12], ['c', 0.5, 0.12], ['rg', 0.59, 0.12], ['rt', 0.68, 0.12], ['te', 0.8, 0.3], ['wr2', 0.93, 0.12], ['qb', 0.5, 0.44], ['fb', 0.5, 0.64], ['rb', 0.5, fb ? 0.86 : 0.76]]
  return { team, label: 'Offense', formation: chart?.name || null, slots: place(chart, specs, used) }
}

function football({ mine, theirs, myTeam, oppTeam, focusId, focusPos }) {
  const myDef = defOf(mine)
  const myOff = offOf(mine)
  const onOff = Boolean(focusId && listedAt(myOff, focusId))
  const onDef = !onOff && Boolean((focusId && listedAt(myDef, focusId)) || DEF_POS.test(focusPos || ''))
  const top = onDef ? defenseUnit(myTeam, myDef) : defenseUnit(oppTeam, defOf(theirs))
  const bottom = onDef ? offenseUnit(oppTeam, offOf(theirs)) : offenseUnit(myTeam, myOff)
  const mineUnit = onDef ? top : bottom
  const other = onDef ? bottom : top
  const focus = markFocus(mineUnit, onDef ? myDef : myOff, focusId)
  const from = focus && mineUnit.slots.find((s) => s.key === focus.key)
  const k = focus?.key || ''
  const matchups = []
  if (!onDef) {
    if (k === 'wr3') {
      const slot = other.slots.find((s) => s.key === 'nb')
      matchups.push(matchup('Likely in coverage', slot ? [slot] : nearest(from, other, CB, 1)), matchup('Safety help', nearest(from, other, SAF, 1), false))
    } else if (WR.includes(k)) {
      matchups.push(matchup('Likely in coverage', nearest(from, other, ['rcb', 'lcb'], 1)), matchup('Safety help', nearest(from, other, SAF, 1), false))
    } else if (k === 'te') {
      matchups.push(matchup('Likely in coverage', nearest(from, other, ['ss', 'fs', 'nb', ...LB], 2)))
    } else if (k === 'rb' || k === 'fb') {
      matchups.push(matchup('Linebackers he runs at', nearest(from, other, LB, 3)), matchup('Edge defenders', nearest(from, other, ['rde', 'lde'], 2), false))
    } else if (k === 'qb') {
      matchups.push(matchup('Pass rush', other.slots.filter((s) => DL.includes(s.key))), matchup('Secondary', other.slots.filter((s) => CB.includes(s.key) || SAF.includes(s.key)), false))
    } else if (OL.includes(k)) {
      matchups.push(matchup('Across the line', nearest(from, other, DL, 2)))
    }
  } else if (CB.includes(k)) {
    matchups.push(matchup('Receivers he likely covers', k === 'nb' ? nearest(from, other, ['wr3', 'te'], 2) : nearest(from, other, WR, 1)))
  } else if (SAF.includes(k)) {
    matchups.push(matchup('Receivers on his side', nearest(from, other, ['te', ...WR], 2)))
  } else if (LB.includes(k)) {
    matchups.push(matchup('Ball carrier and tight end', other.slots.filter((s) => ['rb', 'fb', 'te'].includes(s.key))), matchup('Quarterback', other.slots.filter((s) => s.key === 'qb'), false))
  } else if (DL.includes(k)) {
    matchups.push(matchup('Blockers across from him', nearest(from, other, OL, 2)), matchup('Quarterback', other.slots.filter((s) => s.key === 'qb'), false))
  }
  return { top, bottom, focus, matchups: matchups.filter(Boolean) }
}

// ---- basketball ------------------------------------------------------------------------------

const BB = [['pg', 0.1], ['sg', 0.3], ['sf', 0.5], ['pf', 0.7], ['c', 0.9]]

/** A depth chart made from a box score's five starters, guards to centers. */
export function chartFromStarters(list) {
  const want = { pg: /^(PG|G)$/, sg: /^(SG|G|GF)$/, sf: /^(SF|F|GF|G)$/, pf: /^(PF|F|FC)$/, c: /^(C|FC|F)$/ }
  const left = [...(list || [])]
  const slots = {}
  for (const [key] of BB) {
    const i = left.findIndex((p) => want[key].test(p.pos || ''))
    const p = i >= 0 ? left.splice(i, 1)[0] : left.shift()
    if (p) slots[key] = { key, pos: key.toUpperCase(), label: '', players: [{ ...p, inj: null, rank: 1 }] }
  }
  return { id: 'box', name: 'Last game’s starters', slots }
}

function fiveUnit(team, chart, label) {
  const used = new Set()
  return { team, label, formation: null, slots: place(chart, BB.map(([k, x]) => [k, x, 0.5]), used) }
}

function basketball({ mine, theirs, myTeam, oppTeam, focusId }) {
  const myChart = (mine || [])[0]
  const theirChart = (theirs || [])[0]
  const top = fiveUnit(oppTeam, theirChart, theirChart?.id === 'box' ? 'Last game’s starters' : 'Starting five')
  const bottom = fiveUnit(myTeam, myChart, myChart?.id === 'box' ? 'Last game’s starters' : 'Starting five')
  const focus = markFocus(bottom, myChart, focusId)
  const matchups = []
  if (focus) {
    const across = top.slots.filter((s) => s.key === focus.key)
    matchups.push(matchup(`Opposing ${focus.pos || 'starter'}`, across))
  }
  return { top, bottom, focus, matchups: matchups.filter(Boolean) }
}

// ---- hockey ----------------------------------------------------------------------------------

function hockey({ mine, theirs, myTeam, oppTeam, focusId }) {
  const myChart = (mine || [])[0]
  const theirChart = (theirs || [])[0]
  const listed = listedAt(myChart, focusId)
  const fwd = ['c', 'lw', 'rw'].includes(listed?.key) ? listed.rank - 1 : 0
  const pair = ['ld', 'rd'].includes(listed?.key) ? listed.rank - 1 : 0
  const goalie = listed?.key === 'g' ? listed.rank - 1 : 0
  const used = new Set()
  const bottom = {
    team: myTeam,
    label: fwd ? `Line ${fwd + 1}` : 'Top line',
    formation: null,
    slots: place(myChart, [['lw', 0.2, 0.22, fwd], ['c', 0.5, 0.22, fwd], ['rw', 0.8, 0.22, fwd], ['ld', 0.35, 0.56, pair], ['rd', 0.65, 0.56, pair], ['g', 0.5, 0.86, goalie]], used),
  }
  const theirsUsed = new Set()
  // they face down: their left wing and left defenseman are drawn on the right
  const top = { team: oppTeam, label: 'Top line', formation: null, slots: place(theirChart, [['g', 0.5, 0.14], ['rd', 0.35, 0.44], ['ld', 0.65, 0.44], ['rw', 0.2, 0.78], ['c', 0.5, 0.78], ['lw', 0.8, 0.78]], theirsUsed) }
  const focus = markFocus(bottom, myChart, focusId)
  const matchups = []
  if (focus?.key === 'g') matchups.push(matchup('Their top line', top.slots.filter((s) => ['lw', 'c', 'rw'].includes(s.key))))
  else if (focus) {
    matchups.push(matchup('In goal against him', top.slots.filter((s) => s.key === 'g')))
    if (focus.key === 'c') matchups.push(matchup('Faceoffs against', top.slots.filter((s) => s.key === 'c'), false))
  }
  return { top, bottom, focus, matchups: matchups.filter(Boolean) }
}

// ---- baseball --------------------------------------------------------------------------------

const DIAMOND = [['cf', 0.5, 0.1], ['lf', 0.16, 0.24], ['rf', 0.84, 0.24], ['ss', 0.37, 0.44], ['2b', 0.63, 0.44], ['3b', 0.2, 0.62], ['1b', 0.8, 0.62], ['sp', 0.5, 0.62], ['c', 0.5, 0.9], ['dh', 0.86, 0.9]]
const PITCH = /^(SP|RP|P)$/

/** A chart with the day's probable pitcher on the mound, when ESPN names one. */
function withStarter(chart, probable) {
  if (!chart && !probable) return chart
  const slots = { ...(chart?.slots || {}) }
  // ESPN files the rotation under "sp" for some teams and "p" for others
  if (!slots.sp && slots.p) slots.sp = { ...slots.p, key: 'sp', pos: 'SP' }
  if (probable) slots.sp = { key: 'sp', pos: 'SP', label: 'Starting pitcher', players: [{ ...probable, rank: 1 }], probable: true }
  return { id: chart?.id || 'probable', name: chart?.name || '', slots }
}

function baseball({ mine, theirs, myTeam, oppTeam, focusId, focusPos, probables }) {
  const myChart = withStarter((mine || [])[0], probables?.[myTeam?.id])
  const theirChart = withStarter((theirs || [])[0], probables?.[oppTeam?.id])
  const top = { team: oppTeam, label: probables?.[oppTeam?.id] ? 'Their field' : 'Their field (rotation, not the confirmed starter)', formation: null, slots: place(theirChart, DIAMOND, new Set()) }
  const bottom = { team: myTeam, label: 'Your side', formation: null, slots: place(myChart, DIAMOND, new Set()) }
  const focus = markFocus(bottom, myChart, focusId)
  const matchups = []
  if (focus?.key === 'sp' || (!focus && PITCH.test(focusPos || ''))) matchups.push(matchup('Lineup he faces', top.slots.filter((s) => s.key !== 'sp'), false))
  else if (focus) matchups.push(matchup('On the mound against him', top.slots.filter((s) => s.key === 'sp')))
  return { top, bottom, focus, matchups: matchups.filter(Boolean) }
}

// ---- soccer ----------------------------------------------------------------------------------

const ROWS = ['gk', 'def', 'dm', 'mid', 'am', 'fw']
const Y_TOP = { gk: 0.08, def: 0.3, dm: 0.46, mid: 0.58, am: 0.7, fw: 0.84 }
const Y_BOTTOM = { fw: 0.16, am: 0.3, mid: 0.42, dm: 0.54, def: 0.7, gk: 0.92 }

export function rowOf(pos) {
  const p = String(pos || '').toUpperCase()
  if (/^(G|GK)$/.test(p)) return 'gk'
  if (/^(CD|CB|LB|RB|LWB|RWB|SW|D)(-|$)/.test(p)) return 'def'
  if (/^(DM|CDM)(-|$)/.test(p)) return 'dm'
  if (/^(AM|CAM)(-|$)/.test(p)) return 'am'
  if (/^(F|CF|ST|LW|RW|SS|FW)(-|$)/.test(p)) return 'fw'
  return 'mid'
}
/** Across the field, left to right: full-backs and wingers outside, "-L"/"-R" players inside them. */
function lateral(pos) {
  const p = String(pos || '').toUpperCase()
  if (/^L(B|WB|W|M)$/.test(p)) return -2
  if (/^R(B|WB|W|M)$/.test(p)) return 2
  if (/-L$/.test(p)) return -1
  if (/-R$/.test(p)) return 1
  return 0
}

function elevenUnit(team, lineup, top) {
  const by = {}
  for (const p of lineup?.players || []) (by[rowOf(p.pos)] ||= []).push(p)
  const slots = []
  for (const r of ROWS) {
    const list = (by[r] || []).sort((a, b) => lateral(a.pos) - lateral(b.pos) || (a.place ?? 99) - (b.place ?? 99))
    list.forEach((p, i) => {
      const x = list.length > 1 ? 0.12 + (0.76 * i) / (list.length - 1) : 0.5
      slots.push({ key: `${r}${i}`, row: r, pos: p.pos || r.toUpperCase(), x: top ? 1 - x : x, y: (top ? Y_TOP : Y_BOTTOM)[r], player: lite(p) })
    })
  }
  return { team, label: lineup?.last ? 'Last match’s lineup' : 'Lineup', formation: lineup?.formation || null, slots }
}

function soccer({ myLineup, theirLineup, myTeam, oppTeam, focusId }) {
  const top = elevenUnit(oppTeam, theirLineup, true)
  const bottom = elevenUnit(myTeam, myLineup, false)
  const at = bottom.slots.find((s) => s.player?.id === focusId)
  if (at) at.focus = true
  const focus = at ? { key: at.key, pos: at.pos, rank: 1 } : null
  const facing = { fw: ['def'], am: ['dm', 'mid'], mid: ['mid'], dm: ['am', 'mid'], def: ['fw', 'am'], gk: ['fw'] }
  const matchups = []
  if (at) {
    for (const r of facing[at.row] || []) {
      const list = nearest(at, top, top.slots.filter((s) => s.row === r).map((s) => s.key), at.row === 'gk' ? 3 : 2)
      if (list.length) {
        matchups.push(matchup(at.row === 'gk' ? 'Forwards he faces' : at.row === 'def' ? 'Attackers on his side' : at.row === 'fw' ? 'Defenders on him' : 'Across the middle', list))
        break
      }
    }
  }
  return { top, bottom, focus, matchups: matchups.filter(Boolean) }
}

// ---- one call for every sport ----------------------------------------------------------------

/**
 * The view for one prop's game. `family` is the sport family; `mine`/`theirs` are depth charts
 * (or a box-score chart), `myLineup`/`theirLineup` match lineups (soccer), `probables` the day's
 * starting pitchers by team id.
 */
export function buildView(family, input) {
  const fn = { football, basketball, hockey, baseball, soccer }[family]
  if (!fn) return null
  const v = fn(input)
  if (!v.top?.slots?.length && !v.bottom?.slots?.length) return null
  return { family, ...v }
}

export { ordinal }

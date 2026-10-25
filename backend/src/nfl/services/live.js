// Live prop tracking: where each prop stands right now and whether it's on pace.
import { MARKETS } from '../markets.js'
import { outcome } from '../analytics/core.js'
import { clamp, round } from '../../lib/util.js'

function clockSecs(clock) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(clock || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * Share of regulation played, 0..1. Overtime counts as done. clock: { periods, secs } for the
 * sport (four 15-minute quarters by default); baseball has innings and no clock.
 */
export function gameFraction(status, clock = { periods: 4, secs: 900 }) {
  if (!status) return 0
  if (status.state === 'post') return 1
  if (status.state !== 'in') return 0
  const periods = clock.periods || 4
  const period = Number(status.period) || 1
  if (period > periods) return 1
  if (!clock.secs) {
    // innings: "Top 5th", "Mid 5th", "Bot 5th", "End 5th"
    const d = String(status.short || status.detail || '')
    const half = /^(bot|mid)/i.test(d) ? 0.5 : /^end/i.test(d) ? 1 : 0
    return clamp((period - 1 + half) / periods, 0, 1)
  }
  if (status.halftime) return 0.5
  const left = clockSecs(status.clock)
  const inPeriod = left == null ? 0.5 : clamp((clock.secs - left) / clock.secs, 0, 1)
  return clamp((period - 1 + inPeriod) / periods, 0, 1)
}

/**
 * row: a prop row (pre-game analytics). game: the scoreboard game. summary: live summary.
 * Statuses: hit, miss, push (decided) and on_pace, behind, at_risk (still playing).
 */
export function progressFor(row, game, summary, clock) {
  if (!row || !game || game.status.state === 'pre') return null
  let cur = 0
  if (row.kind === 'team') {
    const t = game.home?.id === row.teamId ? game.home : game.away
    cur = Number(t?.score) || 0
  } else {
    const mk = MARKETS[row.market]
    if (!mk) return null
    if (mk.live === false) return { untracked: true, final: game.status.state === 'post' }
    const p = summary?.players?.[row.playerId]
    cur = p ? mk.stat(p.stats || {}) : 0
  }
  const elapsed = gameFraction(game.status, clock)
  const final = game.status.state === 'post'
  const exp = Number.isFinite(row.proj) ? row.proj : row.line
  const projected = final ? cur : cur + exp * Math.max(0, 1 - elapsed)
  const line = row.line
  let status
  if (final) status = outcome(cur, line, row.side) || 'miss'
  else if (row.side === 'o') {
    if (cur > line) status = 'hit'
    else if (projected >= line * 1.03) status = 'on_pace'
    else if (projected >= line * 0.85) status = 'behind'
    else status = 'at_risk'
  } else {
    if (cur > line) status = 'miss'
    else if (projected <= line * 0.97) status = 'on_pace'
    else status = 'at_risk'
  }
  return { cur: round(cur, 1), line, side: row.side, pct: line > 0 ? round(clamp(cur / line, 0, 1.6), 3) : cur > 0 ? 1 : 0, projected: round(projected, 1), elapsed: round(elapsed, 3), status, final }
}

/** Box score leaders per team for the live game card. */
export function boxLeaders(summary, teamId) {
  const ps = Object.values(summary?.players || {}).filter((p) => p.teamId === teamId)
  const top = (key) => ps.filter((p) => p.stats?.[key] != null).sort((a, b) => (b.stats[key] || 0) - (a.stats[key] || 0))[0]
  const out = []
  const qb = top('passYds')
  if (qb) out.push({ id: qb.id, name: qb.name, short: qb.short, line: `${qb.stats.passCmp ?? 0}/${qb.stats.passAtt ?? 0}, ${qb.stats.passYds} YDS${qb.stats.passTd ? `, ${qb.stats.passTd} TD` : ''}${qb.stats.passInt ? `, ${qb.stats.passInt} INT` : ''}` })
  const rb = top('rushYds')
  if (rb) out.push({ id: rb.id, name: rb.name, short: rb.short, line: `${rb.stats.rushAtt ?? 0} CAR, ${rb.stats.rushYds} YDS${rb.stats.rushTd ? `, ${rb.stats.rushTd} TD` : ''}` })
  const wr = top('recYds')
  if (wr) out.push({ id: wr.id, name: wr.name, short: wr.short, line: `${wr.stats.rec ?? 0} REC, ${wr.stats.recYds} YDS${wr.stats.recTd ? `, ${wr.stats.recTd} TD` : ''}` })
  return out
}

/** Downsample the win probability curve for the wire. */
export function winCurve(summary, max = 120) {
  const wp = summary?.winProb || []
  if (wp.length <= max) return wp.map((w) => w.home)
  const step = wp.length / max
  const out = []
  for (let i = 0; i < max; i++) out.push(wp[Math.floor(i * step)].home)
  out.push(wp[wp.length - 1].home)
  return out
}

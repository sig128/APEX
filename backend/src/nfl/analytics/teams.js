// Team form from schedules: record, scoring, splits, streaks and team-total hit rates.
import { mean, round } from '../../lib/util.js'

/** schedule: one season's games for the team (ESPN team schedule). Preseason is ignored. */
export function teamForm(schedule, { home } = {}) {
  const cur = (schedule || []).filter((g) => g.completed && g.seasonType !== 1)
  const wins = cur.filter((g) => g.result === 'W').length
  const losses = cur.filter((g) => g.result === 'L').length
  const ties = cur.filter((g) => g.result === 'T').length
  const at = (h) => cur.filter((g) => g.home === h)
  const rec = (gs) => `${gs.filter((g) => g.result === 'W').length}-${gs.filter((g) => g.result === 'L').length}`
  let streak = ''
  for (let i = cur.length - 1; i >= 0; i--) {
    const r = cur[i].result
    if (!streak) streak = r
    else if (streak[0] === r) streak += r
    else break
  }
  return {
    record: ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`,
    games: cur.length,
    homeRecord: rec(at(true)),
    awayRecord: rec(at(false)),
    ppg: cur.length ? round(mean(cur.map((g) => g.pf)), 1) : null,
    papg: cur.length ? round(mean(cur.map((g) => g.pa)), 1) : null,
    last5: cur.slice(-5).map((g) => ({ result: g.result, opp: g.oppAbbr, home: g.home, score: `${g.pf}-${g.pa}`, id: g.id })),
    streak: streak ? `${streak[0]}${streak.length}` : null,
    venueRecord: home == null ? null : rec(at(Boolean(home))),
  }
}

/** Team-total rows for the prop engine: one value (points scored) per completed game. */
export function teamPointRows(schedule) {
  return (schedule || [])
    .filter((g) => g.completed && g.pf != null && g.seasonType !== 1)
    .map((g) => ({ eventId: g.id, date: g.date, season: new Date(g.date).getUTCFullYear() - (new Date(g.date).getUTCMonth() < 2 ? 1 : 0), post: g.seasonType === 3, home: g.home, oppId: g.oppId, oppAbbr: g.oppAbbr, v: g.pf, total: g.pf + g.pa, margin: g.pf - g.pa }))
}

/** Plain-English trend lines for the game page. */
export function trendLines({ team, form, rows, total, teamTotal, spread }) {
  const out = []
  const n = rows.length
  if (!n) return out
  const last = rows.slice(-6)
  if (total != null) {
    const overs = last.filter((r) => r.total > total).length
    out.push({ text: `${team.abbr} games went over ${total} in ${overs} of last ${last.length}`, hits: overs, n: last.length, kind: 'total' })
  }
  if (teamTotal != null) {
    const hits = last.filter((r) => r.v > teamTotal).length
    out.push({ text: `${team.abbr} scored ${Math.ceil(teamTotal)}+ in ${hits} of last ${last.length}`, hits, n: last.length, kind: 'teamTotal' })
  }
  if (spread != null) {
    const covers = last.filter((r) => r.margin + spread > 0).length
    out.push({ text: `${team.abbr} beat a ${spread > 0 ? `+${spread}` : spread} line in ${covers} of last ${last.length}`, hits: covers, n: last.length, kind: 'spread' })
  }
  if (form?.streak && Number(form.streak.slice(1)) >= 3) out.push({ text: `${team.abbr} ${form.streak[0] === 'W' ? 'won' : 'lost'} ${form.streak.slice(1)} straight`, hits: Number(form.streak.slice(1)), n: Number(form.streak.slice(1)), kind: 'streak' })
  return out
}

// The read behind a prop's numbers: a few plain sentences that weigh the hit rate against the
// matchup, so nobody has to work it out from the tables. "5 of his last 7" means little if all
// five came against defenses that give that stat away, so the key note splits the player's
// recent games by how the opponents defend this stat and shows how he does against defenses
// like tonight's. Every note says whether it helps the pick ("for"), hurts it ("against") or is
// context ("info"); the summary adds them up in one line.
import { outcome } from './core.js'
import { ordinal } from './defense.js'

const round1 = (x) => Math.round(x * 10) / 10
/** Thirds of the league by how much of this stat a defense allows (rank 1 allows the most). */
export const tierOf = (rank, of) => (rank <= of / 3 ? 'soft' : rank > (2 * of) / 3 ? 'tough' : 'mid')
const TIER_WORDS = {
  soft: (noun) => `defenses that give up a lot of ${noun}`,
  mid: (noun) => `defenses near the league average in ${noun} allowed`,
  tough: (noun) => `defenses that allow few ${noun}`,
}
const TAGS = { split: 'the record vs defenses like this', matchup: 'the matchup', h2h: 'head to head', projection: 'the projection', trend: 'recent trend', boost: 'an injury', venue: 'home/away', form: 'recent form', sample: 'a thin sample' }

function rateTone(hits, n, strong = 0.65, weak = 0.4) {
  if (!n) return 'info'
  const r = hits / n
  return r >= strong ? 'for' : r <= weak ? 'against' : 'info'
}
/** A matchup that helps overs helps "yes" bets too, and hurts unders. */
const sideTone = (good, side) => (good == null ? 'info' : (side === 'u') !== good ? 'for' : 'against')
function rankWords(rank, of) {
  if (rank === 1) return 'the most'
  if (rank === of) return 'the fewest'
  return rank <= of / 2 ? `the ${ordinal(rank)}-most` : `the ${ordinal(of - rank + 1)}-fewest`
}
function tally(rows, line, side, pick = () => true) {
  let hits = 0
  let n = 0
  for (const r of rows) {
    if (!pick(r)) continue
    const o = outcome(r.v, line, side)
    if (o == null || o === 'push') continue
    n++
    if (o === 'hit') hits++
  }
  return { hits, n }
}
function list(words) {
  if (words.length < 2) return words[0] || ''
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/**
 * rows: the player's games for this stat, oldest first ({ v, oppId, home, eventId }).
 * matchup: matchupFor() for tonight's opponent. dvp: the league's defense-vs-position table.
 * Returns { notes: [{ key, tone, text }], read: { lean, label, text } | null }, notes most telling first.
 */
export function propNotes({ rows, line, side, oneSided = false, matchup, dvp, opp, windows = [], proj, boost, move, noun, statNoun, groupName, short }) {
  const notes = []
  const add = (key, tone, text, weight) => notes.push({ key, tone, text, weight })
  const recent = rows.slice(-20)
  const win = (k) => windows.find((w) => w.key === k)
  const form = win('L10')?.n >= 6 ? win('L10') : win('L5')
  const formRate = form?.n ? form.hits / form.n : null
  const formTone = form?.n >= 5 ? rateTone(form.hits, form.n) : 'info'
  let splitSaysForm = false
  const trusted = matchup && matchup.games >= 3

  // 1. against defenses like tonight's: the hit rate split by how the opponents defend this stat
  if (trusted && opp) {
    const tonight = tierOf(matchup.rank, matchup.of)
    const cell = (r) => dvp?.byDef?.[r.oppId]?.[matchup.group]?.[matchup.stat]
    const like = tally(recent, line, side, (r) => {
      const c = cell(r)
      return Boolean(c?.trusted) && tierOf(c.rank, c.of) === tonight
    })
    if (like.n >= 2) {
      const rate = like.hits / like.n
      const against = `${like.hits} of ${like.n} against ${TIER_WORDS[tonight](statNoun)}, like ${opp.abbr}`
      const gap = formRate == null ? 0 : rate - formRate
      // the point of the note: a good hit rate built on easy matchups, or a poor one on hard ones
      splitSaysForm = Boolean(form) && Math.abs(gap) >= 0.25
      const text = splitSaysForm ? `${form.hits} of ${form.n} lately, ${gap < 0 ? 'but only' : 'and'} ${against}.` : `${against[0].toUpperCase()}${against.slice(1)}.`
      // a split that says the same as the season's numbers matters less in the middle tier
      add('split', rateTone(like.hits, like.n), text, (tonight === 'mid' ? 3.5 : 6) + Math.abs(gap) * 6)
    }
  }

  // 2. tonight's opponent against this stat and position
  if (trusted && opp) {
    const tier = tierOf(matchup.rank, matchup.of)
    const good = tier === 'soft' ? true : tier === 'tough' ? false : null
    add('matchup', sideTone(good, oneSided ? 'o' : side), `${opp.abbr} allows ${rankWords(matchup.rank, matchup.of)} ${statNoun} to ${groupName}: ${round1(matchup.perGame)} a game, against a league average of ${round1(matchup.avg)}.`, good == null ? 2 : 5)
  }

  // 3. head to head
  const h2h = win('h2h')
  if (opp && h2h?.n >= 2) add('h2h', rateTone(h2h.hits, h2h.n, 0.67, 0.34), `${h2h.hits} of ${h2h.n} against ${opp.abbr} in recent meetings.`, 3 + h2h.n / 4)

  // 4. the projection against the line
  if (!oneSided && Number.isFinite(proj) && Number.isFinite(line)) {
    const diff = proj - line
    // half a shot off a 1.5 line is a real lean; on 250 yards it takes more than a few
    const room = Math.max(0.3, Math.abs(line) * 0.06)
    const margin = side === 'u' ? -diff : diff
    const tone = margin > room ? 'for' : margin < -room ? 'against' : 'info'
    const where = Math.abs(diff) < 0.05 ? 'right on the line' : `${round1(Math.abs(diff))} ${diff > 0 ? 'above' : 'below'} the line`
    add('projection', tone, `Propify projects ${round1(proj).toFixed(1)}, ${where}.`, tone === 'info' ? 1.5 : 3)
  }

  // 5. which way the player is trending: the last five against the games before them
  if (recent.length >= 8) {
    const last5 = recent.slice(-5).map((r) => r.v)
    const before = recent.slice(0, -5).map((r) => r.v)
    const a = last5.reduce((s, v) => s + v, 0) / last5.length
    const b = before.reduce((s, v) => s + v, 0) / before.length
    if (b > 0 && Math.abs(a / b - 1) >= 0.2 && Math.abs(a - b) >= 0.5) {
      const up = a > b
      add('trend', sideTone(up, oneSided ? 'o' : side), `Last 5 games: ${round1(a)} a game, ${up ? 'up' : 'down'} from ${round1(b)} before that.`, 2.5)
    }
  }

  // 6. a teammate out
  if (boost) {
    const status = String(boost.status || 'out').toLowerCase()
    add('boost', sideTone(true, oneSided ? 'o' : side), `${boost.teammate} is ${status === 'out' ? 'out' : `listed ${status}`}. In ${boost.games} games without ${boost.short || boost.teammate}, ${short} averaged ${round1(boost.withoutAvg)}, against ${round1(boost.avg)} overall.`, 4)
  }

  // 7. home or away, when it differs from the overall rate
  const venue = win('venue')
  if (venue?.n >= 4 && formRate != null && Math.abs(venue.hits / venue.n - formRate) >= 0.2) {
    add('venue', rateTone(venue.hits, venue.n), `${venue.label === 'Home' ? 'At home' : 'On the road'}: ${venue.hits} of ${venue.n}.`, 1.5)
  }

  // 8. the line moving
  if (move?.delta) add('move', 'info', `The line has moved ${move.delta > 0 ? 'up' : 'down'} from ${move.open} to ${line} since it opened.`, 1)

  // 9. not much to go on
  if (rows.length < 6) add('sample', 'against', `Only ${rows.length} games of history for this stat.`, 2)

  // 10. recent form, when it leans one way: the stat behind "recent form backs it" (unless the
  // split already said it)
  if (formTone !== 'info' && !splitSaysForm) {
    const what = oneSided ? 'cashed' : `${side === 'u' ? 'under' : 'over'} ${line}`
    add('form', formTone, `Recent form: ${what} in ${formTone === 'against' ? 'only ' : ''}${form.hits} of the last ${form.n} games.`, 2)
  }

  notes.sort((a, b) => b.weight - a.weight)
  const out = notes.map(({ key, tone, text }) => ({ key, tone, text }))

  // the bottom line, with recent form as one voice; the matchup and the record against defenses
  // like it are one voice when they agree
  const voices = out.filter((n) => !(n.key === 'split' && out.some((m) => m.key === 'matchup' && m.tone === n.tone)))
  if (splitSaysForm && formTone !== 'info') voices.push({ key: 'form', tone: formTone })
  const pros = voices.filter((n) => n.tone === 'for').map((n) => TAGS[n.key])
  const cons = voices.filter((n) => n.tone === 'against').map((n) => TAGS[n.key])
  let read = null
  if (pros.length && !cons.length) read = pros.length === 1 ? { lean: 'for', label: 'Leans yes', text: `${pros[0]} backs it.` } : { lean: 'for', label: 'Lines up', text: `${list(pros.slice(0, 3))} ${pros.length === 2 ? 'both' : 'all'} back it.` }
  else if (cons.length && !pros.length) read = { lean: 'against', label: 'Caution', text: `${list(cons.slice(0, 3))} ${cons.length > 1 ? 'work' : 'works'} against it.` }
  else if (pros.length && cons.length) read = { lean: 'mixed', label: 'Mixed', text: `${list(pros.slice(0, 2))} ${pros.length > 1 ? 'favor' : 'favors'} it, ${list(cons.slice(0, 2))} ${cons.length > 1 ? "don't" : "doesn't"}.` }
  return { notes: out, read }
}

import { memo } from 'react'
import { Link } from 'react-router-dom'
import { Headshot, TeamLogo, logoFor } from './Img.jsx'
import { Spark } from './HitChart.jsx'
import { RateChip, SlipToggle } from './Bits.jsx'
import { pct, odds, clock } from '../lib/format.js'
import { toggleLeg } from '../lib/slip.js'
import { useSlip } from '../lib/useSlip.js'
import { useSport, sp } from '../lib/sport.js'

/**
 * One prop in a list: who, what line, how often it has hit, the Propify probability and fair
 * price, and a button to put it on the slip. `live` adds the in-game progress bar.
 */
export const PropRow = memo(function PropRow({ c, rank, showGame = false, win, live, compact = false, bare = false }) {
  const sport = useSport()
  const slip = useSlip()
  const on = slip.legs.some((l) => l.id === c.id)
  const isTeam = c.kind === 'team'
  const strong = c.prob >= 0.6
  // the bottom line and its most telling reason, under the prop (the prop page has every reason)
  const note = !compact && !live && c.note ? c.note : null
  return (
    <div className={`prop-row${compact ? ' prop-row--compact' : ''}${live ? ` prop-row--live is-${live.status}` : ''}`}>
      {rank != null && <span className="prop-row__rank num">{rank}</span>}
      <Link to={sp(c.sport || sport, `/prop/${encodeURIComponent(c.id)}`)} className={`prop-row__main${bare ? ' prop-row__main--bare' : ''}`}>
        {bare ? null : isTeam ? <TeamLogo src={c.logo || logoFor(c.teamAbbr, c.sport || sport)} abbr={c.teamAbbr} size={36} className="prop-row__img" /> : <Headshot src={c.headshot} name={c.name} size={40} className="prop-row__img" />}
        {bare ? (
          <span className="prop-row__who">
            <span className="prop-row__name">{c.label}</span>
            <span className="prop-row__label">
              {c.marketLabel}
              {Number.isFinite(c.proj) ? `, projects ${c.proj}` : ''}
            </span>
          </span>
        ) : (
        <span className="prop-row__who">
          <span className="prop-row__name">
            {c.name}
            <span className="prop-row__meta">
              {c.pos ? `${c.pos} ` : ''}
              {c.teamAbbr} {c.home ? 'vs' : '@'} {c.oppAbbr}
              {showGame && c.kickoff ? `, ${clock(null, c.kickoff)}` : ''}
            </span>
          </span>
          <span className="prop-row__label">{c.label}</span>
        </span>
        )}
      </Link>
      <span className="prop-row__form">
        <Spark spark={c.spark} line={c.line} />
        <span className="prop-row__chips">
          {win ? <RateChip w={win} /> : <RateChip w={c.l5} />}
          {!win && <RateChip w={c.l10} />}
          {c.streak >= 3 && <span className="streak-chip" title={`Hit ${c.streak} straight`}>{c.streak} straight</span>}
        </span>
      </span>
      {live ? (
        <span className="prop-row__live">
          <span className="live-bar" aria-hidden="true">
            <span className="live-bar__fill" style={{ width: `${Math.min(100, (live.pct || 0) * 100)}%` }} />
            <span className="live-bar__line" />
          </span>
          <span className="live-bar__text">
            <b className="num">{live.cur}</b>
            <span>{liveWord(live)}</span>
          </span>
        </span>
      ) : (
        <span className="prop-row__read">
          <b className={`prop-row__prob num${strong ? ' is-strong' : ''}`}>{pct(c.prob)}</b>
          <span className="prop-row__fair">fair {odds(c.fair)}</span>
        </span>
      )}
      <SlipToggle on={on} onClick={() => toggleLeg(c)} label={`${c.name} ${c.shortLabel || c.label}`} />
      {note && (
        <p className={`prop-row__note is-${c.read?.lean || note.tone}`}>
          {c.read && <b className="prop-row__lean">{c.read.label}</b>}
          {note.text}
        </p>
      )}
    </div>
  )
})

export function liveWord(l) {
  switch (l.status) {
    case 'hit':
      return l.final ? 'Hit' : 'Cleared'
    case 'miss':
      return l.final ? 'Missed' : 'Lost'
    case 'push':
      return 'Push'
    case 'on_pace':
      return `On pace for ${l.projected}`
    case 'behind':
      return `Pace ${l.projected}`
    case 'at_risk':
      return `Pace ${l.projected}`
    default:
      return ''
  }
}

export function PropList({ rows, empty = 'Nothing here right now.', ranked = false, showGame = false, winKey }) {
  if (!rows?.length) return <p className="muted pad">{empty}</p>
  return (
    <div className="prop-list">
      {rows.map((c, i) => (
        <PropRow key={c.id} c={c} rank={ranked ? i + 1 : null} showGame={showGame} win={winKey ? c.win : null} />
      ))}
    </div>
  )
}

import { Link } from 'react-router-dom'
import { TeamLogo } from './Img.jsx'
import { clock, isLive, isFinal } from '../lib/format.js'

/** This week's games as one scoreboard band: scores and clocks move live. */
export function GameStrip({ games }) {
  if (!games?.length) return null
  const order = { in: 0, pre: 1, post: 2 }
  const list = [...games].sort((a, b) => (order[a.status?.state] ?? 3) - (order[b.status?.state] ?? 3) || String(a.date).localeCompare(String(b.date)))
  return (
    <nav className="strip" aria-label="This week's games">
      <div className="strip__track">
        {list.map((g) => (
          <Link key={g.id} to={`/nfl/game/${g.id}`} className={`strip__game${isLive(g) ? ' is-live' : ''}${isFinal(g) ? ' is-final' : ''}`}>
            <Team t={g.away} other={g.home} g={g} />
            <Team t={g.home} other={g.away} g={g} />
            <span className="strip__clock">{clock(g.status, g.date)}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}

function Team({ t, other, g }) {
  if (!t) return null
  const showScore = g.status?.state !== 'pre'
  const won = isFinal(g) && Number(t.score) > Number(other?.score)
  return (
    <span className={`strip__team${won ? ' is-won' : ''}`}>
      <TeamLogo src={t.logo} abbr={t.abbr} size={18} />
      <span className="strip__abbr">{t.abbr}</span>
      {showScore ? <span className="strip__score num">{t.score ?? 0}</span> : <span className="strip__rec">{t.record || ''}</span>}
    </span>
  )
}

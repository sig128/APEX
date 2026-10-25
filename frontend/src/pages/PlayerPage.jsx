import { Link, useParams } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { shortDate, clock } from '../lib/format.js'
import { Headshot, TeamLogo } from '../ui/Img.jsx'
import { PropRow } from '../ui/PropRow.jsx'
import { Skeleton, ErrorBox, Section, Empty } from '../ui/Bits.jsx'

const COLS = {
  passCmp: 'CMP',
  passAtt: 'ATT',
  passYds: 'PASS YDS',
  passTd: 'PASS TD',
  passInt: 'INT',
  rushAtt: 'CAR',
  rushYds: 'RUSH YDS',
  rushTd: 'RUSH TD',
  rec: 'REC',
  recYds: 'REC YDS',
  recTd: 'REC TD',
  targets: 'TGT',
  tackles: 'TKL',
  solo: 'SOLO',
  sacks: 'SACK',
  defInt: 'INT',
  fgMade: 'FG',
  fgAtt: 'FGA',
  xpMade: 'XP',
  kickPts: 'PTS',
}

export function PlayerPage() {
  const { id } = useParams()
  const { data, error, loading, refresh } = useApi(`/api/nfl/players/${id}`, { maxAgeMs: 60_000 })
  const pl = data?.player
  useTitle(pl ? `${pl.name} props` : 'Player')
  if (error && !data)
    return (
      <div className="container page">
        <ErrorBox error={error} onRetry={refresh} />
      </div>
    )
  if (loading || !pl)
    return (
      <div className="container page">
        <Skeleton kind="hero" rows={1} />
        <Skeleton rows={6} />
      </div>
    )
  const next = data.next
  return (
    <div className="container page">
      <header className="prop-head">
        <Headshot src={pl.headshot} name={pl.name} size={84} className="prop-head__img" />
        <div className="prop-head__who">
          <h1 className="prop-head__name">{pl.name}</h1>
          <p className="prop-head__meta">
            <TeamLogo src={pl.team?.logo} abbr={pl.team?.abbr} size={18} /> {pl.team?.name}, {pl.pos}
            {pl.jersey ? ` #${pl.jersey}` : ''}
          </p>
          {next && (
            <p className="prop-head__meta">
              Next:{' '}
              <Link className="link" to={`/nfl/game/${next.id}`}>
                {next.shortName}, {clock(next.status, next.date)}
              </Link>
            </p>
          )}
          {data.injury && <p className={`prop-head__inj is-${data.injury.severity}`}>{data.injury.status}</p>}
        </div>
      </header>
      <Section id="player-props" title="This week's props">
        {data.props.length ? (
          <div className="prop-list">
            {data.props.map((c) => (
              <PropRow key={c.id} c={c} bare />
            ))}
          </div>
        ) : (
          <Empty title="No props posted for him yet" />
        )}
      </Section>
      <Section id="log" title="Game log">
        {data.log?.rows?.length ? (
          <div className="table-wrap">
            <table className="log">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Opp</th>
                  <th scope="col">Result</th>
                  {data.log.cols.map((c) => (
                    <th key={c} scope="col" className="num-col">
                      {COLS[c] || c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.log.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{shortDate(r.date)}</td>
                    <td>
                      {r.home ? 'vs' : '@'} {r.opp}
                    </td>
                    <td className={r.result === 'W' ? 'is-plus' : r.result === 'L' ? 'is-minus' : ''}>
                      {r.result} {r.score}
                    </td>
                    {data.log.cols.map((c) => (
                      <td key={c} className="num-col num">
                        {r.s?.[c] ?? '–'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No games logged yet.</p>
        )}
      </Section>
    </div>
  )
}

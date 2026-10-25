import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { units as fmtUnits, pct } from '../lib/format.js'
import { PickCard, Avatar } from '../ui/PickCard.jsx'
import { Tabs, Skeleton, Empty, EliteBadge } from '../ui/Bits.jsx'
import { useAuth } from '../context/AuthContext.jsx'

/** The picks showcase: Elite cappers' live feed and the leaderboard of graded records. */
export function PicksPage() {
  const [tab, setTab] = useState('feed')
  const [range, setRange] = useState('30d')
  useTitle('Picks')
  const { user } = useAuth()
  return (
    <div className="container page">
      <header className="page-head page-head--row">
        <div>
          <h1 className="page-title">Picks</h1>
          <p className="page-sub">Posted before kickoff, graded automatically from the box score. No edits after the fact.</p>
        </div>
        <Link to={user ? '/me' : '/login?next=/me'} className="btn btn--quiet">
          {user ? 'My page' : 'Make your page'}
        </Link>
      </header>
      <Tabs
        tabs={[
          { key: 'feed', label: 'Feed' },
          { key: 'board', label: 'Leaderboard' },
        ]}
        value={tab}
        onChange={setTab}
        label="Picks"
      />
      {tab === 'feed' ? <Feed /> : <Board range={range} setRange={setRange} />}
    </div>
  )
}

function Feed() {
  const { data, loading } = useApi('/api/picks/feed', { maxAgeMs: 20_000, pollMs: 60_000 })
  if (loading) return <Skeleton rows={6} />
  if (!data?.picks?.length) return <Empty title="No picks in the feed yet">Elite members' picks show up here the moment they post them.</Empty>
  return (
    <div className="picks">
      {data.picks.map((p) => (
        <PickCard key={p.id} pick={p} showProfile />
      ))}
    </div>
  )
}

function Board({ range, setRange }) {
  const { data, loading } = useApi(`/api/picks/leaderboard?range=${range}`, { maxAgeMs: 60_000 })
  return (
    <>
      <div className="seg seg--inline" role="group" aria-label="Range">
        <button type="button" className={range === '30d' ? 'is-on' : ''} aria-pressed={range === '30d'} onClick={() => setRange('30d')}>
          Last 30 days
        </button>
        <button type="button" className={range === 'all' ? 'is-on' : ''} aria-pressed={range === 'all'} onClick={() => setRange('all')}>
          All time
        </button>
      </div>
      {loading ? (
        <Skeleton rows={8} />
      ) : !data?.rows?.length ? (
        <Empty title="Nobody has qualified yet">Elite members need {data?.min || 5} graded picks to show up here.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="log board">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Capper</th>
                <th scope="col" className="num-col">Record</th>
                <th scope="col" className="num-col">Units</th>
                <th scope="col" className="num-col">ROI</th>
                <th scope="col" className="num-col">Hit</th>
                <th scope="col" className="num-col">Streak</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={r.profile.handle}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <Link to={`/u/${r.profile.handle}`} className="board__who">
                      <Avatar profile={r.profile} size={28} />
                      <span>
                        <b>{r.profile.name}</b> <span className="muted">@{r.profile.handle}</span>
                      </span>
                      {r.profile.elite && <EliteBadge small />}
                    </Link>
                  </td>
                  <td className="num-col num">
                    {r.record.wins}-{r.record.losses}
                  </td>
                  <td className={`num-col num ${r.record.units >= 0 ? 'is-plus' : 'is-minus'}`}>{fmtUnits(r.record.units)}</td>
                  <td className="num-col num">{r.record.roi == null ? '–' : `${(r.record.roi * 100).toFixed(1)}%`}</td>
                  <td className="num-col num">{pct(r.record.hitRate)}</td>
                  <td className="num-col num">{r.record.streak || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

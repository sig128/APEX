import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { units as fmtUnits, pct } from '../lib/format.js'
import { PickCard, Avatar, clvText } from '../ui/PickCard.jsx'
import { Tabs, Skeleton, Empty, EliteBadge } from '../ui/Bits.jsx'
import { Leaderboard } from '../ui/Leaderboard.jsx'
import { useAuth } from '../context/AuthContext.jsx'

/** The picks showcase: Elite cappers' live feed and the leaderboard of graded records. */
export function PicksPage() {
  const [tab, setTab] = useState('feed')
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
      {tab === 'feed' ? <Feed /> : <Leaderboard />}
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

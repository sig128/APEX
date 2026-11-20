import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { units as fmtUnits, pct } from '../lib/format.js'
import { PickCard, Avatar, clvText } from '../ui/PickCard.jsx'
import { Tabs, Skeleton, Empty, EliteBadge } from '../ui/Bits.jsx'
import { Leaderboard } from '../ui/Leaderboard.jsx'
import { GroupsPanel, JoinGroup } from '../ui/Groups.jsx'
import { useAuth } from '../context/AuthContext.jsx'

/** The picks showcase: Elite cappers' live feed and the leaderboard of graded records. */
export function PicksPage() {
  // the tab and an open group live in the address, so a group's board can be linked to
  const [params, setParams] = useSearchParams()
  const tab = ['feed', 'board', 'groups'].includes(params.get('tab')) ? params.get('tab') : 'feed'
  const group = /^g_[0-9a-f]{16}$/.test(params.get('group') || '') ? params.get('group') : null
  const setTab = (t) => setParams(t === 'feed' ? {} : { tab: t }, { replace: true })
  const openGroup = (id) => setParams(id ? { tab: 'groups', group: id } : { tab: 'groups' })
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
          { key: 'groups', label: 'Groups' },
        ]}
        value={tab}
        onChange={setTab}
        label="Picks"
      />
      {tab === 'feed' ? <Feed /> : tab === 'board' ? <Leaderboard /> : <GroupsPanel open={group} onOpen={openGroup} />}
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

/** /picks/join/:code — an invite to a private group. */
export function JoinGroupPage() {
  const { code } = useParams()
  useTitle('Join a group')
  return (
    <div className="container page narrow">
      <JoinGroup code={String(code || '')} />
    </div>
  )
}

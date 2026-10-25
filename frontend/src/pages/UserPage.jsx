import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApi, invalidate } from '../lib/useApi.js'
import { api } from '../lib/api.js'
import { useTitle, useCopy } from '../lib/hooks.js'
import { SITE_URL } from '../lib/config.js'
import { PickCard, Avatar, RecordPanel } from '../ui/PickCard.jsx'
import { Skeleton, Empty, ErrorBox, EliteBadge, Section } from '../ui/Bits.jsx'

/** /u/:handle: someone's page, their verified record, and every pick they've posted. */
export function UserPage() {
  const { handle } = useParams()
  const h = String(handle || '').toLowerCase()
  const { data, error, loading, refresh } = useApi(`/api/picks/u/${encodeURIComponent(h)}`, { maxAgeMs: 15_000 })
  const [more, setMore] = useState([])
  const [next, setNext] = useState(undefined)
  const [copy, copied] = useCopy()
  const prof = data?.profile
  useTitle(prof ? `${prof.name} (@${prof.handle}) picks` : `@${h}`)
  if (error && !data) {
    return (
      <div className="container page">
        {error.status === 404 ? (
          <Empty title={`No page called @${h}`} action={<Link to="/picks" className="btn btn--quiet">See the picks feed</Link>}>
            Check the spelling, or make it yours.
          </Empty>
        ) : (
          <ErrorBox error={error} onRetry={refresh} />
        )}
      </div>
    )
  }
  if (loading || !prof)
    return (
      <div className="container page">
        <Skeleton kind="hero" rows={1} />
      </div>
    )
  const cursor = next === undefined ? data.next : next
  const loadMore = async () => {
    const r = await api(`/api/picks/u/${encodeURIComponent(h)}?before=${cursor}`)
    setMore((m) => [...m, ...r.open, ...r.history])
    setNext(r.next)
  }
  const del = async (pick) => {
    if (!window.confirm('Delete this pick? You can only do this before kickoff.')) return
    await api(`/api/picks/${pick.id}`, { method: 'DELETE' })
    invalidate('/api/picks')
    refresh()
  }
  const url = `${SITE_URL}/u/${prof.handle}`
  return (
    <div className="container page">
      <header className="profile">
        <Avatar profile={prof} size={84} />
        <div className="profile__who">
          <h1 className="profile__name">
            {prof.name} {prof.elite && <EliteBadge />}
          </h1>
          <p className="profile__handle">@{prof.handle}</p>
          {prof.bio && <p className="profile__bio">{prof.bio}</p>}
          <p className="profile__links">
            {prof.x && (
              <a href={`https://x.com/${prof.x}`} target="_blank" rel="noopener noreferrer me" className="social social--x">
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path fill="currentColor" d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.3l4.4 5.9L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z" />
                </svg>
                @{prof.x}
              </a>
            )}
            {prof.ig && (
              <a href={`https://instagram.com/${prof.ig}`} target="_blank" rel="noopener noreferrer me" className="social social--ig">
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
                  <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
                  <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" />
                </svg>
                @{prof.ig}
              </a>
            )}
            <button type="button" className="linkish" onClick={() => copy(url)}>
              {copied ? 'Link copied' : 'Copy link'}
            </button>
            {data.owner && (
              <Link to="/me" className="linkish">
                Edit page
              </Link>
            )}
          </p>
          {data.owner && prof.hidden && <p className="form-err">Your page is hidden from everyone else. Contact support if you think that's a mistake.</p>}
        </div>
      </header>
      {prof.record ? (
        <div className="records">
          <RecordPanel title="Last 30 days" r={prof.record.d30} />
          <RecordPanel title="All time" r={prof.record.all} />
        </div>
      ) : (
        <p className="muted">No graded picks yet. The record starts with the first pick that finishes.</p>
      )}
      {data.open.length > 0 && (
        <Section id="open" title="Open picks">
          <div className="picks">
            {data.open.map((p) => (
              <PickCard key={p.id} pick={p} owner={data.owner} onDelete={del} />
            ))}
          </div>
        </Section>
      )}
      <Section id="history" title="History">
        {data.history.length || more.length ? (
          <div className="picks">
            {[...data.history, ...more].map((p) => (
              <PickCard key={p.id} pick={p} owner={data.owner} />
            ))}
          </div>
        ) : (
          <p className="muted">Nothing graded yet.</p>
        )}
        {cursor && (
          <button type="button" className="btn btn--quiet btn--block more" onClick={loadMore}>
            Older picks
          </button>
        )}
      </Section>
    </div>
  )
}

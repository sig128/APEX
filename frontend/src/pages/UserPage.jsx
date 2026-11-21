import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApi, invalidate } from '../lib/useApi.js'
import { api } from '../lib/api.js'
import { useTitle, useCopy } from '../lib/hooks.js'
import { SITE_URL } from '../lib/config.js'
import { PickCard, Avatar, RecordPanel } from '../ui/PickCard.jsx'
import { Skeleton, Empty, ErrorBox, EliteBadge, Section } from '../ui/Bits.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { openFeedback } from '../ui/Feedback.jsx'

/** /u/:handle: someone's page, their verified record, and every pick they've posted. */
export function UserPage() {
  const { handle } = useParams()
  const h = String(handle || '').toLowerCase()
  const { data, error, loading, refresh } = useApi(`/api/picks/u/${encodeURIComponent(h)}`, { maxAgeMs: 15_000 })
  const [more, setMore] = useState([])
  const [next, setNext] = useState(undefined)
  const [copy, copied] = useCopy()
  const { user } = useAuth()
  // blocking: their picks drop out of your feed, leaderboard and group boards, and this page
  // shows them only if you ask
  const [blocked, setBlocked] = useState(false)
  const [peek, setPeek] = useState(false)
  useEffect(() => {
    if (!user) return
    api('/api/picks/blocks')
      .then((r) => setBlocked(r.blocked.some((b) => b.handle === String(h).toLowerCase().replace(/^@/, ''))))
      .catch(() => {})
  }, [user, h])
  const setBlock = async (on) => {
    if (on && !window.confirm(`Block @${String(h).replace(/^@/, '')}? Their picks leave your feed, leaderboard and group boards. You can unblock them here any time.`)) return
    try {
      const r = await api('/api/picks/blocks', { method: 'POST', body: { handle: h, on } })
      setBlocked(r.blocked.some((b) => b.handle === String(h).toLowerCase().replace(/^@/, '')))
      setPeek(false)
      invalidate('/api/picks')
    } catch {
      /* the button stays as it was */
    }
  }
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
            {!data.owner && user && (
              <>
                <button type="button" className="linkish" onClick={() => openFeedback({ kind: 'report', about: `user:${prof.handle}` })}>
                  Report
                </button>
                <button type="button" className="linkish" onClick={() => setBlock(!blocked)}>
                  {blocked ? 'Unblock' : 'Block'}
                </button>
              </>
            )}
          </p>
          {blocked && !peek && (
            <p className="muted small">
              You blocked @{prof.handle}. Their picks are hidden from your feed, leaderboard and group boards.{' '}
              <button type="button" className="linkish" onClick={() => setPeek(true)}>
                Show their picks here
              </button>
            </p>
          )}
          {data.owner && prof.hidden && <p className="form-err">Your page is hidden from everyone else. Contact support if you think that's a mistake.</p>}
        </div>
      </header>
      {prof.record ? (
        <>
        <p className="verified-note">
          <span className="verified-badge">Verified record</span>
          Every pick was posted before kickoff at a sportsbook’s posted price, can’t be edited, and was graded from the box score.
        </p>
        <div className="records">
          <RecordPanel title="Last 30 days" r={prof.record.d30} />
          <RecordPanel title="All time" r={prof.record.all} />
        </div>
        {data.fairPlay?.posted > 0 && (
          <p className="fairplay muted small">
            Deleted before kickoff, last 30 days: <b className="num">{data.fairPlay.deleted}</b> of <b className="num">{data.fairPlay.posted}</b> {data.fairPlay.posted === 1 ? 'pick' : 'picks'} posted.
          </p>
        )}
        </>
      ) : (
        <p className="muted">No graded picks yet. The record starts with the first pick that finishes.</p>
      )}
      {(!blocked || peek) && data.open.length > 0 && (
        <Section id="open" title="Open picks">
          <div className="picks">
            {data.open.map((p) => (
              <PickCard key={p.id} pick={p} owner={data.owner} onDelete={del} />
            ))}
          </div>
        </Section>
      )}
      <Section id="history" title="History">
        {blocked && !peek ? (
          <p className="muted">Hidden because you blocked this person.</p>
        ) : data.history.length || more.length ? (
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

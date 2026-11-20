import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useApi, invalidate } from '../lib/useApi.js'
import { SITE_URL } from '../lib/config.js'
import { plural } from '../lib/format.js'
import { useAuth } from '../context/AuthContext.jsx'
import { Avatar } from './PickCard.jsx'
import { Skeleton, Empty } from './Bits.jsx'
import { BoardRow } from './Leaderboard.jsx'

// Private groups: friends or a league with their own board. Members start them and share the
// link; anyone with a picks page joins. The board ranks the same graded records as everyone's page.

const RANGES = [
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
]
const SORTS = [
  { key: 'roi', label: 'ROI' },
  { key: 'units', label: 'Units' },
  { key: 'hit', label: 'Hit rate' },
  { key: 'clv', label: 'CLV' },
]
export const joinLink = (code) => `${SITE_URL}/picks/join/${code}`

/** The Groups tab: yours, join one with a code, start one. A group opens its board. */
export function GroupsPanel({ open, onOpen }) {
  const { user } = useAuth()
  const { data, error, loading, refresh } = useApi(user ? '/api/picks/groups' : null, { maxAgeMs: 30_000 })
  if (!user) {
    return (
      <Empty title="Groups are for signed-in players">
        Sign in to start a group with friends or join one with its link. <Link to="/login?next=/picks?tab=groups">Sign in</Link>
      </Empty>
    )
  }
  if (open) return <GroupBoard id={open} onBack={() => onOpen(null)} onGone={() => { refresh(); onOpen(null) }} />
  if (loading && !data) return <Skeleton rows={4} />
  return (
    <section className="grp" aria-label="Your groups">
      {error && <p className="form-err">{error.message}</p>}
      {data?.groups?.length > 0 ? (
        <ul className="grp__list">
          {data.groups.map((g) => (
            <li key={g.id}>
              <button type="button" className="grp-card" onClick={() => onOpen(g.id)}>
                <span className="grp-card__name">{g.name}</span>
                <span className="grp-card__meta">
                  {plural(g.members, 'person', 'people')}
                  {g.owner ? ', you run it' : ''}
                </span>
                <span className="grp-card__go" aria-hidden="true">
                  Board
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grp__empty">
          <p className="grp__empty-h">No groups yet</p>
          <p className="muted">A group is a leaderboard for just you and the people you invite: the same graded records, nobody else on it.</p>
        </div>
      )}
      <div className="grp__forms">
        <JoinForm onJoined={(g) => { invalidate('/api/picks/groups'); onOpen(g.id) }} />
        <CreateForm canCreate={data?.canCreate} onMade={(g) => { invalidate('/api/picks/groups'); onOpen(g.id) }} />
      </div>
    </section>
  )
}

function useAct() {
  const [s, set] = useState({ busy: false, err: null })
  const run = async (fn) => {
    set({ busy: true, err: null })
    try {
      const out = await fn()
      set({ busy: false, err: null })
      return out
    } catch (err) {
      set({ busy: false, err })
      return null
    }
  }
  return [s, run]
}

function ErrLine({ err }) {
  if (!err) return null
  return (
    <p className="form-err small">
      {err.message}
      {err.code === 'no_profile' && (
        <>
          {' '}
          <Link to="/me">Make your page</Link>
        </>
      )}
    </p>
  )
}

function JoinForm({ onJoined }) {
  const [code, setCode] = useState('')
  const [s, run] = useAct()
  const join = async (e) => {
    e.preventDefault()
    const out = await run(() => api('/api/picks/groups/join', { method: 'POST', body: { code } }))
    if (out?.group) onJoined(out.group)
  }
  return (
    <form className="grp-form" onSubmit={join}>
      <label className="field">
        <span>Join with a code</span>
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="AB2CD3EF" maxLength={12} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
      </label>
      <button type="submit" className="btn btn--quiet" disabled={s.busy || code.replace(/[^A-Za-z0-9]/g, '').length < 8}>
        {s.busy ? 'Joining' : 'Join'}
      </button>
      <ErrLine err={s.err} />
    </form>
  )
}

function CreateForm({ canCreate, onMade }) {
  const [name, setName] = useState('')
  const [s, run] = useAct()
  const make = async (e) => {
    e.preventDefault()
    const out = await run(() => api('/api/picks/groups', { method: 'POST', body: { name } }))
    if (out?.group) onMade(out.group)
  }
  return (
    <form className="grp-form" onSubmit={make}>
      <label className="field">
        <span>Start a group</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday crew" maxLength={40} disabled={canCreate === false} />
      </label>
      <button type="submit" className="btn btn--lime" disabled={s.busy || !canCreate || name.trim().length < 3}>
        {s.busy ? 'Starting' : 'Start'}
      </button>
      {canCreate === false && (
        <p className="muted small">
          Starting a group comes with a <Link to="/pricing">Pro or Elite pass</Link>. Anyone with a picks page can join one.
        </p>
      )}
      <ErrLine err={s.err} />
    </form>
  )
}

/** One group's board, with the invite link and (for whoever runs it) the group's settings. */
export function GroupBoard({ id, onBack, onGone }) {
  const [range, setRange] = useState('30d')
  const [sort, setSort] = useState('roi')
  const url = `/api/picks/groups/${id}?range=${range}&sort=${sort}`
  const { data, error, loading, refresh } = useApi(url, { maxAgeMs: 30_000 })
  const g = data?.group
  const ranked = (data?.rows || []).filter((r) => r.record?.graded > 0)
  const waiting = (data?.rows || []).filter((r) => !(r.record?.graded > 0))
  return (
    <section className="grp-board" aria-labelledby="grp-h">
      <button type="button" className="linkish grp-board__back" onClick={onBack}>
        All groups
      </button>
      {error && <p className="form-err">{error.message}</p>}
      {loading && !data && <Skeleton rows={6} />}
      {g && (
        <>
          <header className="grp-board__head">
            <div>
              <h2 id="grp-h" className="grp-board__name">
                {g.name}
              </h2>
              <p className="muted">
                {plural(g.members, 'person', 'people')}, ranked by {SORTS.find((s) => s.key === sort)?.label} over {RANGES.find((r) => r.key === range)?.label.toLowerCase()}.
              </p>
            </div>
            {g.owner && <Invite code={g.code} name={g.name} />}
          </header>
          <div className="lb-filters">
            <div className="seg seg--inline" role="group" aria-label="Window">
              {RANGES.map((r) => (
                <button key={r.key} type="button" className={range === r.key ? 'is-on' : ''} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
            <label className="lb-sort">
              <span className="muted">Rank by</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {ranked.length ? (
            <ol className="lb-list">
              {ranked.map((r, i) => (
                <BoardRow key={r.profile.handle} r={r} rank={i + 1} sort={sort} tag={r.you ? 'You' : r.owner ? 'Runs it' : null} />
              ))}
            </ol>
          ) : (
            <Empty title="No graded picks here yet">When anyone in the group has a pick graded in this window, the board starts.</Empty>
          )}
          {waiting.length > 0 && (
            <div className="grp-board__wait">
              <p className="muted small">No graded picks in this window:</p>
              <ul>
                {waiting.map((r) => (
                  <li key={r.profile.handle}>
                    <Link to={`/u/${r.profile.handle}`}>
                      <Avatar profile={r.profile} size={24} />
                      <span>
                        {r.profile.name}
                        {r.you ? ' (you)' : ''}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Settings g={g} rows={data.rows} onChanged={refresh} onGone={onGone} />
        </>
      )}
    </section>
  )
}

function Invite({ code, name }) {
  const [copied, setCopied] = useState(false)
  const link = joinLink(code)
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: `Join ${name} on PropPickz`, text: `Join our group on PropPickz: ${name}`, url: link })
        return
      }
    } catch {
      /* closed the share sheet: fall back to copying */
    }
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy the invite link', link)
    }
  }
  return (
    <div className="grp-invite">
      <p className="grp-invite__k muted small">Invite code</p>
      <p className="grp-invite__code num">{code}</p>
      <button type="button" className="btn btn--lime btn--s" onClick={share}>
        {copied ? 'Link copied' : 'Share the invite link'}
      </button>
    </div>
  )
}

function Settings({ g, rows, onChanged, onGone }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(g.name)
  const [s, run] = useAct()
  const [sure, setSure] = useState(null)
  useEffect(() => setName(g.name), [g.name])
  const post = (path, body = {}) => run(() => api(`/api/picks/groups/${g.id}${path}`, { method: 'POST', body }))
  const others = rows.filter((r) => !r.you)
  return (
    <div className="grp-settings">
      {!g.owner ? (
        <button type="button" className="linkish is-minus" onClick={async () => (await post('/leave')) && onGone()}>
          Leave this group
        </button>
      ) : (
        <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>Group settings</summary>
          <form
            className="grp-form"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await post('/rename', { name })) onChanged()
            }}
          >
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            </label>
            <button type="submit" className="btn btn--quiet btn--s" disabled={s.busy || name.trim().length < 3 || name === g.name}>
              Rename
            </button>
          </form>
          <p className="grp-settings__row">
            <button type="button" className="btn btn--quiet btn--s" onClick={async () => (await post('/code')) && onChanged()} disabled={s.busy}>
              New invite code
            </button>
            <span className="muted small">The old link stops working. People already in stay in.</span>
          </p>
          {others.length > 0 && (
            <ul className="grp-settings__people">
              {others.map((r) => (
                <li key={r.profile.handle}>
                  <span>{r.profile.name}</span>
                  <button type="button" className="linkish is-minus" onClick={async () => (await post('/remove', { handle: r.profile.handle })) && onChanged()} disabled={s.busy}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="grp-settings__row">
            <button type="button" className="linkish is-minus" onClick={async () => (await post('/leave')) && onGone()}>
              Leave (it passes to whoever joined first)
            </button>
          </p>
          <p className="grp-settings__row">
            {sure === 'delete' ? (
              <>
                <span>Delete {g.name} for everyone? Records stay on everyone’s page.</span>
                <button type="button" className="btn btn--quiet btn--s is-minus" onClick={async () => (await run(() => api(`/api/picks/groups/${g.id}`, { method: 'DELETE' }))) && onGone()}>
                  Delete it
                </button>
                <button type="button" className="linkish" onClick={() => setSure(null)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="linkish is-minus" onClick={() => setSure('delete')}>
                Delete the group
              </button>
            )}
          </p>
        </details>
      )}
      <ErrLine err={s.err} />
    </div>
  )
}

/** /picks/join/:code — what the link opens, and one button to join. */
export function JoinGroup({ code }) {
  const { user } = useAuth()
  const nav = useNavigate()
  const peek = useApi(`/api/picks/groups/code/${encodeURIComponent(code)}`, { maxAgeMs: 60_000 })
  const [s, run] = useAct()
  const join = async () => {
    const out = await run(() => api('/api/picks/groups/join', { method: 'POST', body: { code } }))
    if (out?.group) {
      invalidate('/api/picks/groups')
      nav(`/picks?tab=groups&group=${out.group.id}`)
    }
  }
  if (peek.error) return <Empty title="That invite doesn’t work">{peek.error.message}</Empty>
  if (!peek.data) return <Skeleton rows={3} />
  const g = peek.data
  return (
    <div className="grp-join">
      <p className="muted">You’re invited to</p>
      <h1 className="grp-join__name">{g.name}</h1>
      <p className="muted">
        {plural(g.members, 'person', 'people')}
        {g.owner ? `, started by @${g.owner}` : ''}. A private board of everyone’s graded picks.
      </p>
      {g.full ? (
        <p className="form-err">This group is full.</p>
      ) : !user ? (
        <Link className="btn btn--lime" to={`/login?next=${encodeURIComponent(`/picks/join/${code}`)}`}>
          Sign in to join
        </Link>
      ) : (
        <button type="button" className="btn btn--lime" onClick={join} disabled={s.busy}>
          {s.busy ? 'Joining' : `Join ${g.name}`}
        </button>
      )}
      <ErrLine err={s.err} />
    </div>
  )
}

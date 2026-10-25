import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { invalidate } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { Avatar } from '../ui/PickCard.jsx'
import { Skeleton, EliteBadge } from '../ui/Bits.jsx'

/** Make or edit your picks page. Handles are yours once claimed; socials show with Elite. */
export function MePage() {
  const { user, loading: authLoading } = useAuth()
  const { paywall, has } = useBilling()
  const [me, setMe] = useState(null)
  const [form, setForm] = useState(null)
  const [state, setState] = useState({ busy: false, err: null, saved: false })
  useTitle('My page')

  useEffect(() => {
    if (!user) return
    api('/api/picks/me')
      .then((m) => {
        setMe(m)
        const p = m.profile
        setForm({ handle: p?.handle || m.suggested || '', name: p?.name || user.displayName || '', bio: p?.bio || '', x: p?.x || '', ig: p?.ig || '', useAvatar: p ? Boolean(p.avatar) : true })
      })
      .catch((e) => setState({ busy: false, err: e, saved: false }))
  }, [user])

  if (authLoading) return <div className="container page"><Skeleton rows={4} /></div>
  if (!user) return <Navigate to="/login?next=/me" replace />
  if (!form) return <div className="container page">{state.err ? <p className="form-err">{state.err.message}</p> : <Skeleton rows={6} />}</div>

  const elite = !paywall || has('elite')
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const save = async (e) => {
    e.preventDefault()
    setState({ busy: true, err: null, saved: false })
    try {
      const out = await api('/api/picks/me', { method: 'PUT', body: { handle: form.handle, name: form.name, bio: form.bio, x: form.x || null, ig: form.ig || null, avatar: form.useAvatar ? user.photoURL || undefined : null } })
      setMe((m) => ({ ...m, profile: out.profile }))
      invalidate('/api/picks')
      setState({ busy: false, err: null, saved: true })
    } catch (err) {
      setState({ busy: false, err, saved: false })
    }
  }
  const p = me?.profile
  return (
    <div className="container page narrow">
      <header className="page-head">
        <h1 className="page-title">{p ? 'Your page' : 'Make your picks page'}</h1>
        <p className="page-sub">{p ? `apex/u/${p.handle}` : 'Post picks before kickoff and APEX grades them from the box score. Your record builds itself, and nobody can fake one.'}</p>
      </header>
      {p && (
        <div className="me-card">
          <Avatar profile={p} size={56} />
          <div>
            <p>
              <b>{p.name}</b> @{p.handle} {p.elite && <EliteBadge small />}
            </p>
            <Link to={`/u/${p.handle}`} className="link">
              Open my page
            </Link>
          </div>
        </div>
      )}
      <form className="stack" onSubmit={save}>
        <label className="field">
          <span>Handle</span>
          <div className="field__prefix">
            <span>@</span>
            <input required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" value={form.handle} onChange={set('handle')} autoCapitalize="none" autoCorrect="off" spellCheck="false" />
          </div>
          <small>3 to 20 letters, numbers or underscores. You can change it once a week.</small>
        </label>
        <label className="field">
          <span>Display name</span>
          <input maxLength={40} value={form.name} onChange={set('name')} />
        </label>
        <label className="field">
          <span>Bio</span>
          <textarea maxLength={160} rows={2} value={form.bio} onChange={set('bio')} placeholder="What you bet and how" />
        </label>
        <fieldset className={`field-group${elite ? '' : ' is-locked'}`}>
          <legend>
            Socials {!elite && <span className="muted">(shown on your page with Elite)</span>}
          </legend>
          <label className="field">
            <span>X</span>
            <input value={form.x} onChange={set('x')} placeholder="@yourname or x.com/yourname" autoCapitalize="none" />
          </label>
          <label className="field">
            <span>Instagram</span>
            <input value={form.ig} onChange={set('ig')} placeholder="@yourname" autoCapitalize="none" />
          </label>
          {!elite && (
            <p className="small">
              Elite puts your X and Instagram on your page, your picks in the feed, and you on the leaderboard. <Link to="/pricing">See Elite</Link>
            </p>
          )}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={form.useAvatar} onChange={set('useAvatar')} />
          Use my Google profile picture
        </label>
        {state.err && (
          <p className="form-err" role="alert">
            {state.err.message}
          </p>
        )}
        {state.saved && <p className="form-ok">Saved.</p>}
        <div className="row">
          <button type="submit" className="btn btn--gold" disabled={state.busy}>
            {state.busy ? 'Saving' : p ? 'Save changes' : 'Create my page'}
          </button>
          {p && (
            <Link to={`/u/${p.handle}`} className="btn btn--quiet">
              View page
            </Link>
          )}
        </div>
      </form>
      <p className="muted small">To post a pick, add props to your slip and choose Post as pick.</p>
    </div>
  )
}

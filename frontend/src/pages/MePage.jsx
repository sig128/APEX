import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { invalidate } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { units as fmtUnits } from '../lib/format.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { Headshot } from '../ui/Img.jsx'
import { Skeleton, EliteBadge } from '../ui/Bits.jsx'
import { AlertsCard, CoachCard, LimitsCard, SubscribersCard } from '../ui/MeTools.jsx'
import { TrackingCard } from '../ui/Tracking.jsx'

const HANDLE_RE = /^[a-z0-9_]{3,20}$/

/**
 * Make or edit your picks page. The page shows as you type it (name, handle, bio, socials and
 * the record strip it will carry); handles are yours once claimed; socials show with Elite.
 */
export function MePage() {
  const { user, loading: authLoading } = useAuth()
  const { paywall, has } = useBilling()
  const [me, setMe] = useState(null)
  const [form, setForm] = useState(null)
  const [state, setState] = useState({ busy: false, err: null, saved: null })
  useTitle('My page')

  useEffect(() => {
    if (!user) return
    api('/api/picks/me')
      .then((m) => {
        setMe(m)
        const p = m.profile
        setForm({ handle: p?.handle || m.suggested || '', name: p?.name || user.displayName || '', bio: p?.bio || '', x: p?.x || '', ig: p?.ig || '', useAvatar: p ? Boolean(p.avatar) : true })
      })
      .catch((e) => setState({ busy: false, err: e, saved: null }))
  }, [user])

  if (authLoading) return <div className="container page"><Skeleton rows={4} /></div>
  if (!user) return <Navigate to="/login?next=/me" replace />
  if (!form) return <div className="container page">{state.err ? <p className="form-err">{state.err.message}</p> : <Skeleton rows={6} />}</div>

  const elite = !paywall || has('elite')
  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [k]: v }))
    if (state.saved) setState((s) => ({ ...s, saved: null }))
  }
  const p = me?.profile
  const save = async (e) => {
    e.preventDefault()
    const created = !p
    setState({ busy: true, err: null, saved: null })
    try {
      const out = await api('/api/picks/me', { method: 'PUT', body: { handle: form.handle, name: form.name, bio: form.bio, x: form.x || null, ig: form.ig || null, avatar: form.useAvatar ? user.photoURL || undefined : null } })
      setMe((m) => ({ ...m, profile: out.profile }))
      invalidate('/api/picks')
      setState({ busy: false, err: null, saved: created ? 'created' : 'saved' })
    } catch (err) {
      setState({ busy: false, err, saved: null })
    }
  }

  const handle = form.handle.trim().replace(/^@/, '').toLowerCase()
  const handleBad = handle.length > 0 && !HANDLE_RE.test(handle)
  const photo = form.useAvatar ? user.photoURL || null : null
  const preview = {
    name: form.name.trim() || handle || 'Your name',
    handle: handle || 'yourhandle',
    bio: form.bio.trim(),
    avatar: photo,
    elite: Boolean(p?.elite),
    x: elite ? form.x.trim().replace(/^@/, '') : '',
    ig: elite ? form.ig.trim().replace(/^@/, '') : '',
    record: p?.record?.all || null,
  }

  return (
    <div className="container page me-page">
      <header className="page-head">
        <h1 className="page-title">{p ? 'Your picks page' : 'Make your picks page'}</h1>
        {p ? (
          <p className="page-sub">
            Live at{' '}
            <Link to={`/u/${p.handle}`} className="link">
              proppickz.com/u/{p.handle}
            </Link>
          </p>
        ) : (
          <p className="page-sub">Post picks before kickoff and PropPickz grades them from the box score. Your record builds itself, and nobody can fake one.</p>
        )}
      </header>
      {p && me?.held && (
        <p className="me-held" role="status">
          Your page is off the public leaderboard while we check {me.held === 'deletes' ? 'how many picks were deleted before kickoff' : me.held === 'wallet' ? 'an account that paid from the same wallet as yours' : 'picks on both sides of the same prop from accounts on one network'}. Your page, picks and groups work as usual. If something looks wrong, send us a note from Feedback.
        </p>
      )}

      <div className="me-grid">
        <div className="me-grid__preview">
          <PagePreview {...preview} live={Boolean(p)} />
        </div>

        <form className="me-form" onSubmit={save}>
          <div className="field">
            <label htmlFor="me-handle">Your link</label>
            <div className={`field__prefix me-handle${handleBad ? ' is-bad' : ''}`}>
              <span aria-hidden="true">proppickz.com/u/</span>
              <input id="me-handle" required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" value={form.handle} onChange={set('handle')} autoCapitalize="none" autoCorrect="off" spellCheck="false" aria-invalid={handleBad || undefined} aria-describedby="me-handle-hint" />
            </div>
            <small id="me-handle-hint" className={handleBad ? 'is-bad' : undefined}>
              {handleBad ? 'Use 3 to 20 letters, numbers or underscores.' : '3 to 20 letters, numbers or underscores. You can change it once a week.'}
            </small>
          </div>

          <div className="field">
            <label htmlFor="me-name">Name on your page</label>
            <input id="me-name" maxLength={40} value={form.name} onChange={set('name')} autoComplete="nickname" />
          </div>

          <div className="field">
            <div className="field__row">
              <label htmlFor="me-bio">Bio</label>
              <span className="field__count num" aria-live="polite">
                {form.bio.length}/160
              </span>
            </div>
            <textarea id="me-bio" maxLength={160} rows={3} value={form.bio} onChange={set('bio')} placeholder="What you bet and how. For example: NBA player props, mostly unders." />
          </div>

          <fieldset className="me-socials">
            <legend className="me-socials__head">
              Socials
              {!elite && <span className="me-socials__lock">Show with Elite</span>}
            </legend>
            <div className="me-socials__fields">
              <label className="field">
                <span className="sr-only">X</span>
                <span className="field__prefix">
                  <span aria-hidden="true">x.com/</span>
                  <input value={form.x} onChange={set('x')} placeholder="yourname" autoCapitalize="none" autoCorrect="off" spellCheck="false" aria-label="X handle" />
                </span>
              </label>
              <label className="field">
                <span className="sr-only">Instagram</span>
                <span className="field__prefix">
                  <span aria-hidden="true">instagram.com/</span>
                  <input value={form.ig} onChange={set('ig')} placeholder="yourname" autoCapitalize="none" autoCorrect="off" spellCheck="false" aria-label="Instagram handle" />
                </span>
              </label>
            </div>
            {!elite && (
              <p className="me-socials__note">
                Elite puts your X and Instagram on your page, your picks in the feed and you on the leaderboard. <Link to="/pricing">See Elite</Link>
              </p>
            )}
          </fieldset>

          {user.photoURL && (
            <label className="me-photo">
              <Headshot src={user.photoURL} name={preview.name} size={40} className="avatar" />
              <span className="me-photo__text">Use my Google profile picture</span>
              <input type="checkbox" role="switch" className="switch" checked={form.useAvatar} onChange={set('useAvatar')} />
            </label>
          )}

          {state.err && (
            <p className="form-err" role="alert">
              {state.err.message}
            </p>
          )}
          <div className="me-submit">
            <button type="submit" className="btn btn--lime" disabled={state.busy || handleBad}>
              {state.busy ? 'Saving' : p ? 'Save changes' : 'Create my page'}
            </button>
            {state.saved && (
              <p className="form-ok" role="status">
                {state.saved === 'created' ? (
                  <>
                    Your page is live. <Link to={`/u/${p?.handle || handle}`}>Open it</Link>
                  </>
                ) : (
                  'Changes saved.'
                )}
              </p>
            )}
            <p className="me-tip">To post a pick, add props to your slip and choose Post as pick.</p>
          </div>
        </form>
      </div>

      {p && (
        <div className="me-tools">
          <TrackingCard />
          <div className="me-tools__links">
            <Link to="/me/live" className="btn btn--quiet">
              Live slips
            </Link>
          </div>
          <AlertsCard />
          <CoachCard />
          {elite && <SubscribersCard />}
        </div>
      )}
      <LimitsCard />
    </div>
  )
}

/** The picks page as others will see it: who, the record strip, and its link. */
function PagePreview({ name, handle, bio, avatar, elite, x, ig, record, live }) {
  const w = record?.wins || 0
  const l = record?.losses || 0
  const u = record?.units || 0
  const hit = Number.isFinite(record?.hitRate) ? `${Math.round(record.hitRate * 100)}%` : '–'
  return (
    <section className="pp-card" aria-label={live ? 'Your page' : 'How your page will look'}>
      <p className="pp-card__cap">{live ? 'Your page' : 'How your page will look'}</p>
      <div className="pp-card__top">
        <Headshot src={avatar} name={name} size={64} className="avatar pp-card__avatar" />
        <div className="pp-card__who">
          <p className="pp-card__name">
            <span>{name}</span>
            {elite && <EliteBadge small />}
          </p>
          <p className="pp-card__handle">@{handle}</p>
        </div>
      </div>
      {bio && <p className="pp-card__bio">{bio}</p>}
      {(x || ig) && (
        <p className="pp-card__socials">
          {x && <span>x.com/{x}</span>}
          {ig && <span>instagram.com/{ig}</span>}
        </p>
      )}
      <dl className="pp-card__stats">
        <div>
          <dt>Record</dt>
          <dd className="num">
            {w}–{l}
          </dd>
        </div>
        <div>
          <dt>Units</dt>
          <dd className={`num${u > 0 ? ' is-plus' : u < 0 ? ' is-minus' : ''}`}>{fmtUnits(u)}</dd>
        </div>
        <div>
          <dt>Hit rate</dt>
          <dd className="num">{hit}</dd>
        </div>
      </dl>
      <p className="pp-card__foot">
        <span className="pp-card__url">proppickz.com/u/{handle}</span>
        <span className="verified-badge">Verified record</span>
      </p>
    </section>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useApi, invalidate } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { sportInfo } from '../lib/sport.js'
import { useAuth } from '../context/AuthContext.jsx'
import { Skeleton, ErrorBox } from '../ui/Bits.jsx'
import { Headshot } from '../ui/Img.jsx'

const ID_RE = /^ct_[0-9a-f]{20}$/
const DAY = 86_400_000
const dayTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const dateOnly = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** "Sun 1:00 PM" this week, "Nov 12, 1:00 PM" further out. */
function when(ms) {
  if (!Number.isFinite(ms)) return ''
  const days = (ms - Date.now()) / DAY
  return days > -1 && days < 6 ? dayTime.format(ms) : dateTime.format(ms)
}
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The clock, ticking every `every` ms, so locks happen on screen without a reload. */
function useNow(every) {
  const [t, setT] = useState(() => Date.now())
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), every)
    return () => clearInterval(i)
  }, [every])
  return t
}

/** One contest with the viewer's entry (so it's fetched with their sign-in, never shared). */
function useContest(id, uid) {
  const [state, setState] = useState({ data: null, error: null })
  const seq = useRef(0)
  const load = useCallback(async () => {
    if (!id) return
    const n = ++seq.current
    try {
      const data = await api(`/api/contests/${id}`)
      if (n === seq.current) setState({ data, error: null })
    } catch (error) {
      if (n === seq.current) setState((s) => ({ ...s, error }))
    }
    // uid is in the list so a different person signing in loads their own entry
  }, [id, uid])
  useEffect(() => {
    setState({ data: null, error: null })
    load()
  }, [load])
  useEffect(() => {
    if (!id) return undefined
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 60_000)
    return () => clearInterval(t)
  }, [id, load])
  const setYou = useCallback((you) => setState((s) => (s.data ? { ...s, data: { ...s.data, you } } : s)), [])
  return { ...state, reload: load, setYou }
}

/** The weekly free-to-play contest: pick a side on each prop, a point for every right one. */
export function ContestsPage() {
  const { user, loading: authLoading } = useAuth()
  const [q, setQ] = useSearchParams()
  const list = useApi('/api/contests', { maxAgeMs: 30_000 })
  const all = list.data?.contests || []
  const active = all.filter((c) => c.status === 'open' || c.status === 'closed')
  const finals = all.filter((c) => c.status === 'final')
  const asked = ID_RE.test(q.get('c') || '') ? q.get('c') : null
  const id = asked || active[0]?.id || null
  const detail = useContest(authLoading ? null : id, user?.uid || null)
  useTitle(detail.data?.contest?.title || 'Weekly contest')

  let body
  if (list.error && !list.data) body = <ErrorBox error={list.error} onRetry={list.refresh} />
  else if (list.loading || authLoading || (id && !detail.data && !detail.error)) body = <Skeleton rows={8} />
  else if (!id) body = <NoContest />
  else if (detail.error) body = <ErrorBox error={detail.error} onRetry={detail.reload} />
  else body = <Contest key={id} data={detail.data} user={user} reload={detail.reload} setYou={detail.setYou} />

  return (
    <div className="container page ct">
      {active.length > 1 && (
        <div className="pills ct-switch" role="group" aria-label="Open contests">
          {active.map((c) => (
            <button key={c.id} type="button" className={`pill${c.id === id ? ' is-on' : ''}`} aria-pressed={c.id === id} onClick={() => setQ({ c: c.id }, { replace: true })}>
              {c.title}
            </button>
          ))}
        </div>
      )}
      {body}
      <HowItWorks rulesUrl={detail.data?.contest?.rulesUrl || ''} />
      <Past finals={finals} current={id} />
      <p className="ct-legal">Free to enter. No purchase necessary. 21+. Gambling problem? Call <a href="tel:18006973738">1-800-MY-RESET</a>.</p>
    </div>
  )
}

function NoContest() {
  return (
    <header className="ct-hero">
      <p className="ct-eyebrow">Weekly contest</p>
      <h1 className="page-title">No contest this week yet</h1>
      <p className="page-sub">Each week there's a free contest: pick over or under on a handful of props, and every one you get right is a point. Check back soon for the next slate.</p>
    </header>
  )
}

function statusLine(c, live) {
  if (c.status === 'final') return 'Final'
  if (c.status === 'cancelled') return 'Cancelled'
  if (c.status === 'closed') return 'Entries closed'
  return live ? 'Open' : 'Every pick is locked'
}

function Contest({ data, user, reload, setYou }) {
  const c = data.contest
  const you = data.you
  const entry = you?.entry || null
  const saved = entry?.picks || {}
  const entered = Boolean(you?.entered)
  const block = you?.block || null
  const now = useNow(20_000)
  const [draft, setDraft] = useState({})
  const [confirm, setConfirm] = useState(false)
  const [st, setSt] = useState({ busy: false, err: null, ok: false })

  const lockedNow = (p) => p.locked || now >= p.lockAt
  const live = c.status === 'open' && c.slate.some((p) => !lockedNow(p))
  const canEdit = Boolean(user) && !block && live
  const pickOf = (p) => (Object.hasOwn(draft, p.id) ? draft[p.id] : saved[p.id] || null)
  const changes = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== (saved[k] || null)))
  const dirty = Object.keys(changes).length > 0
  const picked = c.slate.filter((p) => pickOf(p)).length
  const next = c.slate.filter((p) => !lockedNow(p)).sort((a, b) => a.lockAt - b.lockAt)[0]

  const choose = (p, side) => {
    if (!canEdit || lockedNow(p)) return
    const cur = pickOf(p)
    setDraft((d) => ({ ...d, [p.id]: cur === side ? null : side }))
    setSt({ busy: false, err: null, ok: false })
  }

  const save = async () => {
    if (!dirty || st.busy) return
    setSt({ busy: true, err: null, ok: false })
    try {
      const out = await api(`/api/contests/${c.id}/entry`, { method: 'POST', body: { picks: changes, ...(entered ? {} : { confirm: true }) } })
      setYou(out.you)
      setDraft({})
      setSt({ busy: false, err: null, ok: true })
      invalidate('/api/contests')
      reload()
    } catch (err) {
      setSt({ busy: false, err, ok: false })
      // a game started in the meantime: drop what can't be saved and show the new locks
      if (Array.isArray(err.body?.props)) {
        setDraft((d) => {
          const n = { ...d }
          for (const k of err.body.props) delete n[k]
          return n
        })
      }
      if (['locked', 'all_locked', 'closed', 'cancelled', 'cooling_off', 'self_excluded'].includes(err.code)) reload()
    }
  }

  const signIn = `/login?next=${encodeURIComponent(`/contests?c=${c.id}`)}`
  const names = c.leagues.map((k) => sportInfo(k).name)
  const leagues = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || 'the board'
  return (
    <>
      <header className="ct-hero">
        <p className="ct-eyebrow">
          Weekly contest <span aria-hidden="true">·</span> <span className={`ct-state is-${c.status === 'open' && !live ? 'locked' : c.status}`}>{statusLine(c, live)}</span>
        </p>
        <h1 className="page-title">{c.title}</h1>
        <p className="page-sub">
          {plural(c.slate.length, 'prop')} from {leagues}. Pick a side on each: every right pick is a point, and the most points wins.
        </p>
        {(c.prize || c.sponsor) && (
          <div className="ct-prize">
            {c.prize && (
              <p className="ct-prize__what">
                <span className="ct-prize__k">Prize</span>
                {c.prize}
              </p>
            )}
            {c.sponsor && (
              <p className="ct-prize__by">
                Sponsored by <b>{c.sponsor}</b>
              </p>
            )}
            {c.rulesUrl && (
              <a className="link ct-prize__rules" href={c.rulesUrl} target="_blank" rel="noopener noreferrer">
                Official rules
              </a>
            )}
          </div>
        )}
        <dl className="ct-facts">
          <div>
            <dt>Entries</dt>
            <dd className="num">{c.entries.toLocaleString()}</dd>
          </div>
          <div>
            <dt>{c.status === 'final' ? 'Finished' : 'Next lock'}</dt>
            <dd>{c.status === 'final' ? (c.finalAt ? dateOnly.format(c.finalAt) : '–') : next ? when(next.lockAt) : 'All locked'}</dd>
          </div>
          <div>
            <dt>Graded</dt>
            <dd className="num">
              {c.graded}/{c.slate.length}
            </dd>
          </div>
        </dl>
      </header>

      {c.status === 'cancelled' && <p className="notice ct-notice">This contest was cancelled. No winner will be picked.</p>}
      {c.status === 'final' && <Winners winners={data.winners} places={c.places} />}
      <EntryLine c={c} you={you} entry={entry} user={user} total={data.standings.total} signIn={signIn} />
      {block && (
        <p className="notice ct-notice ct-notice--block" role="status">
          {block.message}
        </p>
      )}

      <ol className="ct-slate" aria-label="The slate">
        {c.slate.map((p) => (
          <SlateProp key={p.id} p={p} mine={pickOf(p)} saved={saved[p.id] || null} locked={lockedNow(p)} canEdit={canEdit} onPick={choose} />
        ))}
      </ol>

      {canEdit && (
        <div className="ct-save" aria-live="polite">
          <div className="ct-save__row">
            <p className="ct-save__count">
              <b className="num">{picked}</b> of {c.slate.length} picked
              {dirty ? <span className="ct-save__dirty">, not saved yet</span> : entered ? <span className="muted">, saved</span> : null}
            </p>
            <button type="button" className="btn btn--lime" onClick={save} disabled={!dirty || st.busy || (!entered && !confirm)}>
              {st.busy ? 'Saving…' : entered ? 'Save changes' : 'Enter for free'}
            </button>
          </div>
          {!entered && (
            <label className="check ct-save__confirm">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              <span>
                I’m 21 or older and I’ve read the{' '}
                {c.rulesUrl ? (
                  <a className="link" href={c.rulesUrl} target="_blank" rel="noopener noreferrer">
                    official rules
                  </a>
                ) : (
                  <a className="link" href="#ct-rules">
                    rules
                  </a>
                )}
                .
              </span>
            </label>
          )}
          {st.err && (
            <p className="form-err" role="alert">
              {st.err.message}
            </p>
          )}
          {st.ok && <p className="form-ok">Saved. You can change any pick until its game starts.</p>}
        </div>
      )}

      <Standings rows={data.standings.rows} total={data.standings.total} entry={entry} final={c.status === 'final'} />
    </>
  )
}

/** Where the viewer stands: sign in, not in yet, or in with a score and a rank. */
function EntryLine({ c, you, entry, user, total, signIn }) {
  if (c.status === 'cancelled') return null
  if (!user) {
    if (c.status !== 'open') return null
    return (
      <div className="ct-entry">
        <p>Sign in to enter. It’s free, and it takes one tap with Google.</p>
        <Link to={signIn} className="btn btn--lime btn--s">
          Sign in to enter
        </Link>
      </div>
    )
  }
  if (!entry) {
    if (you?.block) return null
    return <p className="ct-entry">{c.status === 'open' ? 'You’re not in yet. Pick your sides below and enter for free.' : 'You didn’t enter this one.'}</p>
  }
  const score = `${plural(entry.points, 'point')}${entry.pending && c.status !== 'final' ? ` so far, ${entry.pending} still to play` : ''}`
  const place = entry.rank ? `, ${c.status === 'final' ? 'finished' : 'in'} ${ordinal(entry.rank)} of ${total.toLocaleString()}` : ''
  return (
    <p className="ct-entry is-in">
      <b>{c.status === 'final' ? 'Your result:' : 'You’re in:'}</b> {entry.picked} of {c.slate.length} picked, {score}
      {place}. <span className="muted">Last changed {when(entry.updatedAt)}.</span>
    </p>
  )
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'
  return `${n.toLocaleString()}${s}`
}

/** "Final: 19, over", "Final: yes", "Void: no points on this one". */
function resultText(p) {
  const r = p.result
  if (r === 'void') return 'Void: no points on this one'
  const side = r === 'o' ? (p.oneSided ? 'yes' : 'over') : r === 'u' ? (p.oneSided ? 'no' : 'under') : 'push'
  return `Final: ${!p.oneSided && p.value != null ? `${p.value}, ` : ''}${side}`
}

function SlateProp({ p, mine, saved, locked, canEdit, onPick }) {
  const r = p.result
  const verdict = mine && r ? (r === 'push' || r === 'void' ? 'none' : r === mine ? 'right' : 'wrong') : null
  return (
    <li className={`ct-prop${locked ? ' is-locked' : ''}${verdict ? ` is-${verdict}` : ''}`}>
      <div className="ct-prop__top">
        <Headshot src={p.headshot} name={p.name} size={44} />
        <div className="ct-prop__who">
          <p className="ct-prop__name">{p.name}</p>
          <p className="ct-prop__game muted">{p.teamAbbr && p.oppAbbr ? `${p.teamAbbr} ${p.home ? 'vs' : '@'} ${p.oppAbbr}` : p.game}</p>
        </div>
        <span className={`ct-lock${locked ? ' is-on' : ''}`}>{locked ? (r ? 'Final' : 'Locked') : `Locks ${when(p.lockAt)}`}</span>
      </div>
      <p className="ct-prop__stat">
        {p.oneSided ? (
          p.stat
        ) : (
          <>
            <b className="num">{p.line}</b> {p.stat}
          </>
        )}
      </p>
      <div className="ct-sides" role="group" aria-label={`Your pick: ${p.short} ${p.label}`}>
        {p.sides.map((s) => {
          const on = mine === s.side
          return (
            <button key={s.side} type="button" className={`ct-side${on ? ' is-on' : ''}`} aria-pressed={on} disabled={!canEdit || locked} onClick={() => onPick(p, s.side)}>
              {s.label}
            </button>
          )
        })}
      </div>
      {r ? (
        <p className="ct-result">
          <span>{resultText(p)}</span>
          {verdict === 'right' && <span className="ct-verdict is-right">Right, +1</span>}
          {verdict === 'wrong' && <span className="ct-verdict is-wrong">Wrong</span>}
          {verdict === 'none' && <span className="ct-verdict">No points</span>}
        </p>
      ) : (
        mine !== saved && <p className="ct-prop__note">{mine ? 'Not saved yet' : 'Pick removed, not saved yet'}</p>
      )}
    </li>
  )
}

function Winners({ winners, places }) {
  if (!winners?.length) return <p className="notice ct-notice">No winner this time: nobody got a pick right.</p>
  return (
    <section className="ct-winners" aria-label={places > 1 ? 'Winners' : 'Winner'}>
      <p className="ct-winners__k">{winners.length > 1 ? 'Winners' : 'Winner'}</p>
      <ol>
        {winners.map((w) => (
          <li key={w.rank}>
            <span className="ct-winners__name">{w.handle ? <Link to={`/u/${w.handle}`}>{w.name}</Link> : w.name}</span>
            <span className="num ct-winners__pts">{plural(w.points, 'point')}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function Standings({ rows, total, entry, final }) {
  const outside = entry?.rank && !rows.some((r) => r.you)
  return (
    <section className="section ct-standings" aria-labelledby="ct-standings">
      <div className="section__head">
        <h2 className="section__title" id="ct-standings">
          {final ? 'Final standings' : 'Standings'}
        </h2>
        <span className="section__aside muted">{plural(total, 'entry', 'entries')}</span>
      </div>
      {!rows.length ? (
        <p className="ct-empty">No entries yet. Be the first one in.</p>
      ) : (
        <div className="table-wrap">
          <table className="log ct-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Entrant</th>
                <th scope="col" className="num-col">
                  Points
                </th>
                <th scope="col" className="num-col">
                  Right
                </th>
                <th scope="col" className="num-col">
                  To play
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rank} className={r.you ? 'is-you' : undefined}>
                  <td className="num">{r.rank}</td>
                  <td className="ct-table__who">
                    {r.handle ? (
                      <Link to={`/u/${r.handle}`} className="link">
                        {r.name}
                      </Link>
                    ) : (
                      r.name
                    )}
                    {r.you && <span className="tag">You</span>}
                  </td>
                  <td className="num-col num">{r.points}</td>
                  <td className="num-col num">{r.correct + r.wrong ? `${r.correct}/${r.correct + r.wrong}` : '–'}</td>
                  <td className="num-col num">{r.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {outside && (
        <p className="ct-you-rank">
          You’re {ordinal(entry.rank)} with {plural(entry.points, 'point')}.
        </p>
      )}
      <p className="section__note ct-tiebreak">Ties go to the entry that was last changed earliest.</p>
    </section>
  )
}

function HowItWorks({ rulesUrl }) {
  return (
    <section className="section ct-how" id="ct-rules" aria-labelledby="ct-how">
      <div className="section__head">
        <h2 className="section__title" id="ct-how">
          How it works
        </h2>
      </div>
      <ul className="ct-how__list">
        <li>Pick over or under on each prop. Props like an anytime touchdown only have a yes side.</li>
        <li>You can change a pick until its game starts. Then it locks, game by game.</li>
        <li>Every right pick is a point. Pushes and voided props (a player who sits, a game called off) score nothing.</li>
        <li>Most points wins. A tie goes to the entry that was last changed earliest.</li>
        <li>One free entry per person, signed in with Google. You must be 21 or older.</li>
      </ul>
      {rulesUrl && (
        <p>
          <a className="link" href={rulesUrl} target="_blank" rel="noopener noreferrer">
            Read the official rules
          </a>
        </p>
      )}
    </section>
  )
}

function Past({ finals, current }) {
  const list = finals.filter((c) => c.id !== current)
  if (!list.length) return null
  return (
    <section className="section ct-past" aria-labelledby="ct-past">
      <div className="section__head">
        <h2 className="section__title" id="ct-past">
          Past contests
        </h2>
      </div>
      <ul className="ct-past__list">
        {list.map((c) => (
          <li key={c.id}>
            <Link to={`/contests?c=${c.id}`} className="ct-past__title">
              {c.title}
            </Link>
            <span className="muted">
              {c.finalAt ? dateOnly.format(c.finalAt) : ''} · {plural(c.entries, 'entry', 'entries')}
            </span>
            <span className="ct-past__win">{c.winners?.length ? `${c.winners.length > 1 ? 'Winners' : 'Winner'}: ${c.winners.map((w) => `${w.name} (${w.points})`).join(', ')}` : 'No winner'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

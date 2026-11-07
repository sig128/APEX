// Weekly contests: build a slate from the board, set the prize, sponsor and official rules,
// publish, close entries, cancel, and see the standings and how to reach the winners.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from './adminApi.js'
import { useApi } from '../lib/useApi.js'
import { useDebounced } from '../lib/hooks.js'
import { SPORTS, apiOf, sportInfo } from '../lib/leagues.js'

const MIN_PROPS = 5
const MAX_PROPS = 10
const STATUS = { draft: 'Draft', open: 'Open', closed: 'Entries closed', final: 'Final', cancelled: 'Cancelled' }
const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const when = (ms) => (Number.isFinite(ms) ? fmt.format(ms) : '')
const blank = () => ({ title: 'Weekly contest', prize: '', sponsor: '', rulesUrl: '', places: 1, slate: [] })

/** "nba:101.pts.o.24.5" -> "nba:101:pts": one line per player and stat on a slate. */
function statKey(ref) {
  const s = String(ref)
  const i = s.indexOf(':')
  const sport = i > 0 ? s.slice(0, i) : 'nfl'
  const [subject, market] = (i > 0 ? s.slice(i + 1) : s).split('.')
  return `${sport}:${subject}:${market}`
}
const formOf = (c) => ({ title: c.title || '', prize: c.prize || '', sponsor: c.sponsor || '', rulesUrl: c.rulesUrl || '', places: c.places || 1, slate: [...(c.refs || [])] })
const cardsOf = (c) => Object.fromEntries((c.slate || []).map((p, i) => [c.refs?.[i] || p.ref, { sport: p.sport, name: p.name, label: p.label, game: p.game, kickoff: p.kickoff }]))
const httpsOk = (u) => /^https:\/\/[^\s/]+\.[^\s]+/.test(u.trim())

export function Contests({ onLocked }) {
  const [list, setList] = useState(null)
  const [sel, setSel] = useState(null)
  const [err, setErr] = useState(null)
  // AdminPage hands down a fresh callback every render: keep the latest without reloading on it.
  // true when the session ran out (the page shows the password again)
  const lockedRef = useRef(onLocked)
  lockedRef.current = onLocked
  const locked = useCallback((e) => Boolean(lockedRef.current?.(e)), [])
  const load = useCallback(
    () =>
      adminApi('/api/admin/contests')
        .then((d) => {
          setList(d.contests)
          setErr(null)
        })
        .catch((e) => locked(e) || setErr(e.message)),
    [locked],
  )
  useEffect(() => {
    load()
  }, [load])
  return (
    <div className="adm-ct">
      <section className="adm-panel">
        <div className="adm-ct__head">
          <h3 className="adm-h3">Weekly contests</h3>
          <button type="button" className="btn btn--lime btn--s" onClick={() => setSel('new')}>
            New contest
          </button>
        </div>
        {err && <p className="form-err">{err}</p>}
        {!list ? (
          <p className="adm-empty">Loading…</p>
        ) : !list.length ? (
          <p className="adm-empty">No contests yet. Start one, pick 5 to 10 props from the board, and publish it.</p>
        ) : (
          <ul className="adm-ct__list">
            {list.map((c) => (
              <li key={c.id}>
                <button type="button" className={`adm-ct__item${sel === c.id ? ' is-on' : ''}`} onClick={() => setSel(c.id)} aria-pressed={sel === c.id}>
                  <span className="adm-ct__title">{c.title}</span>
                  <span className={`adm-ct__status is-${c.status}`}>{STATUS[c.status] || c.status}</span>
                  <span className="muted adm-ct__meta">
                    {c.props} props · {c.entries} {c.entries === 1 ? 'entry' : 'entries'}
                    {c.lockAt ? ` · first lock ${when(c.lockAt)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="adm-note">Entry is free and signed-in only, one entry per person. A contest with a prize can’t go live without a link to its official rules (https). Grading runs by itself as games finish.</p>
      </section>
      {sel && <Editor key={sel} id={sel === 'new' ? null : sel} locked={locked} onSaved={(id) => load().then(() => id && setSel(id))} onClose={() => setSel(null)} />}
    </div>
  )
}

function Editor({ id, locked, onSaved, onClose }) {
  const [view, setView] = useState(null)
  const [form, setForm] = useState(id ? null : blank())
  const [cards, setCards] = useState({})
  const [problems, setProblems] = useState([])
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const take = useCallback((d) => {
    setView(d)
    setForm(formOf(d.contest))
    setCards(cardsOf(d.contest))
  }, [])
  const reload = useCallback(() => (id ? adminApi(`/api/admin/contests/${id}`).then(take).catch((e) => locked(e) || setMsg({ ok: false, text: e.message })) : Promise.resolve()), [id, take, locked])
  useEffect(() => {
    reload()
  }, [reload])

  const run = async (fn, ok) => {
    setBusy(true)
    setMsg(null)
    setProblems([])
    try {
      const out = await fn()
      if (ok) setMsg({ ok: true, text: ok })
      return out
    } catch (e) {
      if (locked(e)) return null
      // which props the board refused, to mark them on the slate
      if (Array.isArray(e.body?.props)) setProblems(e.body.props)
      setMsg({ ok: false, text: e.message })
      return null
    } finally {
      setBusy(false)
    }
  }
  const body = () => ({ title: form.title, prize: form.prize, sponsor: form.sponsor, rulesUrl: form.rulesUrl.trim(), places: Number(form.places) || 1, slate: form.slate })
  /** Save the draft (or create it); resolves to the saved contest's id. */
  const saveDraft = async () => {
    if (!id) {
      const out = await adminApi('/api/admin/contests', { method: 'POST', body: body() })
      return out.contest.id
    }
    const out = await adminApi(`/api/admin/contests/${id}`, { method: 'PUT', body: body() })
    take({ ...(view || {}), contest: out.contest })
    return id
  }
  const save = () => run(saveDraft, 'Draft saved.').then((cid) => cid && !id && onSaved(cid))
  // only a saved draft publishes (its edits are saved first), so a refusal never leaves a stray copy
  const publish = () =>
    run(async () => {
      await saveDraft()
      await adminApi(`/api/admin/contests/${id}/publish`, { method: 'POST', body: {} })
      return true
    }, 'Published. Entries are open.').then((ok) => {
      if (!ok) return
      reload()
      onSaved(id)
    })
  const act = (path, ok, ask) => {
    if (ask && !window.confirm(ask)) return
    run(() => adminApi(`/api/admin/contests/${id}/${path}`, { method: 'POST', body: {} }), ok).then((out) => out && (reload(), onSaved(id)))
  }
  const gradeNow = () => run(() => adminApi('/api/admin/contests/grade', { method: 'POST', body: {} })).then((out) => {
    if (!out) return
    setMsg({ ok: true, text: out.graded ? `Graded ${out.graded} ${out.graded === 1 ? 'prop' : 'props'}${out.finals ? ` and finished ${out.finals} ${out.finals === 1 ? 'contest' : 'contests'}` : ''}.` : 'Nothing new to grade yet.' })
    reload()
    onSaved(id)
  })

  if (!form) return <section className="adm-panel">{msg ? <p className="form-err">{msg.text}</p> : <p className="adm-empty">Loading…</p>}</section>
  const c = view?.contest || null
  const draft = !c || c.status === 'draft'
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const have = new Set(form.slate.map(statKey))
  const add = (ref, card) => {
    if (have.has(statKey(ref)) || form.slate.length >= MAX_PROPS) return
    setForm((f) => ({ ...f, slate: [...f.slate, ref] }))
    setCards((m) => ({ ...m, [ref]: card }))
  }
  const remove = (ref) => setForm((f) => ({ ...f, slate: f.slate.filter((r) => r !== ref) }))
  const move = (i, by) =>
    setForm((f) => {
      const s = [...f.slate]
      const j = i + by
      if (j < 0 || j >= s.length) return f
      ;[s[i], s[j]] = [s[j], s[i]]
      return { ...f, slate: s }
    })
  const bad = new Map(problems.map((p) => [p.ref, p.error]))
  const needsRules = Boolean(form.prize.trim()) && !httpsOk(form.rulesUrl)
  const sizeOk = form.slate.length >= MIN_PROPS && form.slate.length <= MAX_PROPS

  return (
    <section className="adm-panel adm-ct-edit">
      <div className="adm-ct__head">
        <h3 className="adm-h3">{c ? c.title : 'New contest'}</h3>
        <div className="row">
          {c && c.status !== 'draft' && (
            <Link className="link" to={`/contests?c=${c.id}`}>
              Public page
            </Link>
          )}
          <button type="button" className="btn btn--quiet btn--s" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {c && c.status !== 'draft' && (
        <p className="muted adm-ct__meta">
          {STATUS[c.status]} · {c.entries} {c.entries === 1 ? 'entry' : 'entries'} · {c.graded}/{c.slate.length} graded
        </p>
      )}

      {draft ? (
        <>
          <div className="adm-ct-form">
            <label className="field">
              <span>Title</span>
              <input value={form.title} maxLength={80} onChange={set('title')} placeholder="Week 10 props contest" />
            </label>
            <label className="field">
              <span>Prize</span>
              <input value={form.prize} maxLength={200} onChange={set('prize')} placeholder="A $100 gift card (leave empty for no prize)" />
            </label>
            <label className="field">
              <span>Sponsor</span>
              <input value={form.sponsor} maxLength={80} onChange={set('sponsor')} placeholder="Who funds the prize" />
            </label>
            <label className="field">
              <span>Official rules link</span>
              <input type="url" inputMode="url" value={form.rulesUrl} maxLength={500} onChange={set('rulesUrl')} placeholder="https://…" aria-invalid={needsRules ? 'true' : undefined} />
              {needsRules && <small className="form-err">With a prize, the rules link is required and has to start with https://.</small>}
            </label>
            <label className="field">
              <span>Winners</span>
              <select value={form.places} onChange={set('places')}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Top entry' : `Top ${n}`}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <h4 className="adm-ct__sub">
            Slate <span className="muted">{form.slate.length} of {MIN_PROPS} to {MAX_PROPS} props</span>
          </h4>
          {!form.slate.length ? (
            <p className="adm-empty">Add props from the board below. Entrants pick the side; one-sided props (like anytime TD) only have yes.</p>
          ) : (
            <ol className="adm-ct-slate">
              {form.slate.map((ref, i) => {
                const k = cards[ref]
                return (
                  <li key={ref} className={bad.has(ref) ? 'is-bad' : undefined}>
                    <span className="adm-ct-slate__what">
                      <b>{k?.name || ref}</b> <span className="muted">{k ? `${k.label} · ${sportInfo(k.sport).name} · ${k.game}` : ''}</span>
                      {k?.kickoff ? <span className="muted adm-ct-slate__when">Locks {when(k.kickoff)}</span> : null}
                      {bad.has(ref) && <span className="form-err adm-ct-slate__err">{bad.get(ref)}</span>}
                    </span>
                    <span className="adm-ct-slate__btns">
                      <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </button>
                      <button type="button" className="icon-btn" aria-label="Move down" disabled={i === form.slate.length - 1} onClick={() => move(i, 1)}>
                        ↓
                      </button>
                      <button type="button" className="btn btn--quiet btn--s" onClick={() => remove(ref)}>
                        Remove
                      </button>
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
          <div className="row adm-ct__actions">
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={save}>
              Save draft
            </button>
            <button type="button" className="btn btn--lime" disabled={busy || !id || !sizeOk || needsRules || !form.title.trim()} onClick={publish} title={id ? undefined : 'Save the draft first'}>
              Publish
            </button>
            {c && (
              <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => act('cancel', 'Cancelled.', 'Cancel this draft?')}>
                Cancel draft
              </button>
            )}
          </div>
          {msg && <p className={msg.ok ? 'form-ok' : 'form-err'}>{msg.text}</p>}
          <p className="adm-note">
            {id ? '' : 'Save the draft first, then publish it. '}Publishing checks every prop against the board again and freezes it: names, lines, sides, games and start times stay as they are at that moment.
          </p>
          <BoardPicker have={have} full={form.slate.length >= MAX_PROPS} onAdd={add} />
        </>
      ) : (
        <Live view={view} busy={busy} msg={msg} act={act} gradeNow={gradeNow} />
      )}
    </section>
  )
}

/** A published contest: its settings, the slate with locks and results, standings and winners. */
function Live({ view, busy, msg, act, gradeNow }) {
  const c = view.contest
  const active = c.status === 'open' || c.status === 'closed'
  return (
    <>
      <dl className="adm-ct-facts">
        <div>
          <dt>Prize</dt>
          <dd>{c.prize || 'None'}</dd>
        </div>
        <div>
          <dt>Sponsor</dt>
          <dd>{c.sponsor || '–'}</dd>
        </div>
        <div>
          <dt>Rules</dt>
          <dd>
            {c.rulesUrl ? (
              <a className="link" href={c.rulesUrl} target="_blank" rel="noopener noreferrer">
                {c.rulesUrl}
              </a>
            ) : (
              '–'
            )}
          </dd>
        </div>
        <div>
          <dt>Winners</dt>
          <dd>{c.places === 1 ? 'Top entry' : `Top ${c.places}`}</dd>
        </div>
      </dl>
      <ol className="adm-ct-slate">
        {c.slate.map((p) => (
          <li key={p.id}>
            <span className="adm-ct-slate__what">
              <b>{p.name}</b> <span className="muted">{p.label} · {p.game}</span>
              <span className="muted adm-ct-slate__when">{p.result ? `Graded: ${p.value != null && p.result !== 'void' ? `${p.value}, ` : ''}${{ o: p.oneSided ? 'yes' : 'over', u: p.oneSided ? 'no' : 'under', push: 'push', void: 'void' }[p.result]}` : p.locked ? 'Locked, waiting on the final' : `Locks ${when(p.lockAt)}`}</span>
            </span>
          </li>
        ))}
      </ol>
      {active && (
        <div className="row adm-ct__actions">
          {c.status === 'open' && (
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => act('close', 'Entries closed.', 'Close entries? Nobody can enter or change picks after this.')}>
              Close entries
            </button>
          )}
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={gradeNow}>
            Grade now
          </button>
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => act('cancel', 'Cancelled.', 'Cancel this contest? No winner will be picked.')}>
            Cancel contest
          </button>
        </div>
      )}
      {msg && <p className={msg.ok ? 'form-ok' : 'form-err'}>{msg.text}</p>}
      {view.winners?.length > 0 && (
        <>
          <h4 className="adm-ct__sub">{view.winners.length > 1 ? 'Winners' : 'Winner'}</h4>
          <ul className="adm-ct-win">
            {view.winners.map((w) => (
              <li key={w.uid}>
                <b>
                  {w.rank}. {w.name}
                </b>{' '}
                <span className="muted">
                  {w.points} points · {w.email || 'no email on file'} · {w.uid}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 className="adm-ct__sub">
        Standings <span className="muted">{view.standings.total} entries</span>
      </h4>
      {!view.standings.rows.length ? (
        <p className="adm-empty">No entries yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="log adm-table--tight">
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
                <th scope="col" className="adm-hide-s">
                  Last change
                </th>
              </tr>
            </thead>
            <tbody>
              {view.standings.rows.map((r) => (
                <tr key={r.uid}>
                  <td className="num">{r.rank}</td>
                  <td>
                    {r.name} <span className="muted adm-hide-s">{r.uid}</span>
                  </td>
                  <td className="num-col num">{r.points}</td>
                  <td className="num-col num">{r.correct + r.wrong ? `${r.correct}/${r.correct + r.wrong}` : '–'}</td>
                  <td className="num-col num">{r.pending}</td>
                  <td className="adm-hide-s muted">{when(r.changedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/** Props from a league's current board (the same data the props page shows), to add to the slate. */
function BoardPicker({ have, full, onAdd }) {
  const [sport, setSport] = useState('nfl')
  const [game, setGame] = useState('')
  const [market, setMarket] = useState('core')
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 300)
  const params = new URLSearchParams({ market, sort: 'kickoff', limit: '60' })
  if (game) params.set('game', game)
  if (dq) params.set('q', dq)
  const board = useApi(`${apiOf(sport)}/board?${params}`, { maxAgeMs: 60_000 })
  const rows = board.data?.rows || []
  const games = board.data?.facets?.games || []
  return (
    <div className="adm-ct-board">
      <h4 className="adm-ct__sub">Add from the board</h4>
      <div className="adm-ct-board__bar">
        <label className="adm-select">
          <span className="sr-only">League</span>
          <select
            value={sport}
            onChange={(e) => {
              setSport(e.target.value)
              setGame('')
            }}
          >
            {SPORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-select">
          <span className="sr-only">Game</span>
          <select value={game} onChange={(e) => setGame(e.target.value)}>
            <option value="">Every game still to start</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label} · {when(Date.parse(g.date))}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-select">
          <span className="sr-only">Stats</span>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="core">Main stats</option>
            <option value="all">Every stat</option>
          </select>
        </label>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Player" aria-label="Find a player" />
      </div>
      {board.error && !board.data ? (
        <p className="form-err">{board.error.message}</p>
      ) : board.loading ? (
        <p className="adm-empty">Loading the board…</p>
      ) : !rows.length ? (
        <p className="adm-empty">{board.data?.pending ? 'The board is still loading game logs. Try again in a few seconds.' : 'Nothing on this board right now.'}</p>
      ) : (
        <ul className="adm-ct-board__rows">
          {rows.map((r) => {
            const ref = `${sport}:${r.id}`
            const added = have.has(statKey(ref))
            const label = r.oneSided ? `${r.marketLabel} (yes only)` : `${r.line} ${r.marketLabel}`
            return (
              <li key={r.id}>
                <span className="adm-ct-slate__what">
                  <b>{r.name}</b> <span className="muted">{r.teamAbbr} · {label}</span>
                  <span className="muted adm-ct-slate__when">{when(Date.parse(r.kickoff))}</span>
                </span>
                <button type="button" className="btn btn--quiet btn--s" disabled={added || full} onClick={() => onAdd(ref, { sport, name: r.name, label, game: `${r.teamAbbr} vs ${r.oppAbbr}`, kickoff: Date.parse(r.kickoff) })}>
                  {added ? 'Added' : 'Add'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

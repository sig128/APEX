import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { Skeleton, ErrorBox } from '../ui/Bits.jsx'

// Tips & Tricks: the betting legend. Search it, browse by topic or A to Z. Each entry: what it
// is, a worked example, a pro tip and a common mistake. The math and strategy entries are in full
// for members (the server decides); the basics are free.

const norm = (s) => String(s || '').toLowerCase()

function Entry({ x, on, onSee }) {
  return (
    <article id={x.id} className={`lg-entry${on ? ' is-on' : ''}`} aria-labelledby={`${x.id}-h`}>
      <header className="lg-entry__head">
        <h3 id={`${x.id}-h`} className="lg-entry__term">
          {x.term}
        </h3>
        <span className={`lg-level is-${x.level}`}>{x.level === 'advanced' ? 'Pro' : 'Free'}</span>
      </header>
      <p className="lg-entry__def">{x.def}</p>
      {x.locked ? (
        <p className="lg-entry__lock">
          The worked example, pro tip and common mistake are part of Pro. <Link to="/pricing">See Pro</Link>
        </p>
      ) : (
        <dl className="lg-entry__parts">
          <div>
            <dt>Example</dt>
            <dd>{x.example}</dd>
          </div>
          <div>
            <dt>Pro tip</dt>
            <dd>{x.tip}</dd>
          </div>
          <div>
            <dt>Common mistake</dt>
            <dd>{x.mistake}</dd>
          </div>
        </dl>
      )}
      {x.see?.length > 0 && (
        <p className="lg-entry__see">
          See also:{' '}
          {x.see.map((id, i) => (
            <span key={id}>
              {i ? ', ' : ''}
              <a href={`#${id}`} onClick={(e) => onSee(e, id)}>
                {id.replace(/-/g, ' ')}
              </a>
            </span>
          ))}
        </p>
      )}
    </article>
  )
}

export function LearnPage() {
  useTitle('Tips & Tricks')
  const { data, error, refresh } = useApi('/api/learn', { maxAgeMs: 5 * 60_000 })
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [az, setAz] = useState(false)
  const loc = useLocation()
  const [on, setOn] = useState(null)
  const termOf = useMemo(() => new Map((data?.entries || []).map((x) => [x.id, x.term])), [data])
  // arriving at /learn#vig: show that entry
  useEffect(() => {
    const id = decodeURIComponent(loc.hash.slice(1))
    if (!id || !data) return
    setQ('')
    setCat('all')
    setOn(id)
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 50)
  }, [loc.hash, data])
  const list = useMemo(() => {
    let xs = data?.entries || []
    if (cat !== 'all') xs = xs.filter((x) => x.cat === cat)
    const n = norm(q).trim()
    if (n) xs = xs.filter((x) => norm(`${x.term} ${x.def} ${x.example || ''} ${x.tip || ''}`).includes(n))
    if (az) xs = [...xs].sort((a, b) => a.term.localeCompare(b.term))
    return xs
  }, [data, cat, q, az])
  const see = (e, id) => {
    e.preventDefault()
    setQ('')
    setCat('all')
    setOn(id)
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 50)
  }
  const grouped = !az && cat === 'all' && !q
  return (
    <div className="container page narrow lg">
      <header className="page-head">
        <h1 className="page-title">Tips &amp; Tricks</h1>
        <p className="page-sub">The words, the math and the habits behind betting props, each with a worked example. Basics are free; the math and strategy are part of Pro.</p>
      </header>
      <div className="lg-tools">
        <input type="search" className="lg-search" placeholder="Search: vig, CLV, push, parlays…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search Tips & Tricks" />
        <div className="lg-cats" role="group" aria-label="Topics">
          <button type="button" className={`pill${cat === 'all' ? ' is-on' : ''}`} aria-pressed={cat === 'all'} onClick={() => setCat('all')}>
            All
          </button>
          {(data?.categories || []).map((c) => (
            <button key={c.key} type="button" className={`pill${cat === c.key ? ' is-on' : ''}`} aria-pressed={cat === c.key} onClick={() => setCat(c.key)}>
              {c.name}
            </button>
          ))}
          <button type="button" className={`pill${az ? ' is-on' : ''}`} aria-pressed={az} onClick={() => setAz((v) => !v)}>
            A to Z
          </button>
        </div>
      </div>
      <ErrorBox error={error} onRetry={refresh} />
      {!data && !error && <Skeleton rows={6} />}
      {data && !list.length && <p className="muted">Nothing matches “{q}”. Try a shorter word.</p>}
      {grouped
        ? (data?.categories || []).map((c) => {
            const xs = list.filter((x) => x.cat === c.key)
            if (!xs.length) return null
            return (
              <section key={c.key} className="lg-sec" aria-labelledby={`lg-${c.key}`}>
                <h2 id={`lg-${c.key}`} className="lg-sec__h">
                  {c.name}
                </h2>
                {xs.map((x) => (
                  <Entry key={x.id} x={{ ...x, see: x.see?.filter((id) => termOf.has(id)) }} on={on === x.id} onSee={see} />
                ))}
              </section>
            )
          })
        : list.map((x) => <Entry key={x.id} x={x} on={on === x.id} onSee={see} />)}
    </div>
  )
}

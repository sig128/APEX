import { useEffect, useRef, useState } from 'react'
import { useApi } from '../lib/useApi.js'
import { apiOf } from '../lib/sport.js'
import { TeamLogo } from './Img.jsx'
import { Locked } from './Locked.jsx'
import { Skeleton } from './Bits.jsx'
import './LineupView.css'

// Both teams' lineups for a prop's game, laid out the way the sport lines up (backend/src/lineups):
// the player in lime, the opponents he faces outlined, starters who are out named under the
// player standing in for them. Part of Pro.

const TAG = [
  [/^out|injured reserve|suspen/i, 'O', 'out'],
  [/^doubt/i, 'D', 'doubt'],
  [/^quest/i, 'Q', 'quest'],
  [/^day/i, 'DTD', 'quest'],
  [/^prob/i, 'P', 'prob'],
]
const tagOf = (inj) => {
  const s = String(inj?.status || '')
  if (!s) return null
  const hit = TAG.find(([re]) => re.test(s))
  return hit ? { text: hit[1], tone: hit[2], title: [s, inj.note].filter(Boolean).join(': ') } : null
}

function Inj({ inj }) {
  const t = tagOf(inj)
  if (!t) return null
  return (
    <abbr className={`lu-inj is-${t.tone}`} title={t.title}>
      {t.text}
    </abbr>
  )
}

function Slot({ s, top }) {
  const cls = ['lu-slot', top ? 'is-top' : 'is-bottom', s.focus === true && 'is-focus', s.focus === 'behind' && 'is-behind', s.match === 2 && 'is-match', s.match === 1 && 'is-near'].filter(Boolean).join(' ')
  return (
    <li className={cls} style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}>
      <span className="lu-pos">{s.pos}</span>
      <span className="lu-name">
        {s.player.short || s.player.name}
        <Inj inj={s.player.inj} />
      </span>
      {s.out && <span className="lu-out">for {s.out.short || s.out.name}, out</span>}
    </li>
  )
}

function Half({ unit, top, family }) {
  if (!unit) return null
  return (
    <div className={`lu-half ${top ? 'is-top' : 'is-bottom'}`}>
      <p className="lu-team">
        <TeamLogo src={unit.team?.logo} abbr={unit.team?.abbr} size={22} />
        <span className="lu-team__abbr">{unit.team?.abbr}</span>
        <span className="lu-team__unit">
          {unit.label}
          {unit.formation && family !== 'basketball' ? `, ${unit.formation}` : ''}
        </span>
      </p>
      <ol className="lu-slots" aria-hidden="true">
        {unit.slots.map((s) => (
          <Slot key={s.key} s={s} top={top} />
        ))}
      </ol>
    </div>
  )
}

/** The plain list of both lineups: for screen readers, and for reading on a small screen. */
function Lists({ view }) {
  const one = (u) =>
    u && (
      <div className="lu-list">
        <p className="lu-list__team">
          {u.team?.abbr} {u.label.toLowerCase()}
        </p>
        <ul>
          {u.slots.map((s) => (
            <li key={s.key} className={s.focus === true ? 'is-focus' : s.match ? 'is-match' : ''}>
              <span className="lu-list__pos">{s.pos}</span> {s.player.name}
              {tagOf(s.player.inj) ? <span className="muted"> ({s.player.inj.status.toLowerCase()})</span> : ''}
              {s.out ? <span className="muted">, for {s.out.name} (out)</span> : ''}
            </li>
          ))}
        </ul>
      </div>
    )
  return (
    <details className="lu-lists">
      <summary>Every starter</summary>
      <div className="lu-lists__grid">
        {one(view.bottom)}
        {one(view.top)}
      </div>
    </details>
  )
}

function Board({ sport, propId }) {
  const { data, error, loading } = useApi(`${apiOf(sport)}/props/${encodeURIComponent(propId)}/lineup`, { maxAgeMs: 120_000 })
  const scroll = useRef(null)
  const [wide, setWide] = useState(false)
  const view = data?.view
  // on a narrow screen the field scrolls sideways: start it on the player, and say so
  useEffect(() => {
    const box = scroll.current
    if (!box) return
    const check = () => setWide(box.scrollWidth > box.clientWidth + 4)
    check()
    const el = box.querySelector('.is-focus, .is-behind')
    if (el && box.scrollWidth > box.clientWidth) {
      const r = el.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      box.scrollLeft += r.left + r.width / 2 - (b.left + b.width / 2)
    }
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [view])
  if (loading && !data) return <Skeleton kind="chart" rows={1} />
  if (error && !data) return <p className="muted lu-empty">Lineups aren’t available right now. Try again in a minute.</p>
  if (!view) return <p className="muted lu-empty">{data?.reason || 'No lineups for this game yet.'}</p>
  const fam = view.family
  return (
    <>
      <p className="lu-sub">
        {view.top?.team?.abbr} {fam === 'football' ? view.top?.label.toLowerCase() : ''} above, {view.bottom?.team?.abbr} {fam === 'football' ? view.bottom?.label.toLowerCase() : ''} below
        {data.focusName ? `. ${data.focusName} in lime, the opponents to watch outlined.` : '.'}
      </p>
      <div className="lu-scroll" ref={scroll}>
        <div className={`lu-field lu-${fam}${data.focusName ? ' has-focus' : ''}`} role="img" aria-label={`${view.top?.team?.abbr} and ${view.bottom?.team?.abbr} lineups`}>
          <Half unit={view.top} top family={fam} />
          <div className="lu-line" aria-hidden="true" />
          <Half unit={view.bottom} family={fam} />
        </div>
      </div>
      {wide && <p className="lu-hint">Swipe the field sideways to see every position.</p>}
      {data.focusNote && <p className="lu-note">{data.focusNote}</p>}
      {view.matchups?.length > 0 && (
        <div className="lu-matchups">
          {view.matchups.map((m) => (
            <div key={m.title} className="lu-matchup">
              <p className="lu-matchup__title">{m.title}</p>
              <ul>
                {m.players.map((p) => (
                  <li key={p.id}>
                    <span className="lu-matchup__pos">{p.pos}</span>
                    <span className="lu-matchup__name">{p.name}</span>
                    <Inj inj={p.inj} />
                    {p.out && <span className="muted lu-matchup__for">for {p.out.name}, out</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <Lists view={view} />
      {data.notes?.length > 0 && <p className="muted small lu-src">{data.notes.join(' ')} Source: ESPN.</p>}
    </>
  )
}

/** The lineups section of a prop page. */
export function LineupView({ sport, propId }) {
  return (
    <section className="lineup" aria-labelledby="lineup-h">
      <h2 id="lineup-h" className="lineup__title">
        Lineups and matchups
      </h2>
      <Locked need="pro" title="Lineups and matchups">
        <Board sport={sport} propId={propId} />
      </Locked>
    </section>
  )
}

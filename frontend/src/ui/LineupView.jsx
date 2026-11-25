import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { apiOf } from '../lib/sport.js'
import { TeamLogo } from './Img.jsx'
import { Locked } from './Locked.jsx'
import { Skeleton } from './Bits.jsx'
import './LineupView.css'

// Both teams' lineups for a prop's game, laid out the way the sport lines up (backend/src/lineups):
// each player with his photo, the prop's player in lime, the opponents he faces outlined, starters
// who are out named under the player standing in for them. Tap anyone for his card: number, size,
// age, years in, school, injury and his props in this game. Part of Pro.

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

/** A player's photo, cropped round; his initials when ESPN has none. Key it by player. */
function Face({ src, name, className = '' }) {
  const [bad, setBad] = useState(false)
  const initials = String(name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
  return (
    <span className={`headshot ${className}`}>
      {src && !bad ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} /> : <span className="headshot__initials" aria-hidden="true">{initials}</span>}
    </span>
  )
}

function Slot({ s, top, team, person, selected, onPick }) {
  const p = s.player
  const cls = ['lu-slot', top ? 'is-top' : 'is-bottom', s.focus === true && 'is-focus', s.focus === 'behind' && 'is-behind', s.match === 2 && 'is-match', s.match === 1 && 'is-near', selected && 'is-sel'].filter(Boolean).join(' ')
  const label = [p.name, s.pos, team?.abbr, p.inj?.status, s.out && `in for ${s.out.name}, out`].filter(Boolean).join(', ')
  return (
    <li className={cls} style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}>
      <button type="button" className="lu-chip" aria-pressed={selected} aria-label={label} onClick={() => onPick(p.id)}>
        <Face key={p.id} src={person?.photo} name={p.name} className="lu-face" />
        <span className="lu-pos">{s.pos}</span>
        <span className="lu-name">
          {p.short || p.name}
          <Inj inj={p.inj} />
        </span>
        {s.out && <span className="lu-out">for {s.out.short || s.out.name}, out</span>}
      </button>
    </li>
  )
}

function Half({ unit, top, family, people, sel, onPick }) {
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
      <ol className="lu-slots" aria-label={`${unit.team?.abbr || ''} ${unit.label}`.trim()}>
        {unit.slots.map((s) => (
          <Slot key={s.key} s={s} top={top} team={unit.team} person={people?.[s.player.id]} selected={sel === s.player.id} onPick={onPick} />
        ))}
      </ol>
    </div>
  )
}

const HAND = { L: 'Left', R: 'Right', B: 'Both', S: 'Switch' }

/** What the roster says, as label and value, in the order a scout reads it. */
function bioRows(bio, family) {
  if (!bio) return []
  const rows = []
  if (bio.ht) rows.push(['Height', bio.ht])
  if (bio.wt) rows.push(['Weight', bio.wt])
  if (bio.age) rows.push(['Age', String(bio.age)])
  if (bio.exp != null) rows.push(['Experience', bio.exp === 0 ? 'Rookie' : `${bio.exp} ${bio.exp === 1 ? 'year' : 'years'}`])
  if (family === 'hockey' && bio.hand) rows.push(['Shoots', HAND[bio.hand] || bio.hand])
  if (family === 'baseball' && (bio.bats || bio.throws)) rows.push(['Bats / throws', `${HAND[bio.bats] || bio.bats || '?'} / ${HAND[bio.throws] || bio.throws || '?'}`])
  if (bio.college) rows.push(['College', bio.college])
  if (bio.nat) rows.push(['Nation', bio.nat])
  return rows
}

/** The player picked on the field: who he is and what he's in for in this game. */
function PlayerCard({ who, person, sport, family, cardRef }) {
  if (!who) return null
  const { p, pos, team, out, focus } = who
  const t = tagOf(p.inj)
  const bio = bioRows(person?.bio, family)
  const props = person?.props || []
  return (
    <section className="lu-card" ref={cardRef} aria-live="polite" aria-label={`${p.name}, details`}>
      <Face key={p.id} src={person?.photo} name={p.name} className="lu-card__face" />
      <div className="lu-card__body">
        <p className="lu-card__name">
          {p.name}
          {person?.jersey && <span className="lu-card__num num">#{person.jersey}</span>}
        </p>
        <p className="lu-card__role">
          <TeamLogo src={team?.logo} abbr={team?.abbr} size={18} />
          <span>{team?.name || team?.abbr}</span>
          <span className="lu-card__pos">{pos}</span>
          {focus && <span className="lu-card__this">This prop</span>}
        </p>
        {out && (
          <p className="lu-card__line">
            Starting for {out.name}, who is out{out.inj?.note && out.inj.note.toLowerCase() !== 'out' ? ` (${out.inj.note.toLowerCase()})` : ''}.
          </p>
        )}
        {t && (
          <p className={`lu-card__line is-${t.tone}`}>
            {p.inj.status}
            {p.inj.note ? `: ${p.inj.note}` : ''}
          </p>
        )}
        {bio.length > 0 && (
          <dl className="lu-card__bio">
            {bio.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {props.length > 0 ? (
          <div className="lu-card__props">
            <p className="lu-card__k">Props in this game{person.propCount > props.length ? `, best ${props.length} of ${person.propCount}` : ''}</p>
            <ul>
              {props.map((x) => (
                <li key={x.id}>
                  <Link to={`/${sport}/prop/${encodeURIComponent(x.id)}`}>
                    {x.label}
                    {x.prob != null && <b className="num">{Math.round(x.prob * 100)}%</b>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="lu-card__line muted">No props for this player in this game.</p>
        )}
        {person?.page && (
          <Link className="link lu-card__page" to={`/${sport}/player/${encodeURIComponent(p.id)}`}>
            Player page
          </Link>
        )}
      </div>
    </section>
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

/** Where a player stands in the view: his slot, his team, whether he's the prop's player. */
function whoIs(view, id) {
  for (const unit of [view?.bottom, view?.top]) {
    const s = unit?.slots.find((x) => x.player?.id === id)
    if (s) return { p: s.player, pos: s.pos, team: unit.team, out: s.out || null, focus: s.focus === true }
  }
  return null
}

function Board({ sport, propId }) {
  const { data, error, loading } = useApi(`${apiOf(sport)}/props/${encodeURIComponent(propId)}/lineup`, { maxAgeMs: 120_000 })
  const scroll = useRef(null)
  const card = useRef(null)
  const [wide, setWide] = useState(false)
  const [sel, setSel] = useState(null)
  const view = data?.view
  const people = data?.people || null
  // the card opens on the prop's player; a new prop starts over
  const focusId = useMemo(() => [view?.bottom, view?.top].flatMap((u) => u?.slots || []).find((s) => s.focus === true)?.player.id || null, [view])
  useEffect(() => setSel(null), [propId])
  const selId = (sel && whoIs(view, sel) ? sel : null) || focusId || view?.matchups?.[0]?.players?.[0]?.id || null
  const who = whoIs(view, selId)
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
  const pick = (id) => {
    setSel(id)
    // bring the card into view under the field, without jumping when it's already showing
    requestAnimationFrame(() => {
      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      card.current?.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' })
    })
  }
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
        <div className={`lu-field lu-${fam}${data.focusName ? ' has-focus' : ''}`} role="group" aria-label={`${view.top?.team?.abbr} and ${view.bottom?.team?.abbr} lineups`}>
          <Half unit={view.top} top family={fam} people={people} sel={selId} onPick={pick} />
          <div className="lu-line" aria-hidden="true" />
          <Half unit={view.bottom} family={fam} people={people} sel={selId} onPick={pick} />
        </div>
      </div>
      <p className="lu-hint">{wide ? 'Swipe the field sideways to see every position. Tap a player for details.' : 'Tap a player for details.'}</p>
      <PlayerCard who={who} person={people?.[selId]} sport={sport} family={fam} cardRef={card} />
      {data.focusNote && <p className="lu-note">{data.focusNote}</p>}
      {view.matchups?.length > 0 && (
        <div className="lu-matchups">
          {view.matchups.map((m) => (
            <div key={m.title} className="lu-matchup">
              <p className="lu-matchup__title">{m.title}</p>
              <ul>
                {m.players.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="lu-matchup__who" onClick={() => pick(p.id)} aria-label={`${p.name}, ${p.pos}: details`}>
                      <Face key={p.id} src={people?.[p.id]?.photo} name={p.name} />
                      <span className="lu-matchup__pos">{p.pos}</span>
                      <span className="lu-matchup__name">
                        {p.name}
                        <Inj inj={p.inj} />
                      </span>
                      {p.out && <span className="muted lu-matchup__for">for {p.out.name}, out</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <Lists view={view} />
      {data.notes?.length > 0 && <p className="muted small lu-src">{data.notes.join(' ')} Lineups, photos and details from ESPN.</p>}
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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useWatch } from '../lib/watch.js'
import { useApi } from '../lib/useApi.js'
import { useTitle, useMedia } from '../lib/hooks.js'
import { PropRow } from '../ui/PropRow.jsx'
import { Pills, Skeleton, ErrorBox, Empty, Warming } from '../ui/Bits.jsx'
import { useSport, apiOf, sportInfo } from '../lib/sport.js'
import { Headshot, TeamLogo } from '../ui/Img.jsx'
import { kickoff } from '../lib/format.js'

const WINDOWS = [
  { key: 'L5', label: 'Last 5' },
  { key: 'L10', label: 'Last 10' },
  { key: 'L20', label: 'Last 20' },
  { key: 'season', label: 'This season' },
  { key: 'h2h', label: 'Vs opponent' },
  { key: 'venue', label: 'Home/away' },
]
const SORTS = [
  { key: 'score', label: 'PropPickz score' },
  { key: 'hit', label: 'Hit rate' },
  { key: 'prob', label: 'Probability' },
  { key: 'edge', label: 'Edge over the book' },
  { key: 'line', label: 'Line' },
  { key: 'streak', label: 'Streak' },
  { key: 'move', label: 'Line move' },
  { key: 'kickoff', label: 'Kickoff' },
]
/** How a sort reads in each direction: numbers high to low by default, start times earliest first. */
const naturalDir = (sort) => (sort === 'kickoff' ? 'asc' : 'desc')
const dirLabel = (sort, dir) => (sort === 'kickoff' ? (dir === 'asc' ? 'Earliest first' : 'Latest first') : dir === 'asc' ? 'Lowest first' : 'Highest first')
const withCount = (label, n) => (
  <>
    {label}
    {n != null && <span className="pill__n">{n.toLocaleString()}</span>}
  </>
)
const FOOTBALL = new Set(['nfl', 'ncaaf'])
// each league's position groups, until the board's own list arrives
const pills = (list) => list.map(([key, label]) => ({ key, label }))
const BASKETBALL = pills([['G', 'Guards'], ['F', 'Forwards'], ['C', 'Centers']])
const GROUPS = {
  nfl: pills([['QB', 'QB'], ['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE']]),
  nba: BASKETBALL,
  ncaab: BASKETBALL,
  wnba: BASKETBALL,
  nhl: pills([['F', 'Forwards'], ['D', 'Defensemen'], ['G', 'Goalies']]),
  mlb: pills([['BAT', 'Hitters'], ['SP', 'Starting pitchers']]),
}
GROUPS.ncaaf = GROUPS.nfl
/** Position filters from the league's own groups: QB/RB/WR/TE, guards/forwards/centers, hitters/pitchers. */
const groupPills = (groups, sport) =>
  groups?.length ? groups.map((g) => ({ key: g.key, label: FOOTBALL.has(sport) ? g.key : g.label.charAt(0).toUpperCase() + g.label.slice(1) })) : GROUPS[sport] || GROUPS.nfl
const MIN_HIT = [
  { key: '0.6', label: '60%+' },
  { key: '0.7', label: '70%+' },
  { key: '0.8', label: '80%+' },
  { key: '1', label: '100%' },
]
const SIDES = [
  { key: 'o', label: 'Overs' },
  { key: 'u', label: 'Unders' },
]
const PAGE = 40

/** The slate's games as matchups to tap: both teams, kickoff, and how many props each has. */
function GamePicker({ games, value, mine, onPick }) {
  const mineKey = mine.join(',')
  return (
    <div className="gpick" role="group" aria-labelledby="gpick-k">
      <span className="filters__k" id="gpick-k">
        Game
      </span>
      <div className="gpick__row">
        <button type="button" className={`gchip gchip--plain${!value ? ' is-on' : ''}`} aria-pressed={!value} onClick={() => onPick('')}>
          All games
        </button>
        {mine.length > 0 && (
          <button type="button" className={`gchip gchip--plain${value === mineKey ? ' is-on' : ''}`} aria-pressed={value === mineKey} onClick={() => onPick(value === mineKey ? '' : mineKey)}>
            My games <span className="gchip__n num">{mine.length}</span>
          </button>
        )}
        {games.map((g) => {
          const on = value === g.id
          return (
            <button key={g.id} type="button" className={`gchip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onPick(on ? '' : g.id)} aria-label={`${g.away?.abbr} at ${g.home?.abbr}, ${kickoff(g.date)}, ${g.count} props`}>
              <span className="gchip__teams" aria-hidden="true">
                <TeamLogo src={g.away?.logo} abbr={g.away?.abbr} size={22} className="gchip__logo" />
                <b>{g.away?.abbr}</b>
                <span className="gchip__at">@</span>
                <TeamLogo src={g.home?.logo} abbr={g.home?.abbr} size={22} className="gchip__logo" />
                <b>{g.home?.abbr}</b>
              </span>
              <span className="gchip__meta" aria-hidden="true">
                <span>{kickoff(g.date)}</span>
                <span className="gchip__n num">{g.count}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Everyone in the picked game with a prop, by team: tap one to see only theirs. */
function RosterPicker({ players, value, games, onPick }) {
  const teams = []
  for (const p of players) {
    let t = teams.find((x) => x.abbr === p.teamAbbr)
    if (!t) teams.push((t = { abbr: p.teamAbbr, players: [] }))
    t.players.push(p)
  }
  const logoOf = (abbr) => games.flatMap((g) => [g.home, g.away]).find((x) => x?.abbr === abbr)?.logo || null
  const title = games.length === 1 ? `Players in ${games[0].away?.abbr} @ ${games[0].home?.abbr}` : 'Players in these games'
  return (
    <div className="roster" role="group" aria-labelledby="roster-k">
      <div className="roster__head">
        <span className="roster__title" id="roster-k">
          {title}
        </span>
        {value ? (
          <button type="button" className="link roster__all" onClick={() => onPick('')}>
            Show every player
          </button>
        ) : (
          <span className="roster__hint">Tap a player to see only their props</span>
        )}
      </div>
      {players.length ? (
        <div className="roster__teams">
          {teams.map((t) => (
            <div key={t.abbr} className="roster__team">
              <p className="roster__abbr">
                <TeamLogo src={logoOf(t.abbr)} abbr={t.abbr} size={20} />
                {t.abbr}
              </p>
              <div className="roster__list">
                {t.players.map((p) => {
                  const on = value === p.id
                  return (
                    <button key={p.id} type="button" className={`pchip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onPick(on ? '' : p.id)}>
                      <Headshot src={p.headshot} name={p.name} size={30} className="pchip__img" />
                      <span className="pchip__name">{p.short || p.name}</span>
                      {p.pos && <span className="pchip__pos">{p.pos}</span>}
                      <span className="pchip__n num" aria-label={`${p.count} props`}>
                        {p.count}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="roster__none">No player props in this game under these filters.</p>
      )}
    </div>
  )
}

/** Every prop on the slate, filtered and sorted however you like. Filters live in the URL so a view can be shared. */
export function PropsPage() {
  const sport = useSport()
  const [q, setQ] = useSearchParams()
  const get = (k, d = '') => q.get(k) ?? d
  // Filters build on the address bar as it is at the moment of the tap, not as of the last
  // render, so two quick taps both count (the second used to undo the first).
  const latest = () => new URLSearchParams(typeof window !== 'undefined' ? window.location.search : q)
  const set = (k, v) => {
    const next = latest()
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) next.delete(k)
    else next.set(k, Array.isArray(v) ? v.join(',') : v)
    if (k !== 'page') next.delete('page')
    setQ(next, { replace: true })
  }
  /** Turn one position on or off. */
  const togglePos = (k) => {
    const cur = new Set((latest().get('pos') || '').split(',').filter(Boolean))
    if (cur.has(k)) cur.delete(k)
    else cur.add(k)
    set('pos', [...cur])
  }
  const setMany = (obj) => {
    const next = latest()
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    next.delete('page')
    setQ(next, { replace: true })
  }
  const market = get('market', 'core')
  const pos = get('pos') ? get('pos').split(',') : []
  const win = get('window', 'L10')
  const sort = get('sort', 'score')
  const dir = get('dir') || naturalDir(sort)
  const page = Math.max(1, Math.min(40, Number(get('page', '1')) || 1))
  const params = new URLSearchParams({ market, window: win, sort, limit: String(PAGE) })
  for (const k of ['side', 'minHit', 'game', 'q', 'dir', 'player']) if (get(k)) params.set(k, get(k))
  if (pos.length) params.set('pos', pos.join(','))
  const base = params.toString()
  // a fresh server loads game logs for a few seconds; until then the board polls itself
  // (quickly while it's empty, then slower until the last players are in)
  const [poll, setPoll] = useState(0)
  const live = useApi(`${apiOf(sport)}/board?${base}`, { maxAgeMs: 30_000, pollMs: poll })
  const { error, refresh } = live
  // this league's last board stays on screen (dimmed) while a new filter loads, so the controls
  // keep their options and the list doesn't flash empty
  const lastBoard = useRef({})
  if (live.data) lastBoard.current[sport] = live.data
  const data = live.data || lastBoard.current[sport] || null
  const updating = !live.data && Boolean(data)
  const loading = live.loading && !data
  const warming = Boolean(data && !data.total && data.pending > 0)
  const [opened] = useState(() => Date.now())
  const nextPoll = !(data?.pending || data?.loading) || Date.now() - opened > 180_000 ? 0 : warming ? 4000 : 10_000
  useEffect(() => setPoll(nextPoll), [nextPoll])
  useTitle(`${sportInfo(sport).name} prop explorer`)
  const facets = data?.facets
  const posPills = useMemo(() => groupPills(facets?.groups, sport), [facets, sport])
  const sorts = useMemo(() => SORTS.map((x) => (x.key === 'kickoff' && !FOOTBALL.has(sport) ? { ...x, label: 'Start time' } : x)), [sport])
  // Bet types: the league's main ones, every one, or any mix of single types (shots, points...),
  // each with how many props it holds under the other filters. Types with none aren't shown.
  const picked = market === 'core' || market === 'all' ? [] : market.split(',').filter(Boolean)
  const types = useMemo(() => {
    const totals = facets?.marketTotals
    return [
      { key: 'core', label: withCount('Main', totals?.core) },
      { key: 'all', label: withCount('Every type', totals?.all) },
      ...(facets?.markets || []).filter((m) => m.count > 0 || picked.includes(m.key)).map((m) => ({ key: m.key, label: withCount(m.label, m.count ?? null) })),
    ]
    // picked is derived from the address; its string form is the dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facets, market])
  const pickType = (k) => {
    if (k === 'core') return set('market', '')
    if (k === 'all') return set('market', 'all')
    const cur = new Set((latest().get('market') || '').split(',').filter((x) => x && x !== 'core' && x !== 'all'))
    if (cur.has(k)) cur.delete(k)
    else cur.add(k)
    set('market', [...cur])
  }
  const sides = SIDES.map((s) => ({ ...s, label: withCount(s.label, facets?.sides?.[s.key] ?? null) }))
  // on phones the chips scroll sideways: keep the first picked bet type in view
  const chipsRef = useRef(null)
  useEffect(() => {
    const row = chipsRef.current
    const on = row?.querySelector('.pill.is-on')
    if (!row || !on || row.scrollWidth <= row.clientWidth) return
    const left = on.offsetLeft - row.offsetLeft
    if (left < row.scrollLeft || left + on.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollTo({ left: Math.max(0, left - 16) })
  }, [market, types.length])
  const flipDir = () => {
    const next = dir === 'asc' ? 'desc' : 'asc'
    set('dir', next === naturalDir(sort) ? '' : next)
  }
  // on phones the less-used filters fold away behind one button so the props are on the first screen
  const phone = useMedia('(max-width: 759px)')
  const [showFilters, setShowFilters] = useState(false)
  // "My games": the starred games still on the slate
  const watch = useWatch()
  const mine = (facets?.games || []).filter((g) => watch.includes(g.id)).map((g) => g.id)
  const folded = ['minHit', 'game', 'q', 'pos', 'player'].filter((k) => get(k)).length + (win !== 'L10' ? 1 : 0)
  // a new game means a new roster: the picked player goes with the old one
  const pickGame = (v) => setMany({ game: v, player: '' })
  const roster = facets?.players || null
  const active = folded + ['side', 'dir'].filter((k) => get(k)).length + (market !== 'core' ? 1 : 0) + (sort !== 'score' ? 1 : 0)

  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Props</h1>
        <p className="page-sub" aria-live="polite">
          {warming ? 'Loading the board' : data ? `${data.total.toLocaleString()} props match${updating ? ', updating' : ''}` : 'Every player prop on the slate'}
        </p>
      </header>
      {mine.length > 0 && (
        <div className="mygames">
          <button type="button" className={`chip-toggle${get('game') === mine.join(',') ? ' is-on' : ''}`} aria-pressed={get('game') === mine.join(',')} onClick={() => set('game', get('game') === mine.join(',') ? '' : mine.join(','))}>
            My games ({mine.length})
          </button>
          {get('game') === mine.join(',') && (
            <button type="button" className={`chip-toggle${win === 'h2h' ? ' is-on' : ''}`} aria-pressed={win === 'h2h'} onClick={() => (win === 'h2h' ? setMany({ window: '', sort: '' }) : setMany({ window: 'h2h', sort: 'hit' }))}>
              Rank by head to head
            </button>
          )}
        </div>
      )}
      <div className="filters filters--board">
        {/* bet type, side and order stay on screen everywhere: they're what people change most */}
        <div className="board-types">
          <span className="filters__k" id="bet-type-k">
            Bet type
          </span>
          <div className="pills-scroll board-types__chips" ref={chipsRef}>
            <Pills label="Bet type" options={types} value={picked.length ? picked : [market]} multiple onChange={(_, k) => pickType(k)} />
          </div>
        </div>
        <div className="filters__row board-order">
          <span className="filters__k">Side</span>
          <Pills label="Side" options={sides} value={get('side') || null} onChange={(v) => set('side', v)} />
          <label className="field field--inline board-order__sort">
            <span>Sort by</span>
            <select value={sort} onChange={(e) => setMany({ sort: e.target.value === 'score' ? '' : e.target.value, dir: '' })}>
              {sorts.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="sort-dir" onClick={flipDir} aria-label={`${dirLabel(sort, dir)}. Switch to ${dirLabel(sort, dir === 'asc' ? 'desc' : 'asc').toLowerCase()}`}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d={dir === 'asc' ? 'M8 13V3M4 7l4-4 4 4' : 'M8 3v10M4 9l4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {dirLabel(sort, dir)}
          </button>
        </div>
        {phone && (
          <button type="button" className="btn btn--quiet btn--block filters-toggle" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}>
            {showFilters ? 'Fewer filters' : `Game, player, position and hit rate${folded ? ` (${folded} on)` : ''}`}
          </button>
        )}
        {(!phone || showFilters) && (
          <div className="filters__more">
            <GamePicker games={facets?.games || []} value={get('game')} mine={mine} onPick={pickGame} />
            {roster ? (
              <RosterPicker players={roster} value={get('player')} games={(facets?.games || []).filter((g) => get('game').split(',').includes(g.id))} onPick={(v) => setMany({ player: v, q: '' })} />
            ) : (
              <label className="field field--inline field--grow board-player">
                <span>Player</span>
                <input type="search" placeholder="Search any player, or pick a game to see its players" value={get('q')} onChange={(e) => set('q', e.target.value)} />
              </label>
            )}
            <div className="filters__row board-narrow">
              <span className="filters__k">Position</span>
              <Pills label="Position" options={posPills} value={pos} multiple onChange={(_, k) => togglePos(k)} />
              <span className="board-narrow__gap" aria-hidden="true" />
              <label className="field field--inline">
                <span>Hit rate over</span>
                <select value={win} onChange={(e) => set('window', e.target.value)}>
                  {WINDOWS.map((w) => (
                    <option key={w.key} value={w.key}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </label>
              <Pills label="Minimum hit rate" options={MIN_HIT} value={get('minHit') || null} onChange={(v) => set('minHit', v)} />
            </div>
          </div>
        )}
      </div>
      <ErrorBox error={error} onRetry={refresh} />
      {loading ? (
        <Skeleton rows={10} />
      ) : data?.rows?.length ? (
        <>
          <div className={`prop-list${updating ? ' prop-list--stale' : ''}`} aria-busy={updating}>
            {data.rows.map((c) => (
              <PropRow key={c.id} c={c} win={c.win} showGame />
            ))}
            {Array.from({ length: page - 1 }, (_, i) => (
              <MorePage key={`${base}:${i}`} base={base} offset={(i + 1) * PAGE} />
            ))}
          </div>
          {data.total > page * PAGE && (
            <button type="button" className="btn btn--quiet btn--block more" onClick={() => set('page', String(page + 1))}>
              Show more ({(data.total - page * PAGE).toLocaleString()} left)
            </button>
          )}
        </>
      ) : warming ? (
        <Warming pending={data.pending} />
      ) : data && data.available === 0 && !q.get('q') ? (
        <Empty title="No props posted yet">Sportsbooks post player props on game day. They show up here, with every filter, as soon as they do.</Empty>
      ) : (
        data && (
          <Empty
            title="No props match these filters"
            action={
              active > 0 && (
                <button type="button" className="btn btn--quiet" onClick={() => setQ(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </button>
              )
            }
          >
            Loosen the hit-rate floor or pick another bet type.
          </Empty>
        )
      )}
    </div>
  )
}

function MorePage({ base, offset }) {
  const sport = useSport()
  const { data, loading } = useApi(`${apiOf(sport)}/board?${base}&offset=${offset}`, { maxAgeMs: 30_000 })
  if (loading) return <Skeleton rows={4} />
  return (data?.rows || []).map((c) => <PropRow key={c.id} c={c} win={c.win} showGame />)
}

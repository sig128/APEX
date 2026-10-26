import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useWatch } from '../lib/watch.js'
import { useApi } from '../lib/useApi.js'
import { useTitle, useMedia } from '../lib/hooks.js'
import { PropRow } from '../ui/PropRow.jsx'
import { Pills, Skeleton, ErrorBox, Empty, Warming } from '../ui/Bits.jsx'
import { useSport, apiOf, sportInfo } from '../lib/sport.js'

const WINDOWS = [
  { key: 'L5', label: 'Last 5' },
  { key: 'L10', label: 'Last 10' },
  { key: 'L20', label: 'Last 20' },
  { key: 'season', label: 'This season' },
  { key: 'h2h', label: 'Vs opponent' },
  { key: 'venue', label: 'Home/away' },
]
const SORTS = [
  { key: 'score', label: 'APEX' },
  { key: 'hit', label: 'Hit rate' },
  { key: 'streak', label: 'Streak' },
  { key: 'prob', label: 'Probability' },
  { key: 'move', label: 'Line move' },
  { key: 'kickoff', label: 'Kickoff' },
]
const POS = ['QB', 'RB', 'WR', 'TE'].map((k) => ({ key: k, label: k }))
const FOOTBALL = new Set(['nfl', 'ncaaf'])
/** Position filters from the league's own groups: QB/RB/WR/TE, guards/forwards/centers, hitters/pitchers. */
const groupPills = (groups, sport) =>
  groups?.length ? groups.map((g) => ({ key: g.key, label: FOOTBALL.has(sport) ? g.key : g.label.charAt(0).toUpperCase() + g.label.slice(1) })) : POS
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

/** Every prop on the slate, filtered and sorted however you like. Filters live in the URL so a view can be shared. */
export function PropsPage() {
  const sport = useSport()
  const [q, setQ] = useSearchParams()
  const get = (k, d = '') => q.get(k) ?? d
  const set = (k, v) => {
    const next = new URLSearchParams(q)
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) next.delete(k)
    else next.set(k, Array.isArray(v) ? v.join(',') : v)
    if (k !== 'page') next.delete('page')
    setQ(next, { replace: true })
  }
  const setMany = (obj) => {
    const next = new URLSearchParams(q)
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
  const page = Math.max(1, Math.min(40, Number(get('page', '1')) || 1))
  const params = new URLSearchParams({ market, window: win, sort: get('sort', 'score'), limit: String(PAGE) })
  for (const k of ['side', 'minHit', 'game', 'q']) if (get(k)) params.set(k, get(k))
  if (pos.length) params.set('pos', pos.join(','))
  const base = params.toString()
  // a fresh server loads game logs for a few seconds; until then the board polls itself
  // (quickly while it's empty, then slower until the last players are in)
  const [poll, setPoll] = useState(0)
  const { data, error, loading, refresh } = useApi(`${apiOf(sport)}/board?${base}`, { maxAgeMs: 30_000, pollMs: poll })
  const warming = Boolean(data && !data.total && data.pending > 0)
  const [opened] = useState(() => Date.now())
  const nextPoll = !(data?.pending || data?.loading) || Date.now() - opened > 180_000 ? 0 : warming ? 4000 : 10_000
  useEffect(() => setPoll(nextPoll), [nextPoll])
  useTitle(`${sportInfo(sport).name} prop explorer`)
  const facets = data?.facets
  const posPills = useMemo(() => groupPills(facets?.groups, sport), [facets, sport])
  const sorts = useMemo(() => SORTS.map((x) => (x.key === 'kickoff' && !FOOTBALL.has(sport) ? { ...x, label: 'Start time' } : x)), [sport])
  const markets = useMemo(() => [{ key: 'core', label: 'Main markets' }, { key: 'all', label: 'Every market' }, ...(facets?.markets || []).map((m) => ({ key: m.key, label: m.label }))], [facets])
  // on phones the filters fold away behind one button so the props are on the first screen
  const phone = useMedia('(max-width: 759px)')
  const [showFilters, setShowFilters] = useState(false)
  // "My games": the starred games still on the slate
  const watch = useWatch()
  const mine = (facets?.games || []).filter((g) => watch.includes(g.id)).map((g) => g.id)
  const active = ['side', 'minHit', 'game', 'q', 'pos'].filter((k) => get(k)).length + (market !== 'core' ? 1 : 0) + (win !== 'L10' ? 1 : 0)

  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Props</h1>
        <p className="page-sub">{warming ? 'Loading the board' : data ? `${data.total.toLocaleString()} props match` : 'Every player prop on the slate'}</p>
      </header>
      {phone && (
        <button type="button" className="btn btn--quiet btn--block filters-toggle" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}>
          {showFilters ? 'Hide filters' : `Filters and sorting${active ? ` (${active} on)` : ''}`}
        </button>
      )}
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
      {(!phone || showFilters) && (
      <div className="filters">
        <label className="field field--inline">
          <span>Market</span>
          <select value={market} onChange={(e) => set('market', e.target.value)}>
            {markets.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span>Game</span>
          <select value={mine.length && get('game') === mine.join(',') ? '__mine' : get('game')} onChange={(e) => set('game', e.target.value === '__mine' ? mine.join(',') : e.target.value)}>
            <option value="">All games</option>
            {mine.length > 0 && <option value="__mine">My games ({mine.length})</option>}
            {(facets?.games || []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline field--grow">
          <span>Player</span>
          <input type="search" placeholder="Any player" value={get('q')} onChange={(e) => set('q', e.target.value)} />
        </label>
        <div className="filters__row">
          <span className="filters__k">Position</span>
          <Pills label="Position" options={posPills} value={pos} multiple onChange={(v) => set('pos', v)} />
          <span className="filters__k">Side</span>
          <Pills label="Side" options={SIDES} value={get('side') || null} onChange={(v) => set('side', v)} />
        </div>
        <div className="filters__row">
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
        <div className="filters__row">
          <span className="filters__k">Sort by</span>
          <Pills label="Sort" options={sorts} value={get('sort', 'score')} onChange={(v) => set('sort', v || 'score')} />
        </div>
      </div>
      )}
      <ErrorBox error={error} onRetry={refresh} />
      {loading ? (
        <Skeleton rows={10} />
      ) : data?.rows?.length ? (
        <>
          <div className="prop-list">
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
            Loosen the hit-rate floor or pick every market.
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

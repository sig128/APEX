import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { PropRow } from '../ui/PropRow.jsx'
import { Pills, Skeleton, ErrorBox, Empty } from '../ui/Bits.jsx'

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
const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((k) => ({ key: k, label: k }))
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
  const [q, setQ] = useSearchParams()
  const get = (k, d = '') => q.get(k) ?? d
  const set = (k, v) => {
    const next = new URLSearchParams(q)
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) next.delete(k)
    else next.set(k, Array.isArray(v) ? v.join(',') : v)
    if (k !== 'page') next.delete('page')
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
  const { data, error, loading, refresh } = useApi(`/api/nfl/board?${base}`, { maxAgeMs: 30_000 })
  useTitle('NFL prop explorer')
  const facets = data?.facets
  const markets = useMemo(() => [{ key: 'core', label: 'Main markets' }, { key: 'all', label: 'Every market' }, ...(facets?.markets || []).map((m) => ({ key: m.key, label: m.label }))], [facets])

  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Props</h1>
        <p className="page-sub">{data ? `${data.total.toLocaleString()} props match` : 'Every player prop on the slate'}</p>
      </header>
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
          <select value={get('game')} onChange={(e) => set('game', e.target.value)}>
            <option value="">All games</option>
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
          <Pills label="Position" options={POS} value={pos} multiple onChange={(v) => set('pos', v)} />
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
          <Pills label="Sort" options={SORTS} value={get('sort', 'score')} onChange={(v) => set('sort', v || 'score')} />
        </div>
      </div>
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
      ) : (
        data && <Empty title="No props match these filters">Loosen the hit-rate floor or pick every market.</Empty>
      )}
    </div>
  )
}

function MorePage({ base, offset }) {
  const { data, loading } = useApi(`/api/nfl/board?${base}&offset=${offset}`, { maxAgeMs: 30_000 })
  if (loading) return <Skeleton rows={4} />
  return (data?.rows || []).map((c) => <PropRow key={c.id} c={c} win={c.win} showGame />)
}

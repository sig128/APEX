import { useState } from 'react'
import { useApi } from '../lib/useApi.js'
import { useTitle } from '../lib/hooks.js'
import { num } from '../lib/format.js'
import { TeamLogo, logoFor } from '../ui/Img.jsx'
import { Tabs, Skeleton, Pills } from '../ui/Bits.jsx'
import { useSport, apiOf } from '../lib/sport.js'

const FOOTBALL = new Set(['nfl', 'ncaaf'])
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** Defense vs position: what each defense gives up to each position group, per game (QBs and WRs, guards and centers, hitters and pitchers). */
export function DvpPage() {
  const sport = useSport()
  const { data, loading } = useApi(`${apiOf(sport)}/dvp`, { maxAgeMs: 300_000 })
  const keys = data ? Object.keys(data.groups || {}) : FOOTBALL.has(sport) ? ['QB', 'RB', 'WR', 'TE'] : []
  const [pick, setGroup] = useState(null)
  const group = pick && keys.includes(pick) ? pick : keys.includes('WR') ? 'WR' : keys[0]
  const [stat, setStat] = useState(null)
  useTitle('Defense vs position')
  const stats = data && group ? Object.keys(data.groups[group] || {}) : []
  const cur = stat && stats.includes(stat) ? stat : stats[0]
  const rows = data?.groups?.[group]?.[cur] || []
  const avg = data?.league?.[group]?.[cur]
  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Defense vs position</h1>
        <p className="page-sub">Rank 1 gives up the most. This season, adjusted for how few games are in.</p>
      </header>
      {keys.length > 0 && <Tabs tabs={keys.map((k) => ({ key: k, label: FOOTBALL.has(sport) ? k : cap(data?.groupNames?.[k] || k) }))} value={group} onChange={(g) => (setGroup(g), setStat(null))} label="Position" />}
      {loading ? (
        <Skeleton rows={10} />
      ) : (
        <>
          {!stats.length && <p className="muted pad">Defense numbers fill in once a few games are in.</p>}
          <Pills label="Stat" options={stats.map((k) => ({ key: k, label: data.labels[k] || k }))} value={cur} onChange={(v) => v && setStat(v)} />
          <div className="table-wrap">
            <table className="log dvp">
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Defense</th>
                  <th scope="col" className="num-col">Per game</th>
                  <th scope="col" className="num-col">Vs average</th>
                  <th scope="col" className="num-col">Games</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const diff = avg ? r.perGame / avg - 1 : null
                  return (
                    <tr key={r.teamId}>
                      <td className="num">{r.rank}</td>
                      <td>
                        <span className="dvp__team">
                          <TeamLogo src={r.logo || logoFor(r.abbr, sport)} abbr={r.abbr} size={20} /> {r.abbr}
                        </span>
                      </td>
                      <td className="num-col num">{num(r.perGame)}</td>
                      <td className={`num-col num ${diff > 0.08 ? 'is-plus' : diff < -0.08 ? 'is-minus' : ''}`}>{diff == null ? '–' : `${diff > 0 ? '+' : ''}${Math.round(diff * 100)}%`}</td>
                      <td className="num-col num">{r.games}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

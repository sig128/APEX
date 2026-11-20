import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { units as fmtUnits, odds as fmtOdds } from '../lib/format.js'
import { Avatar, clvText } from './PickCard.jsx'
import { Skeleton, Empty } from './Bits.jsx'
import { Discover } from './Discover.jsx'

const RANGES = [
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
]
const SPORTS = [
  { key: 'all', label: 'All' },
  { key: 'nfl', label: 'NFL' },
  { key: 'nba', label: 'NBA' },
  { key: 'nhl', label: 'NHL' },
  { key: 'mlb', label: 'MLB' },
  { key: 'ncaaf', label: 'NCAAF' },
  { key: 'ncaab', label: 'NCAAB' },
  { key: 'mixed', label: 'Mixed' },
]
const LEGS = [
  { key: 'all', label: 'Any legs' },
  { key: '1', label: 'Singles' },
  { key: '2', label: '2 legs' },
  { key: '3', label: '3 legs' },
  { key: '4+', label: '4+ legs' },
]
const SORTS = [
  { key: 'roi', label: 'ROI' },
  { key: 'units', label: 'Units' },
  { key: 'hit', label: 'Hit rate' },
  { key: 'clv', label: 'CLV' },
]
const TIER_NAME = { legend: 'Legend', diamond: 'Diamond', platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze' }

const pctTxt = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`)
const roiTxt = (x) => (x == null ? '–' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)
const metricOf = (rec, sort) => (sort === 'units' ? fmtUnits(rec.units) : sort === 'hit' ? pctTxt(rec.hitRate) : sort === 'clv' ? (rec.clvN ? clvText(rec.clv) : '–') : roiTxt(rec.roi))
const metricName = { roi: 'ROI', units: 'Units', hit: 'Hit rate', clv: 'CLV' }

export function TierBadge({ tier, small = false }) {
  if (!tier) return null
  return (
    <span className={`tier tier--${tier}${small ? ' tier--s' : ''}`} title={`${TIER_NAME[tier]} tier`}>
      <svg viewBox="0 0 12 12" width={small ? 9 : 11} height={small ? 9 : 11} aria-hidden="true">
        <path d="M6 .8l4.4 3.2L6 11.2 1.6 4z" fill="currentColor" />
      </svg>
      {TIER_NAME[tier]}
    </span>
  )
}

/** Instagram and X, as on picks pages (Elite pages only; the server leaves them out otherwise). */
export function Socials({ profile, compact = false }) {
  if (!profile?.x && !profile?.ig) return null
  return (
    <span className={`lb-socials${compact ? ' is-compact' : ''}`}>
      {profile.ig && (
        <a href={`https://instagram.com/${profile.ig}`} target="_blank" rel="noopener noreferrer me" className="lb-social lb-social--ig" aria-label={`${profile.name} on Instagram`} onClick={(e) => e.stopPropagation()}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" />
          </svg>
          {!compact && <span>@{profile.ig}</span>}
        </a>
      )}
      {profile.x && (
        <a href={`https://x.com/${profile.x}`} target="_blank" rel="noopener noreferrer me" className="lb-social lb-social--x" aria-label={`${profile.name} on X`} onClick={(e) => e.stopPropagation()}>
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path fill="currentColor" d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.3l4.4 5.9L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z" />
          </svg>
          {!compact && <span>@{profile.x}</span>}
        </a>
      )}
    </span>
  )
}

function Streak({ s }) {
  if (!s) return <span className="muted">–</span>
  return <span className={`lb-streak ${s[0] === 'W' ? 'is-w' : 'is-l'}`}>{s}</span>
}

function Form({ last10 = [] }) {
  return (
    <span className="lb-form" aria-label={`Last ${last10.length}: ${last10.join(' ')}`}>
      {last10
        .slice()
        .reverse()
        .map((c, i) => (
          <i key={i} className={c === 'W' ? 'is-w' : 'is-l'} />
        ))}
    </span>
  )
}

function Podium({ rows, sort }) {
  // second, first, third: the winner in the middle
  const order = [rows[1], rows[0], rows[2]].map((r, i) => (r ? { r, rank: [2, 1, 3][i] } : null)).filter(Boolean)
  return (
    <ol className="lb-podium" aria-label="Top three">
      {order.map(({ r, rank }) => (
        <li key={r.profile.handle} className={`lb-step lb-step--${rank}`}>
          <Link to={`/u/${r.profile.handle}`} className="lb-step__card">
            <span className="lb-step__rank num" aria-label={`Rank ${rank}`}>
              {rank}
            </span>
            <span className="lb-step__ring">
              <Avatar profile={r.profile} size={rank === 1 ? 92 : 72} />
            </span>
            <span className="lb-step__name">{r.profile.name}</span>
            <span className="lb-step__handle muted">@{r.profile.handle}</span>
            <TierBadge tier={r.tier} small />
            <span className={`lb-step__metric num${(sort === 'units' ? r.record.units : r.record.roi) > 0 ? ' is-plus' : ''}`}>{metricOf(r.record, sort)}</span>
            <span className="lb-step__sub muted num">
              {r.record.wins}-{r.record.losses} · {fmtUnits(r.record.units)}
            </span>
          </Link>
          <Socials profile={r.profile} compact />
        </li>
      ))}
    </ol>
  )
}

/** One ranked bettor (the leaderboard and private groups). tag: a word after the name ("You"). */
export function BoardRow({ r, rank, sort, tag = null }) {
  return (
    <li className={`lb-row${tag === 'You' ? ' is-you' : ''}`}>
      <Link to={`/u/${r.profile.handle}`} className="lb-row__link" aria-label={`${rank}. ${r.profile.name}`}>
        <span className="lb-row__rank num">{rank}</span>
        <Avatar profile={r.profile} size={42} />
        <span className="lb-row__who">
          <span className="lb-row__name">
            {r.profile.name} <TierBadge tier={r.tier} small />
            {tag && <span className="lb-row__tag">{tag}</span>}
          </span>
          <span className="lb-row__handle muted">@{r.profile.handle}</span>
        </span>
        <span className="lb-row__stats">
          <span className="lb-stat">
            <b className="num">
              {r.record.wins}-{r.record.losses}
            </b>
            <small>Record</small>
          </span>
          <span className="lb-stat">
            <b className="num">{pctTxt(r.record.hitRate, 0)}</b>
            <small>Hit</small>
          </span>
          <span className="lb-stat">
            <b className={`num ${r.record.units >= 0 ? 'is-plus' : 'is-minus'}`}>{fmtUnits(r.record.units)}</b>
            <small>Units</small>
          </span>
          <span className="lb-stat lb-stat--wide">
            <b className="num">{r.record.avgOdds != null ? fmtOdds(r.record.avgOdds) : '–'}</b>
            <small>Avg odds</small>
          </span>
          <span className="lb-stat lb-stat--wide">
            <Streak s={r.record.streak} />
            <small>Streak</small>
          </span>
        </span>
        <span className="lb-row__metric">
          <b className={`num ${(sort === 'units' ? r.record.units : r.record.roi) > 0 ? 'is-plus' : (sort === 'units' ? r.record.units : r.record.roi) < 0 ? 'is-minus' : ''}`}>{metricOf(r.record, sort)}</b>
          <Form last10={r.record.last10} />
        </span>
      </Link>
      {r.profile.x || r.profile.ig ? <Socials profile={r.profile} compact /> : <span className="lb-socials" aria-hidden="true" />}
    </li>
  )
}

function Locked({ total }) {
  const hidden = Math.max(0, total - 3)
  return (
    <div className="lb-locked">
      <ol className="lb-list lb-list--ghost" aria-hidden="true">
        {Array.from({ length: Math.min(5, Math.max(3, hidden)) }, (_, i) => (
          <li key={i} className="lb-row lb-row--ghost">
            <span className="lb-row__rank num">{i + 4}</span>
            <span className="lb-ghost lb-ghost--avatar" />
            <span className="lb-ghost lb-ghost--name" />
            <span className="lb-ghost lb-ghost--stats" />
          </li>
        ))}
      </ol>
      <div className="lb-locked__card">
        <p className="lb-locked__title">{hidden > 0 ? `${hidden} more on the board` : 'The full board'}</p>
        <p className="muted">The leaderboard is for members: every ranked bettor, their tier, record, units and form, with filters by league and leg count.</p>
        <Link to="/pricing" className="btn btn--lime">
          Unlock with Pro
        </Link>
      </div>
    </div>
  )
}

/** The members' leaderboard: verified records, a podium, tiers, filters and every bettor's socials. */
export function Leaderboard() {
  const [range, setRange] = useState('30d')
  const [sport, setSport] = useState('all')
  const [legs, setLegs] = useState('all')
  const [sort, setSort] = useState('roi')
  const { data, loading } = useApi(`/api/picks/leaderboard?range=${range}&sport=${sport}&legs=${legs}&sort=${sort}`, { maxAgeMs: 60_000 })
  const rows = data?.rows || []
  return (
    <section className="lb" aria-labelledby="lb-h">
      <div className="lb-head">
        <div>
          <h2 id="lb-h" className="lb-head__title">
            Leaderboard
          </h2>
          <p className="muted lb-head__sub">Members only. Picks are posted before kickoff at a book’s price, can’t be edited, and are graded from the box score.</p>
        </div>
        <label className="lb-sort">
          <span className="muted">Rank by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Discover id="leaderboard" title="How the leaderboard works">
        Every record here is built from picks posted before kickoff at a sportsbook’s price and graded from the box score, so nobody can edit a loss away. Rank by ROI, units, hit rate or CLV; the tier badges come from each person’s last 90 days. For a board of just your friends, start a group from the Groups tab.
      </Discover>
      <div className="lb-filters">
        <div className="seg seg--inline" role="group" aria-label="Window">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={range === r.key ? 'is-on' : ''} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="lb-chips" role="group" aria-label="League">
          {SPORTS.map((s) => (
            <button key={s.key} type="button" className={`lb-chip${sport === s.key ? ' is-on' : ''}`} aria-pressed={sport === s.key} onClick={() => setSport(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="lb-chips" role="group" aria-label="Legs">
          {LEGS.map((s) => (
            <button key={s.key} type="button" className={`lb-chip${legs === s.key ? ' is-on' : ''}`} aria-pressed={legs === s.key} onClick={() => setLegs(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {loading && !data ? (
        <Skeleton rows={8} />
      ) : !rows.length ? (
        <Empty title="Nobody has qualified here yet">It takes {data?.min || 20} graded picks in the window to rank. Try a longer window or another league.</Empty>
      ) : (
        <>
          <Podium rows={rows.slice(0, 3)} sort={sort} />
          {data.locked ? (
            <Locked total={data.total || rows.length} />
          ) : (
            rows.length > 3 && (
              <ol className="lb-list" start={4}>
                {rows.slice(3).map((r, i) => (
                  <BoardRow key={r.profile.handle} r={r} rank={i + 4} sort={sort} />
                ))}
              </ol>
            )
          )}
        </>
      )}
      <details className="lb-tiers">
        <summary>How tiers work</summary>
        <p className="muted">Tiers come from the last 90 days of graded picks, so they move with you. Each needs its number of graded picks and its return on investment.</p>
        <ul>
          {(data?.tiers || []).map((t) => (
            <li key={t.key}>
              <TierBadge tier={t.key} small /> {t.min}+ graded{t.roi != null && t.roi > -1 ? `, ROI ${t.roi >= 0 ? '+' : ''}${Math.round(t.roi * 100)}% or better` : ''}
              {t.clv != null ? ', and beats the closing line on average' : ''}
            </li>
          ))}
        </ul>
        <p className="muted">
          Ranked by {metricName[sort]} with at least {data?.min || 20} graded picks in the window. Every posted pick counts; none can be deleted after kickoff.
        </p>
      </details>
    </section>
  )
}

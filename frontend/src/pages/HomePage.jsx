import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useLive } from '../lib/live.js'
import { useTitle } from '../lib/hooks.js'
import { pct, odds, kickoff, clock, ago, ratio } from '../lib/format.js'
import { toggleLeg } from '../lib/slip.js'
import { useSlip } from '../lib/useSlip.js'
import { GameStrip } from '../ui/GameStrip.jsx'
import { PropList } from '../ui/PropRow.jsx'
import { HitChart } from '../ui/HitChart.jsx'
import { Headshot, TeamLogo } from '../ui/Img.jsx'
import { RateChip, Tabs, Section, Skeleton, ErrorBox, Empty } from '../ui/Bits.jsx'

const TABS = [
  { key: 'apex', label: 'APEX picks' },
  { key: 'streaks', label: 'Streaks' },
  { key: 'matchups', label: 'Matchups' },
  { key: 'moves', label: 'Line moves' },
  { key: 'tds', label: 'Touchdowns' },
]
const TAB_NOTE = {
  apex: 'The highest APEX scores on the slate: hit rate, projection, matchup and role together.',
  streaks: 'Starters who have cleared this line five or more games in a row.',
  matchups: 'Props facing a defense ranked top or bottom six against the position.',
  moves: 'Lines that moved since they opened. The market is telling you something.',
  tds: 'Anytime touchdown scorers, most likely first.',
}

export function HomePage() {
  const { data, error, loading, refresh } = useApi('/api/nfl/home', { maxAgeMs: 20_000 })
  useLive('scoreboard', () => {})
  useTitle(data?.week ? `NFL Week ${data.week} props` : 'NFL props')
  const [tab, setTab] = useState('apex')
  const top = data?.tabs?.apex?.[0]

  if (error && !data) {
    return (
      <div className="container page">
        <ErrorBox error={error} onRetry={refresh} />
      </div>
    )
  }

  return (
    <div className="page home">
      <GameStrip games={data?.games} />
      <div className="container">
        <header className="week-head">
          <h1 className="week-head__title num">{data?.week ? `Week ${data.week}` : 'This week'}</h1>
          {data && (
            <p className="week-head__facts">
              <span>
                <b className="num">{data.counts.games}</b> games
              </span>
              <span>
                <b className="num">{data.counts.props.toLocaleString()}</b> props graded
              </span>
              {data.counts.live > 0 && (
                <Link to="/nfl/live" className="week-head__live">
                  <b className="num">{data.counts.live}</b> live now
                </Link>
              )}
              {data.at?.lines && <span className="muted">lines {ago(data.at.lines)}</span>}
            </p>
          )}
        </header>

        <LockBanner />
        {loading && <Skeleton kind="hero" rows={1} />}
        {top && <Hero card={top} />}

        <Section
          id="board"
          title="The board"
          aside={
            <Link to="/nfl/props" className="link">
              All props
            </Link>
          }
        >
          <Tabs tabs={TABS.map((t) => ({ ...t, count: data?.tabs?.[t.key]?.length }))} value={tab} onChange={setTab} label="Board" className="board-tabs" />
          <p className="section__note">{TAB_NOTE[tab]}</p>
          {loading ? <Skeleton rows={8} /> : <PropList rows={data?.tabs?.[tab]} ranked={tab === 'apex'} showGame empty="Nothing qualifies for this list right now. It fills in as lines post." />}
        </Section>

        {data?.cheatsheets?.length > 0 && (
          <Section id="sheets" title="Cheatsheets">
            <div className="sheets">
              {data.cheatsheets.map((s) => (
                <Cheatsheet key={s.key} sheet={s} />
              ))}
            </div>
          </Section>
        )}

        {data?.parlays?.length > 0 && (
          <Section id="parlays" title="Built parlays">
            <p className="section__note">The strongest legs on the slate, two per game at most. Probabilities multiply, so even good legs make a long shot together.</p>
            <div className="parlays">
              {data.parlays.slice(0, 6).map((p) => (
                <ParlayCard key={p.id} p={p} />
              ))}
            </div>
          </Section>
        )}

        {data?.games?.length > 0 && (
          <Section id="games" title="Matchups">
            <div className="matchups">
              {data.games.map((g) => (
                <MatchupCard key={g.id} g={g} />
              ))}
            </div>
          </Section>
        )}

        {data && !data.games?.length && <Empty title="No games on the board yet">The new week's slate shows up as soon as the schedule posts.</Empty>}
      </div>
    </div>
  )
}

/** The No. 1 prop on the board, big: who, the line, the last ten against it, and the read. */
/** This week's 3-Leg Lock and the season record, from the public ledger. */
function LockBanner() {
  const { data } = useApi('/api/nfl/lock/ledger', { maxAgeMs: 60_000 })
  const wk = data?.weeks?.[0]
  const r = data?.record
  if (!data) return null
  const state = !wk ? 'Checking the board' : wk.status === 'pass' ? 'Pass so far: nothing meets the rules' : wk.status === 'graded' ? (wk.result === 'win' ? 'Cashed' : wk.result === 'loss' ? 'Missed' : 'Pushed') : wk.status === 'live' ? 'Live now' : 'The lock is in'
  return (
    <Link to="/lock" className={`lockbar lockbar--${wk?.status || 'none'}`}>
      <span className="lockbar__k">3-Leg Lock{wk ? `, week ${wk.week}` : ''}</span>
      <span className="lockbar__state">{state}</span>
      {r && (r.wins || r.losses || r.passes) ? (
        <span className="lockbar__rec num">
          {r.wins}-{r.losses}
          {r.risked > 0 ? `, ${r.units >= 0 ? '+' : ''}${r.units.toFixed(1)}u` : ''}
        </span>
      ) : null}
      <span className="lockbar__go">See the lock</span>
    </Link>
  )
}

function Hero({ card }) {
  const detail = useApi(`/api/nfl/props/${encodeURIComponent(card.id)}`, { maxAgeMs: 60_000 }).data
  const slip = useSlip()
  const on = slip.legs.some((l) => l.id === card.id)
  const p = detail?.prop
  const games = useMemo(() => (p?.recent || []).slice(-10), [p])
  const wins = p?.windows?.filter((w) => ['L5', 'L10', 'L20', 'season', 'h2h'].includes(w.key) && w.n) || [card.l5, card.l10].filter(Boolean)
  return (
    <article className="hero" aria-labelledby="hero-name">
      <div className="hero__who">
        <Headshot src={card.headshot} name={card.name} size={88} className="hero__img" />
        <div>
          <p className="hero__rank">No. 1 on the APEX board</p>
          <h2 className="hero__name" id="hero-name">
            <Link to={`/nfl/player/${card.playerId}`}>{card.name}</Link>
          </h2>
          <p className="hero__meta">
            {card.pos} {card.teamAbbr} {card.home ? 'vs' : 'at'} {card.oppAbbr}, {kickoff(card.kickoff)}
          </p>
        </div>
      </div>
      <div className="hero__read">
        <p className="hero__label">{card.label}</p>
        <p className="hero__prob">
          <span className="num">{pct(card.prob)}</span>
          <span className="hero__fair">
            fair <b className="num">{odds(card.fair)}</b>
          </span>
        </p>
        <div className="hero__chips">
          {wins.map((w) => (
            <RateChip key={w.key} w={w} />
          ))}
        </div>
        {p?.matchup?.text && <p className="hero__note">{p.matchup.text}.</p>}
        <div className="hero__actions">
          <button type="button" className={`btn ${on ? 'btn--quiet' : 'btn--gold'}`} onClick={() => toggleLeg(card)} aria-pressed={on}>
            {on ? 'On your slip' : 'Add to slip'}
          </button>
          <Link to={`/nfl/prop/${encodeURIComponent(card.id)}`} className="btn btn--quiet">
            Open the prop
          </Link>
        </div>
      </div>
      <div className="hero__chart">{games.length ? <HitChart games={games} line={card.line} side={card.side} oneSided={card.oneSided} label="Last 10 games" height={200} /> : <Skeleton kind="chart" rows={1} />}</div>
    </article>
  )
}

function Cheatsheet({ sheet }) {
  return (
    <div className="sheet">
      <h3 className="sheet__title">{sheet.title}</h3>
      <p className="sheet__sub">{sheet.sub}</p>
      <ol className="sheet__rows">
        {sheet.rows.map((r) => (
          <li key={r.id}>
            <Link to={`/nfl/prop/${encodeURIComponent(r.id)}`} className="sheet__row">
              <Headshot src={r.headshot} name={r.name} size={24} />
              <span className="sheet__who">
                <b>{r.short}</b> {r.shortLabel}
              </span>
              <span className="sheet__v num">{r.win ? ratio(r.win) : ratio(r.l5)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function ParlayCard({ p }) {
  const slip = useSlip()
  const all = p.cards.every((c) => slip.legs.some((l) => l.id === c.id))
  return (
    <div className="parlay">
      <div className="parlay__head">
        <span className="parlay__size">{p.size} legs</span>
        <span className="parlay__prob num">{pct(p.prob)}</span>
        <span className="parlay__fair">fair {odds(p.fair)}</span>
      </div>
      <ul className="parlay__legs">
        {p.cards.map((c) => (
          <li key={c.id}>
            <Headshot src={c.headshot} name={c.name} size={26} />
            <span>
              <b>{c.short}</b> {c.shortLabel}
            </span>
            <span className="muted num">{pct(c.prob)}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn--quiet btn--block"
        onClick={() => {
          for (const c of p.cards) if (!slip.legs.some((l) => l.id === c.id)) toggleLeg(c)
          window.dispatchEvent(new Event('apex:open-slip'))
        }}
        disabled={all}
      >
        {all ? 'On your slip' : 'Add all to slip'}
      </button>
    </div>
  )
}

function MatchupCard({ g }) {
  return (
    <Link to={`/nfl/game/${g.id}`} className={`matchup${g.status?.state === 'in' ? ' is-live' : ''}`}>
      <span className="matchup__team">
        <TeamLogo src={g.away?.logo} abbr={g.away?.abbr} size={40} />
        <b>{g.away?.abbr}</b>
        {g.status?.state !== 'pre' && <span className="matchup__score num">{g.away?.score}</span>}
      </span>
      <span className="matchup__mid">
        <span className="matchup__clock">{clock(g.status, g.date)}</span>
        {g.odds?.details && <span className="matchup__odds">{g.odds.details}</span>}
        {g.odds?.total != null && <span className="matchup__odds">O/U {g.odds.total}</span>}
      </span>
      <span className="matchup__team">
        <TeamLogo src={g.home?.logo} abbr={g.home?.abbr} size={40} />
        <b>{g.home?.abbr}</b>
        {g.status?.state !== 'pre' && <span className="matchup__score num">{g.home?.score}</span>}
      </span>
    </Link>
  )
}

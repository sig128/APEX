import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useLive } from '../lib/live.js'
import { useTitle, useMedia } from '../lib/hooks.js'
import { pct, odds, kickoff, clock, ago, ratio } from '../lib/format.js'
import { toggleLeg } from '../lib/slip.js'
import { useSlip } from '../lib/useSlip.js'
import { useWatch } from '../lib/watch.js'
import { GameStrip } from '../ui/GameStrip.jsx'
import { PropList } from '../ui/PropRow.jsx'
import { HitChart } from '../ui/HitChart.jsx'
import { Headshot, TeamLogo } from '../ui/Img.jsx'
import { RateChip, Tabs, Section, Skeleton, ErrorBox, Empty, Warming } from '../ui/Bits.jsx'
import { useSport, apiOf, sp, sportInfo, slateDay, slateLabel } from '../lib/sport.js'

const TABS = [
  { key: 'apex', label: 'APEX picks' },
  { key: 'streaks', label: 'Streaks' },
  { key: 'matchups', label: 'Matchups' },
  { key: 'moves', label: 'Line moves' },
]
// the last tab is each league's own: touchdowns, threes, home runs, goal scorers
const SPECIAL = { nfl: { key: 'tds', label: 'Touchdowns' }, ncaaf: { key: 'tds', label: 'Touchdowns' }, nba: { key: 'threes', label: '3-pointers' }, ncaab: { key: 'threes', label: '3-pointers' }, wnba: { key: 'threes', label: '3-pointers' }, mlb: { key: 'hr', label: 'Home runs' }, nhl: { key: 'goals', label: 'Goal scorers' } }
const TAB_NOTE = {
  apex: 'The highest APEX scores on the slate: hit rate, projection, matchup and role together.',
  streaks: 'Starters who have cleared this line five or more games in a row.',
  matchups: 'Props facing a defense ranked top or bottom six against the position.',
  moves: 'Lines that moved since they opened. The market is telling you something.',
  tds: 'Anytime touchdown scorers, most likely first.',
  threes: 'Made threes, the likeliest overs first.',
  hr: 'Home run props, the likeliest first.',
  goals: 'Anytime goal scorers, the likeliest first.',
}

/** The day of the next game on a daily board ("Sunday, October 25"), on ESPN's Eastern-time calendar. */
function boardDay(data, style = 'long') {
  const next = (data?.games || [])
    .filter((g) => g.status?.state !== 'post')
    .map((g) => Date.parse(g.date))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0]
  if (!next) return slateDay(data?.slate, style)
  const o = style === 'long' ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' }
  return new Date(next).toLocaleDateString('en-US', { ...o, timeZone: 'America/New_York' })
}

export function HomePage() {
  const sport = useSport()
  const info = sportInfo(sport)
  // a fresh server loads game logs for a few seconds; until then the board polls itself
  // (quickly while it's empty, then slower until the last players are in)
  const [poll, setPoll] = useState(0)
  const { data, error, loading, refresh } = useApi(`${apiOf(sport)}/home`, { maxAgeMs: 20_000, pollMs: poll })
  const warming = Boolean(data && !data.counts?.props && data.counts?.pending > 0)
  const [opened] = useState(() => Date.now())
  const nextPoll = !data?.counts?.pending || Date.now() - opened > 180_000 ? 0 : warming ? 4000 : 10_000
  useEffect(() => setPoll(nextPoll), [nextPoll])
  useLive('scoreboard', () => {})
  const daily = (data?.calendar || info.calendar) === 'day'
  const phone = useMedia('(max-width: 759px)')
  useTitle(daily ? `${info.name} props, ${boardDay(data, 'short') || 'today'}` : data?.week ? `${info.name} Week ${data.week} props` : `${info.name} props`)
  const [tab, setTab] = useState('apex')
  const top = data?.tabs?.apex?.[0]
  const tabs = [...TABS, data?.special || SPECIAL[sport] || SPECIAL.nfl]
  // a tab another league has (touchdowns on the NBA board) falls back to APEX picks
  const cur = tabs.some((t) => t.key === tab) ? tab : 'apex'

  const meta = useApi('/api/sports', { maxAgeMs: 10 * 60_000 }).data
  const month = new Date().getMonth() + 1
  const between = meta?.sports?.find((x) => x.key === sport)?.offseason?.includes(month)
  // the leagues in season right now, for a league with nothing on
  const inSeason = (meta?.sports || []).filter((x) => x.key !== sport && !x.offseason?.includes(month)).slice(0, 4)

  if (error && !data) {
    return (
      <div className="container page">
        <ErrorBox error={error} onRetry={refresh} />
      </div>
    )
  }

  // a league with nothing scheduled: say so once, no empty board
  if (data && !data.games?.length) {
    return (
      <div className="container page home">
        <header className="week-head">
          <h1 className="week-head__title">{info.title}</h1>
        </header>
        <Empty
          title={between ? `The ${info.name} is between seasons` : `No ${info.name} games on the board yet`}
          action={
            inSeason.length > 0 && (
              <div className="row empty__leagues">
                {inSeason.map((x) => (
                  <Link key={x.key} to={sp(x.key, '')} className="btn btn--quiet">
                    {x.name} board
                  </Link>
                ))}
              </div>
            )
          }
        >
          {between ? 'The board comes back when the schedule does: games, lines and the 3-Leg Lock, the day they post.' : daily ? `The next ${info.name} games show up here as soon as the schedule posts.` : 'The new week’s slate shows up as soon as the schedule posts.'}
        </Empty>
      </div>
    )
  }

  return (
    <div className="page home">
      <GameStrip games={data?.games} />
      <div className="container">
        <header className="week-head">
          <h1 className="week-head__title num">{daily ? boardDay(data, phone ? 'short' : 'long') || 'Today' : data?.week ? `Week ${data.week}` : 'This week'}</h1>
          {data && (
            <p className="week-head__facts">
              <span>
                <b className="num">{data.counts.games}</b> {data.counts.games === 1 ? 'game' : 'games'}
              </span>
              <span>
                <b className="num">{data.counts.props.toLocaleString()}</b> props graded
              </span>
              {data.counts.live > 0 && (
                <Link to={sp(sport, '/live')} className="week-head__live">
                  <b className="num">{data.counts.live}</b> live now
                </Link>
              )}
              {data.at?.lines && <span className="muted">lines {ago(data.at.lines)}</span>}
            </p>
          )}
        </header>

        {warming && <Warming pending={data.counts.pending} />}
        {!warming && <LockBanner />}
        <MyGames games={data?.games} />
        {loading && <Skeleton kind="hero" rows={1} />}
        {top && <Hero card={top} />}

        {!warming && (
          <Section
            id="board"
            title="The board"
            aside={
              <Link to={sp(sport, '/props')} className="link">
                All props
              </Link>
            }
          >
            <Tabs tabs={tabs.map((t) => ({ ...t, count: data?.tabs?.[t.key]?.length }))} value={cur} onChange={setTab} label="Board" className="board-tabs" />
            <p className="section__note">{TAB_NOTE[cur] || ''}</p>
            {loading ? <Skeleton rows={8} /> : <PropList rows={data?.tabs?.[cur]} ranked={cur === 'apex'} showGame empty="Nothing qualifies for this list right now. It fills in as lines post." />}
          </Section>
        )}

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

      </div>
    </div>
  )
}

/** The starred games: straight to their head-to-head view. */
function MyGames({ games }) {
  const sport = useSport()
  const watch = useWatch()
  const mine = (games || []).filter((g) => watch.includes(g.id) && g.status?.state !== 'post')
  if (!mine.length) return null
  return (
    <section className="mygames-home" aria-labelledby="mygames-h">
      <div className="mygames-home__head">
        <h2 className="section-h" id="mygames-h">
          My games
        </h2>
        <Link className="link" to={sp(sport, `/props?game=${mine.map((g) => g.id).join(',')}&window=h2h&sort=hit`)}>
          Their props, ranked by head to head
        </Link>
      </div>
      <ul className="mygames-home__list">
        {mine.map((g) => (
          <li key={g.id}>
            <Link to={sp(sport, `/game/${g.id}?tab=h2h`)} className="mygame">
              <span className="mygame__teams">
                {g.away?.abbr} at {g.home?.abbr}
              </span>
              <span className="mygame__when">{clock(g.status, g.date)}</span>
              <span className="mygame__go">Head to head</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The current 3-Leg Lock (this week's, or today's) and the season record, from the public ledger. */
function LockBanner() {
  const sport = useSport()
  const { data } = useApi(`${apiOf(sport)}/lock/ledger`, { maxAgeMs: 60_000 })
  const wk = data?.weeks?.[0]
  const r = data?.record
  if (!data) return null
  const state = !wk ? 'Checking the board' : wk.status === 'pass' ? 'Pass so far: nothing meets the rules' : wk.status === 'graded' ? (wk.result === 'win' ? 'Cashed' : wk.result === 'loss' ? 'Missed' : 'Pushed') : wk.status === 'live' ? 'Live now' : 'The lock is in'
  return (
    <Link to={sp(sport, '/lock')} className={`lockbar lockbar--${wk?.status || 'none'}`}>
      <span className="lockbar__k">3-Leg Lock{wk ? `, ${slateLabel(wk.week)}` : ''}</span>
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

/** The No. 1 prop on the board, big: who, the line, the last ten against it, and the read. */
function Hero({ card }) {
  const sport = useSport()
  const detail = useApi(`${apiOf(sport)}/props/${encodeURIComponent(card.id)}`, { maxAgeMs: 60_000 }).data
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
            <Link to={sp(sport, `/player/${card.playerId}`)}>{card.name}</Link>
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
          <Link to={sp(sport, `/prop/${encodeURIComponent(card.id)}`)} className="btn btn--quiet">
            Open the prop
          </Link>
        </div>
      </div>
      <div className="hero__chart">{games.length ? <HitChart games={games} line={card.line} side={card.side} oneSided={card.oneSided} label="Last 10 games" height={200} /> : <Skeleton kind="chart" rows={1} />}</div>
    </article>
  )
}

function Cheatsheet({ sheet }) {
  const sport = useSport()
  return (
    <div className="sheet">
      <h3 className="sheet__title">{sheet.title}</h3>
      <p className="sheet__sub">{sheet.sub}</p>
      <ol className="sheet__rows">
        {sheet.rows.map((r) => (
          <li key={r.id}>
            <Link to={sp(sport, `/prop/${encodeURIComponent(r.id)}`)} className="sheet__row">
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
  const sport = useSport()
  return (
    <Link to={sp(sport, `/game/${g.id}`)} className={`matchup${g.status?.state === 'in' ? ' is-live' : ''}`}>
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

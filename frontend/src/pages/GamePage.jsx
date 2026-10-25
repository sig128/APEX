import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useLive } from '../lib/live.js'
import { useTitle } from '../lib/hooks.js'
import { clock, odds, pct, kickoff } from '../lib/format.js'
import { TeamLogo } from '../ui/Img.jsx'
import { PropRow } from '../ui/PropRow.jsx'
import { Tabs, Pills, Skeleton, ErrorBox, Empty, Section } from '../ui/Bits.jsx'
import { ParlayCard } from './HomePage.jsx'

export function GamePage() {
  const { id } = useParams()
  const { data, error, loading, refresh } = useApi(`/api/nfl/games/${id}`, { maxAgeMs: 15_000 })
  const g = data?.game
  const started = g && g.status?.state !== 'pre'
  useLive(started && g.status.state === 'in' ? `game:${id}` : null, () => {})
  useLive(!started ? `props:${id}` : null, () => {})
  useTitle(g ? `${g.shortName} props` : 'Game')
  const [tab, setTab] = useState(null)
  const cur = tab || (g?.status?.state === 'in' ? 'live' : 'props')

  if (error && !data) {
    return (
      <div className="container page">
        <ErrorBox error={error} onRetry={refresh} />
      </div>
    )
  }
  if (loading || !g) {
    return (
      <div className="container page">
        <Skeleton kind="hero" rows={1} />
        <Skeleton rows={8} />
      </div>
    )
  }
  const tabs = [
    { key: 'props', label: 'Props', count: data.props.length },
    { key: 'trends', label: 'Team trends' },
    { key: 'injuries', label: 'Injuries', count: data.home.injuries.length + data.away.injuries.length },
    ...(started ? [{ key: 'live', label: g.status.state === 'post' ? 'Final box' : 'Live' }] : []),
  ]
  return (
    <div className="page game">
      <div className="container">
        <Scoreboard data={data} />
        <Tabs tabs={tabs} value={cur} onChange={setTab} label="Game sections" className="game-tabs" />
        {cur === 'props' && <GameProps data={data} />}
        {cur === 'trends' && <Trends data={data} />}
        {cur === 'injuries' && <Injuries data={data} />}
        {cur === 'live' && <LiveBox data={data} />}
      </div>
    </div>
  )
}

function Scoreboard({ data }) {
  const { game: g, odds: o, predictor, venue, weather, live } = data
  const pre = g.status.state === 'pre'
  const homePct = live?.homeWinPct ?? predictor?.home ?? null
  return (
    <header className={`scoreboard${g.status.state === 'in' ? ' is-live' : ''}`}>
      <div className="scoreboard__teams">
        <Side t={g.away} side={data.away} score={!pre} />
        <div className="scoreboard__mid">
          <span className="scoreboard__clock">{clock(g.status, g.date)}</span>
          {g.situation?.text && <span className="scoreboard__sit">{g.situation.text}</span>}
          {g.broadcast && <span className="scoreboard__tv">{g.broadcast}</span>}
        </div>
        <Side t={g.home} side={data.home} score={!pre} home />
      </div>
      <div className="scoreboard__lines">
        {o?.details && (
          <span>
            Spread <b>{o.details}</b>
            {o.homeSpreadOpen != null && o.homeSpreadOpen !== o.homeSpread ? <span className="muted"> (opened {o.homeSpreadOpen > 0 ? `+${o.homeSpreadOpen}` : o.homeSpreadOpen})</span> : null}
          </span>
        )}
        {o?.total != null && (
          <span>
            Total <b>{o.total}</b>
            {o.totalOpen != null && o.totalOpen !== o.total ? <span className="muted"> (opened {o.totalOpen})</span> : null}
          </span>
        )}
        {o?.awayMl != null && (
          <span>
            Moneyline <b>{g.away.abbr} {odds(o.awayMl)}</b>, <b>{g.home.abbr} {odds(o.homeMl)}</b>
          </span>
        )}
        {data.home.implied != null && (
          <span>
            Implied <b>{g.away.abbr} {data.away.implied}</b>, <b>{g.home.abbr} {data.home.implied}</b>
          </span>
        )}
      </div>
      {homePct != null && (
        <div className="winbar" aria-label={`Win chance: ${g.home.abbr} ${Math.round(homePct)}%`}>
          <span className="winbar__k">{live?.homeWinPct != null ? 'Live win chance' : 'ESPN win chance'}</span>
          <div className="winbar__track">
            <span className="winbar__away" style={{ width: `${100 - homePct}%`, background: g.away.color || 'var(--seat-2)' }} />
            <span className="winbar__home" style={{ width: `${homePct}%`, background: g.home.color || 'var(--seat-2)' }} />
          </div>
          <span className="winbar__v num">
            {g.away.abbr} {Math.round(100 - homePct)}% / {g.home.abbr} {Math.round(homePct)}%
          </span>
        </div>
      )}
      <p className="scoreboard__venue">
        {venue?.name}
        {venue?.city ? `, ${venue.city}` : ''}
        {venue?.indoor ? ' (indoors)' : weather?.temp != null ? `, ${weather.temp}°F${weather.gust ? `, gusts ${weather.gust} mph` : ''}${weather.precip ? `, ${weather.precip}% rain` : ''}` : ''}
      </p>
    </header>
  )
}

function Side({ t, side, score, home = false }) {
  return (
    <div className={`scoreboard__side${home ? ' is-home' : ''}`}>
      <TeamLogo src={t.logo} abbr={t.abbr} size={56} />
      <div>
        <p className="scoreboard__name">{t.short || t.name}</p>
        <p className="scoreboard__rec">
          {t.record || side?.form?.record}
          {side?.form?.streak ? `, ${side.form.streak}` : ''}
        </p>
      </div>
      {score && <span className="scoreboard__score num">{t.score ?? 0}</span>}
    </div>
  )
}

function GameProps({ data }) {
  const [market, setMarket] = useState(null)
  const [team, setTeam] = useState(null)
  const [all, setAll] = useState(false)
  const markets = useMemo(() => {
    const m = new Map()
    for (const p of data.props) m.set(p.market, p.marketLabel)
    return [...m].map(([key, label]) => ({ key, label }))
  }, [data.props])
  const rows = data.props.filter((p) => (!market || p.market === market) && (!team || p.teamAbbr === team))
  const g = data.game
  return (
    <>
      <div className="filters filters--tight">
        <Pills
          label="Team"
          options={[
            { key: g.away.abbr, label: g.away.abbr },
            { key: g.home.abbr, label: g.home.abbr },
          ]}
          value={team}
          onChange={setTeam}
        />
        <div className="pills-scroll">
          <Pills label="Market" options={markets} value={market} onChange={setMarket} />
        </div>
      </div>
      {rows.length ? (
        <>
          <div className="prop-list">
            {(all ? rows : rows.slice(0, 40)).map((c) => (
              <PropRow key={c.id} c={c} />
            ))}
          </div>
          {!all && rows.length > 40 && (
            <button type="button" className="btn btn--quiet btn--block more" onClick={() => setAll(true)}>
              Show all {rows.length} props
            </button>
          )}
        </>
      ) : (
        <Empty title={data.props.length ? 'No props for that filter' : 'No player props posted yet'}>{data.props.length ? 'Try another market.' : 'Books post props through the week; this fills in as they do.'}</Empty>
      )}
      {data.teamProps?.length > 0 && (
        <Section id="team-totals" title="Team totals">
          <div className="prop-list">
            {data.teamProps.map((c) => (
              <PropRow key={c.id} c={c} />
            ))}
          </div>
        </Section>
      )}
      {data.parlays?.length > 0 && (
        <Section id="sgp" title="Same-game parlays">
          <p className="section__note">Legs from one game move together, so treat these probabilities as rough.</p>
          <div className="parlays">
            {data.parlays.map((p) => (
              <ParlayCard key={p.id} p={p} />
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

function Trends({ data }) {
  return (
    <div className="two-col">
      {[data.away, data.home].map((s) => (
        <section key={s.team.id} className="team-trends">
          <h3 className="team-trends__name">
            <TeamLogo src={s.team.logo} abbr={s.team.abbr} size={24} /> {s.team.name}
          </h3>
          <div className="team-trends__form">
            <span>
              <b className="num">{s.form.record}</b> record
            </span>
            <span>
              <b className="num">{s.form.ppg}</b> points per game
            </span>
            <span>
              <b className="num">{s.form.papg}</b> allowed
            </span>
          </div>
          <div className="last5" aria-label="Last five games">
            {(s.form.last5 || []).map((x) => (
              <Link key={x.id} to={`/nfl/game/${x.id}`} className={`last5__g is-${x.result === 'W' ? 'w' : x.result === 'L' ? 'l' : 't'}`} title={`${x.result} ${x.score} ${x.home ? 'vs' : 'at'} ${x.opp}`}>
                <b>{x.result}</b>
                <span>{x.opp}</span>
              </Link>
            ))}
          </div>
          <ul className="trend-list">
            {s.trends.map((t) => (
              <li key={t.text}>
                <span className={`trend-dot${t.hits / t.n >= 0.8 ? ' is-hot' : t.hits / t.n <= 0.2 ? ' is-cold' : ''}`} aria-hidden="true" />
                {t.text}
              </li>
            ))}
          </ul>
          {s.leaders?.length > 0 && (
            <dl className="leaders">
              {s.leaders.map((l) => (
                <div key={l.stat}>
                  <dt>{l.label}</dt>
                  <dd>
                    <Link to={`/nfl/player/${l.athleteId}`}>{l.short}</Link> {l.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}
    </div>
  )
}

function Injuries({ data }) {
  const order = { out: 0, doubtful: 1, questionable: 2, probable: 3, other: 4 }
  return (
    <div className="two-col">
      {[data.away, data.home].map((s) => (
        <section key={s.team.id}>
          <h3 className="team-trends__name">
            <TeamLogo src={s.team.logo} abbr={s.team.abbr} size={24} /> {s.team.name}
          </h3>
          {!s.injuries.length ? (
            <p className="muted">No injuries listed.</p>
          ) : (
            <ul className="inj-list">
              {[...s.injuries]
                .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
                .map((i) => (
                  <li key={i.athleteId} className={`inj is-${i.severity}`}>
                    <span className="inj__status">{i.status}</span>
                    <span className="inj__who">
                      <Link to={`/nfl/player/${i.athleteId}`}>{i.name}</Link> {i.pos}
                      {i.detail ? <span className="muted">, {i.detail}</span> : null}
                    </span>
                    {i.boosts?.length > 0 && (
                      <span className="inj__boosts">
                        Without him:{' '}
                        {i.boosts.map((b, k) => (
                          <span key={b.id}>
                            {k ? ', ' : ''}
                            <Link to={`/nfl/prop/${encodeURIComponent(b.id)}`}>
                              {b.short} {b.label}
                            </Link>{' '}
                            <b className="is-plus">+{Math.round(b.lift * 100)}%</b>
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

function LiveBox({ data }) {
  const live = data.live
  if (!live) return <Skeleton rows={6} />
  const g = data.game
  return (
    <div className="live-box">
      {live.winProb?.length > 1 && <WinCurve points={live.winProb} home={g.home} away={g.away} />}
      {(live.drive || live.lastDrive) && <DriveLine d={live.drive || live.lastDrive} current={Boolean(live.drive)} />}
      <div className="two-col">
        {[g.away, g.home].map((t) => (
          <section key={t.id}>
            <h3 className="team-trends__name">
              <TeamLogo src={t.logo} abbr={t.abbr} size={22} /> {t.abbr} leaders
            </h3>
            <ul className="box-leaders">
              {(live.leaders?.[t.id] || []).map((l) => (
                <li key={l.id}>
                  <Link to={`/nfl/player/${l.id}`}>{l.short || l.name}</Link> <span className="muted">{l.line}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Section id="live-props" title={g.status.state === 'post' ? 'How the props finished' : 'Props in play'}>
        {live.props?.length ? (
          <div className="prop-list">
            {live.props.map((p) => (
              <PropRow key={p.id} c={p} live={p.live} />
            ))}
          </div>
        ) : (
          <p className="muted">No tracked props for this game.</p>
        )}
      </Section>
      {live.scoring?.length > 0 && (
        <Section id="scoring" title="Scoring">
          <ol className="scoring">
            {live.scoring.map((s, i) => (
              <li key={i}>
                <span className="scoring__q">{s.period > 4 ? 'OT' : `Q${s.period}`} {s.clock}</span> {s.text}
                {s.away != null && (
                  <span className="scoring__score num">
                    {' '}
                    {g.away.abbr} {s.away}, {g.home.abbr} {s.home}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  )
}

function DriveLine({ d, current }) {
  return (
    <p className="live-box__drive">
      <b>{current ? `${d.teamAbbr || ''} driving` : `Last drive, ${d.teamAbbr || ''}`}</b> {d.description}
      {d.result && !current ? `, ${d.result}` : ''}
      {d.lastPlay?.text ? <span className="muted"> {d.lastPlay.text}</span> : null}
    </p>
  )
}

function WinCurve({ points, home, away }) {
  const W = 600
  const H = 80
  const xy = points.map((p, i) => [(i / Math.max(1, points.length - 1)) * W, H - (p / 100) * H])
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const area = `${line}L${W},${H / 2}L0,${H / 2}Z`
  const lastP = points[points.length - 1]
  const leader = lastP >= 50 ? home : away
  return (
    <figure className="wincurve" aria-label={`${home.abbr} win chance now ${Math.round(lastP)}%`}>
      <div className="wincurve__labels" aria-hidden="true">
        <span>{home.abbr}</span>
        <span>{away.abbr}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <clipPath id="wc-top">
            <rect x="0" y="0" width={W} height={H / 2} />
          </clipPath>
          <clipPath id="wc-bottom">
            <rect x="0" y={H / 2} width={W} height={H / 2} />
          </clipPath>
        </defs>
        <path d={area} fill={home.color || 'var(--chalk-2)'} opacity="0.35" clipPath="url(#wc-top)" />
        <path d={area} fill={away.color || 'var(--chalk-3)'} opacity="0.35" clipPath="url(#wc-bottom)" />
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="var(--seat-2)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={line} fill="none" stroke="var(--chalk)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption>
        {leader.abbr} <b className="num">{pct((lastP >= 50 ? lastP : 100 - lastP) / 100)}</b> to win
      </figcaption>
    </figure>
  )
}

export { kickoff }

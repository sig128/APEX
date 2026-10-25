import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApi, mutate } from '../lib/useApi.js'
import { useLive } from '../lib/live.js'
import { useTitle } from '../lib/hooks.js'
import { pct, odds, kickoff, num, clock, decimalOf, parseOdds, bookName } from '../lib/format.js'
import { kellyFraction } from '../lib/kelly.js'
import { toggleLeg } from '../lib/slip.js'
import { useSlip } from '../lib/useSlip.js'
import { Headshot, TeamLogo, logoFor } from '../ui/Img.jsx'
import { HitChart } from '../ui/HitChart.jsx'
import { PropRow } from '../ui/PropRow.jsx'
import { AskApex } from '../ui/AskApex.jsx'
import { Locked } from '../ui/Locked.jsx'
import { Skeleton, ErrorBox, Section } from '../ui/Bits.jsx'
import { Odds, ImpliedHint } from '../ui/Odds.jsx'

/** Which of the last 20 games belong to a window tab. */
function gamesFor(key, prop) {
  const r = prop.recent || []
  const label = prop.windows.find((w) => w.key === key)?.label
  const seasonOf = (d) => {
    const t = new Date(d)
    return t.getUTCFullYear() - (t.getUTCMonth() < 2 ? 1 : 0)
  }
  switch (key) {
    case 'L5':
      return r.slice(-5)
    case 'L10':
      return r.slice(-10)
    case 'L20':
      return r.slice(-20)
    case 'season':
    case 'last':
      return r.filter((g) => String(seasonOf(g.date)) === label)
    case 'h2h':
      return r.filter((g) => g.opp === prop.oppAbbr)
    case 'venue':
      return r.filter((g) => Boolean(g.home) === Boolean(prop.home))
    default:
      return r.slice(-10)
  }
}

export function PropPage() {
  const { id } = useParams()
  const { data, error, loading, refresh } = useApi(`/api/nfl/props/${encodeURIComponent(id)}`, { maxAgeMs: 30_000 })
  const p = data?.prop
  useTitle(p ? `${p.name} ${p.shortLabel}` : 'Prop')
  const [win, setWin] = useState('L10')
  const slip = useSlip()
  const games = useMemo(() => (p ? gamesFor(win, p) : []), [p, win])
  const path = `/api/nfl/props/${encodeURIComponent(id)}`
  // while its game is on, the prop's progress moves with every box score update
  useLive(data?.game?.status?.state === 'in' ? `game:${data.game.id}` : null, (lg) => {
    const row = lg?.props?.find((x) => x.id === p?.id)
    mutate(path, (cur) => (cur ? { ...cur, live: row?.live || cur.live, game: cur.game && lg ? { ...cur.game, status: lg.status, home: { ...cur.game.home, score: lg.home?.score }, away: { ...cur.game.away, score: lg.away?.score } } : cur.game } : undefined))
  })

  if (error && !data) {
    return (
      <div className="container page">
        <ErrorBox error={error} onRetry={refresh} />
        <p>
          <Link to="/nfl/props" className="link">
            Back to all props
          </Link>
        </p>
      </div>
    )
  }
  if (loading || !p) {
    return (
      <div className="container page">
        <Skeleton kind="hero" rows={1} />
        <Skeleton kind="chart" rows={1} />
      </div>
    )
  }

  const on = slip.legs.some((l) => l.id === p.id)
  const flipId = p.oneSided ? null : `${p.kind === 'team' ? `t${p.teamId}` : p.playerId}.${p.market}.${p.side === 'o' ? 'u' : 'o'}.${p.line}`
  const shown = p.windows.filter((w) => w.n > 0)
  const curW = p.windows.find((w) => w.key === win)
  const g = data.game
  const live = data.live

  return (
    <div className="container page prop-page">
      <header className="prop-head">
        {p.kind === 'team' ? <TeamLogo src={logoFor(p.teamAbbr)} abbr={p.teamAbbr} size={72} /> : <Headshot src={p.headshot} name={p.name} size={76} className="prop-head__img" />}
        <div className="prop-head__who">
          <h1 className="prop-head__name">{p.kind === 'team' ? p.name : <Link to={`/nfl/player/${p.playerId}`}>{p.name}</Link>}</h1>
          <p className="prop-head__meta">
            {p.pos ? `${p.pos}, ` : ''}
            {p.teamAbbr} {p.home ? 'vs' : 'at'} {p.oppAbbr}
            {g && (
              <>
                {', '}
                <Link to={`/nfl/game/${g.id}`} className="link">
                  {clock(g.status, g.date) || kickoff(p.kickoff)}
                </Link>
              </>
            )}
          </p>
          {data.injury && (
            <p className={`prop-head__inj is-${data.injury.severity}`}>
              {data.injury.status}
              {data.injury.detail ? `, ${data.injury.detail}` : ''}
            </p>
          )}
        </div>
      </header>

      <div className="prop-read">
        <div className="prop-read__main">
          <p className="prop-read__label">{p.label}</p>
          <p className="prop-read__prob">
            <span className="num">{pct(p.prob)}</span>
            <span className="prop-read__fair">
              fair <b className="num">{odds(p.fair)}</b>
            </span>
          </p>
          <dl className="prop-read__facts">
            <div>
              <dt>APEX score</dt>
              <dd className="num">{p.score}</dd>
            </div>
            {Number.isFinite(p.proj) && (
              <div>
                <dt>Projection</dt>
                <dd className="num">{num(p.proj)}</dd>
              </div>
            )}
            {Number.isFinite(p.avg) && (
              <div>
                <dt>Average</dt>
                <dd className="num">{num(p.avg)}</dd>
              </div>
            )}
            {Number.isFinite(p.median) && (
              <div>
                <dt>Median</dt>
                <dd className="num">{num(p.median)}</dd>
              </div>
            )}
            {p.move && (
              <div>
                <dt>Opened at</dt>
                <dd className="num">
                  {p.move.open}
                  <span className="fact-delta">
                    {p.move.delta > 0 ? '+' : ''}
                    {p.move.delta}
                  </span>
                </dd>
              </div>
            )}
            {p.price && (
              <div>
                <dt>{bookName(p.price.book) || 'Book'}</dt>
                <dd>
                  <Odds a={p.side === 'u' ? p.price.under : p.oneSided ? p.price.yes : p.price.over} />
                </dd>
              </div>
            )}
          </dl>
          <div className="prop-read__actions">
            <button type="button" className={`btn ${on ? 'btn--quiet' : 'btn--gold'}`} onClick={() => toggleLeg(p)} aria-pressed={on}>
              {on ? 'On your slip' : 'Add to slip'}
            </button>
            {flipId && (
              <Link to={`/nfl/prop/${encodeURIComponent(flipId)}`} className="btn btn--quiet">
                See the {p.side === 'o' ? 'under' : 'over'}
              </Link>
            )}
          </div>
          {data.alts?.length > 0 && (
            <div className="alts">
              <p className="alts__k">Other lines</p>
              <div className="alts__list">
                {data.alts.map((a) => (
                  <Link key={a.id} to={`/nfl/prop/${encodeURIComponent(a.id)}`} className="alt">
                    <span className="num">{a.line}</span>
                    <span>{pct(a.prob)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="prop-read__chart">
          <div className="win-tabs" role="tablist" aria-label="Sample">
            {shown.map((w) => (
              <button key={w.key} type="button" role="tab" aria-selected={win === w.key} className={`win-tab${win === w.key ? ' is-on' : ''}`} onClick={() => setWin(w.key)}>
                <span className="win-tab__k">{w.label}</span>
                <span className={`win-tab__v num${w.hits / w.n >= 0.8 ? ' is-hot' : w.hits / w.n < 0.4 ? ' is-cold' : ''}`}>
                  {w.hits}/{w.n}
                </span>
              </button>
            ))}
          </div>
          <HitChart games={games} line={p.line} side={p.side} oneSided={p.oneSided} label={curW?.label} height={230} />
          {p.matchup?.text && (
            <p className={`matchup-note${p.matchup.rank <= 6 ? ' is-soft' : p.matchup.rank > p.matchup.of - 6 ? ' is-tough' : ''}`}>
              <span className="num">
                {p.matchup.rank}
                <sup>{ordinal(p.matchup.rank)}</sup>
              </span>
              {p.matchup.text}. {p.matchup.perGame != null && `${num(p.matchup.perGame)} a game against a league average of ${num(p.matchup.avg)}.`}
            </p>
          )}
          {p.boost && (
            <p className="boost-note">
              {p.boost.teammate} is {String(p.boost.status || 'out').toLowerCase()}. In the {p.boost.games} {p.boost.games === 1 ? 'game' : 'games'} he missed, {p.short} averaged <b className="num">{num(p.boost.withoutAvg)}</b>, against <span className="num">{num(p.boost.avg)}</span> overall.
            </p>
          )}
        </div>
      </div>

      {live && !live.untracked && (
        <div className={`live-now is-${live.status}`}>
          <span className="num">{live.cur}</span> so far, {live.final ? 'final' : `${Math.round(live.elapsed * 100)}% of the game played, pace ${live.projected}`}
        </div>
      )}

      <div className="two-col two-col--wide">
        <AskApex propId={p.id} />
        <KellyBox p={p} />
      </div>

      {data.others?.length > 0 && (
        <Section id="others" title={`More ${p.kind === 'team' ? p.teamAbbr : p.short} props`}>
          <div className="prop-list">
            {data.others.map((c) => (
              <PropRow key={c.id} c={c} />
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th')

/** Your price in, Kelly stake out. Pro and Elite. */
function KellyBox({ p }) {
  const [price, setPrice] = useState(() => {
    const b = p.side === 'u' ? p.price?.under : p.oneSided ? p.price?.yes : p.price?.over
    return Number.isFinite(b) ? (b > 0 ? `+${b}` : String(b)) : ''
  })
  const [bank, setBank] = useState(() => {
    try {
      return Number(localStorage.getItem('apex_bankroll')) || 1000
    } catch {
      return 1000
    }
  })
  const n = parseOdds(price)
  const d = n ? decimalOf(n) : null
  const full = d ? kellyFraction(p.prob, d) : 0
  const ev = d ? p.prob * d - 1 : null
  return (
    <Locked need="pro" title="Kelly stake for this prop">
      <div className="kelly-box">
        <p className="kelly-box__title">Stake it</p>
        <div className="kelly-box__in">
          <label className="field">
            <span>Your odds</span>
            <span className="odds-field">
              <input inputMode="numeric" value={price} placeholder="e.g. -110" onChange={(e) => setPrice(e.target.value)} aria-invalid={Boolean(price) && !n} />
              <ImpliedHint a={n} />
            </span>
          </label>
          <label className="field">
            <span>Bankroll ($)</span>
            <input inputMode="decimal" value={bank} onChange={(e) => setBank(Math.max(0, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0))} />
          </label>
        </div>
        {d && (
          <dl className="kelly-box__out">
            <div>
              <dt>Edge</dt>
              <dd className={`num ${ev > 0 ? 'is-plus' : 'is-minus'}`}>{pct(ev, 1)}</dd>
            </div>
            <div>
              <dt>Quarter Kelly</dt>
              <dd className="num">${((bank * full) / 4).toFixed(2)}</dd>
            </div>
            <div>
              <dt>Full Kelly</dt>
              <dd className="num">${(bank * full).toFixed(2)}</dd>
            </div>
          </dl>
        )}
        {!price && <p className="muted">Enter the odds your sportsbook gives you. APEX compares them with its {pct(p.prob)} and sizes the bet.</p>}
        {d && full === 0 && <p className="muted">No edge at {odds(n)}: that price says {pct(1 / d, 1)}, APEX has it at {pct(p.prob, 1)}. Pass, or find a better number.</p>}
        {d && full > 0 && <p className="muted">That price says {pct(1 / d, 1)}; APEX has it at {pct(p.prob, 1)}, {((p.prob - 1 / d) * 100).toFixed(1)} points better than the book thinks.</p>}
        <Link className="link" to={`/kelly?p=${p.prob}${n ? `&odds=${n}` : ''}`}>
          Simulate a season of bets like this
        </Link>
      </div>
    </Locked>
  )
}

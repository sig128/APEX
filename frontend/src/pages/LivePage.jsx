import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useLive, useLiveState } from '../lib/live.js'
import { useTitle } from '../lib/hooks.js'
import { clock, kickoff } from '../lib/format.js'
import { useSlip } from '../lib/useSlip.js'
import { TeamLogo } from '../ui/Img.jsx'
import { PropRow } from '../ui/PropRow.jsx'
import { Section, Skeleton, Empty, Pills } from '../ui/Bits.jsx'
import { useSport, apiOf, sp, sportInfo, legRef } from '../lib/sport.js'
import { trackLegs } from '../lib/track.js'

/** Every game in progress (and the ones that just ended) with where each prop stands. */
export function LivePage() {
  const sport = useSport()
  const { data, loading } = useApi(`${apiOf(sport)}/live`, { maxAgeMs: 10_000 })
  const week = useApi(`${apiOf(sport)}/week`, { maxAgeMs: 30_000 }).data
  const stream = useLiveState()
  useTitle('Live tracker')
  const games = data?.games || []
  const liveIds = games.filter((g) => g.status?.state === 'in').map((g) => g.id)
  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Live</h1>
        <p className="page-sub">{stream === 'live' ? 'Updating as plays happen.' : stream === 'polling' ? 'Updating every few seconds.' : games.length ? 'Connecting' : ''}</p>
      </header>
      {liveIds.map((id) => (
        <Subscribe key={id} id={id} />
      ))}
      <SlipTracker />
      {loading ? (
        <Skeleton rows={8} />
      ) : games.length ? (
        games.map((g) => <LiveGame key={g.id} g={g} />)
      ) : (
        <Empty title="No games on right now">
          {nextKick(week) ? `${FOOTBALL.has(sport) ? 'Next kickoff' : 'Next game'}: ${nextKick(week)}.` : `Live tracking starts when the next ${sportInfo(sport).name} game does.`} Props on your slip are tracked here once their games start.
        </Empty>
      )}
    </div>
  )
}

const FOOTBALL = new Set(['nfl', 'ncaaf'])

function nextKick(week) {
  const pre = (week?.games || []).filter((g) => g.status?.state === 'pre').sort((a, b) => String(a.date).localeCompare(String(b.date)))[0]
  return pre ? `${pre.shortName}, ${kickoff(pre.date)}` : null
}

function Subscribe({ id }) {
  useLive(`game:${id}`, () => {})
  return null
}

const FILTERS = [
  { key: 'close', label: 'Still live' },
  { key: 'hit', label: 'Hit' },
  { key: 'miss', label: 'Missed' },
]

function LiveGame({ g }) {
  const sport = useSport()
  const [f, setF] = useState(null)
  const props = (g.props || []).filter((p) => !f || (f === 'close' ? !['hit', 'miss', 'push'].includes(p.live.status) : p.live.status === f))
  const [open, setOpen] = useState(g.status?.state === 'in')
  return (
    <section className={`live-game${g.status?.state === 'in' ? ' is-live' : ''}`}>
      <button type="button" className="live-game__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="live-game__team">
          <TeamLogo src={g.away?.logo} abbr={g.away?.abbr} size={28} /> {g.away?.abbr} <b className="num">{g.away?.score}</b>
        </span>
        <span className="live-game__clock">{clock(g.status)}</span>
        <span className="live-game__team">
          <b className="num">{g.home?.score}</b> {g.home?.abbr} <TeamLogo src={g.home?.logo} abbr={g.home?.abbr} size={28} />
        </span>
      </button>
      {open && (
        <div className="live-game__body">
          {g.situation?.text && <p className="muted">{g.situation.text}</p>}
          <Pills label="Show" options={FILTERS} value={f} onChange={setF} />
          <div className="prop-list">
            {props.slice(0, 60).map((p) => (
              <PropRow key={p.id} c={p} live={p.live} compact />
            ))}
          </div>
          <Link className="link" to={sp(sport, `/game/${g.id}`)}>
            Full game page
          </Link>
        </div>
      )}
    </section>
  )
}

/** The slip's legs with live progress (any league), refreshed by the tracker stream of the league on screen. */
function SlipTracker() {
  const sport = useSport()
  const slip = useSlip()
  const key = slip.legs.map(legRef).join(',')
  const [legs, setLegs] = useState(null)
  const started = slip.legs.some((l) => Date.parse(l.kickoff) < Date.now())
  useEffect(() => {
    if (!key || !started) return undefined
    let stop = false
    const load = () =>
      trackLegs(slip.legs)
        .then((list) => !stop && setLegs(list))
        .catch(() => {})
    load()
    const t = setInterval(load, 20_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [key, started])
  useLive(key && started ? 'tracker' : null, (diff) => {
    setLegs((cur) => cur && cur.map((l) => ((l.sport || 'nfl') === sport && diff[l.id] ? { ...l, live: diff[l.id] } : l)))
  })
  const ids = key ? key.split(',') : []
  if (!ids.length || !started || !legs) return null
  const tracked = legs.filter((l) => l.live && !l.live.untracked)
  if (!tracked.length) return null
  const decided = tracked.filter((l) => ['hit', 'miss', 'push'].includes(l.live.status))
  const lost = tracked.some((l) => l.live.status === 'miss')
  return (
    <Section id="my-slip" title="Your slip" aside={<span className={`slip-state${lost ? ' is-minus' : ''}`}>{lost ? 'A leg missed' : `${decided.length} of ${tracked.length} decided`}</span>}>
      <div className="prop-list">
        {tracked.map((l) => (
          <PropRow key={legRef(l)} c={l} live={l.live} compact />
        ))}
      </div>
    </Section>
  )
}

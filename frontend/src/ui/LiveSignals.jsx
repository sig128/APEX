import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useAuth } from '../context/AuthContext.jsx'
import { apiOf, sp } from '../lib/sport.js'
import { Headshot } from './Img.jsx'

// Live signals on the Live page: in-game value candidates with their notes (members), and the
// record of every graded candidate (everyone). Notes are "as of" the clock shown; live lines move.

const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`)

export function LiveSignals({ sport, live }) {
  const { user } = useAuth()
  // while games are on, refresh every 30 seconds; the server decides what each viewer gets
  const { data } = useApi(`${apiOf(sport)}/signals${user ? '?u=1' : ''}`, { maxAgeMs: 20_000, pollMs: live ? 30_000 : 0 })
  if (!data) return null
  const rec = data.record
  const graded = rec ? rec.hit + rec.miss : 0
  return (
    <section className="sig" aria-labelledby="sig-h">
      <div className="sig__head">
        <h2 id="sig-h" className="sig__title">
          Live signals
        </h2>
        {rec && (
          <p className="sig__rec">
            {graded ? (
              <>
                Last 30 days: <b className="num">{rec.hit}</b> of <b className="num">{graded}</b> candidates came in ({pct(rec.rate)})
                {rec.open ? `, ${rec.open} still playing` : ''}
              </>
            ) : (
              'No graded candidates yet in the last 30 days.'
            )}
          </p>
        )}
      </div>
      {data.locked ? (
        <p className="sig__locked">
          {data.count ? `${data.count} ${data.count === 1 ? 'prop is' : 'props are'} flagged right now.` : 'Props get flagged here when a game’s usage and pace pull well away from the line.'} The notes are part of Pro. <Link to="/pricing">See Pro</Link>
        </p>
      ) : data.live.length ? (
        <ul className="sig__list">
          {data.live.map((s) => (
            <li key={`${s.id}-${s.side}`} className={`sig-card is-${s.side}`}>
              <Headshot src={s.headshot} name={s.name} size={36} className="sig-card__img" />
              <div className="sig-card__body">
                <p className="sig-card__top">
                  <Link to={sp(sport, `/prop/${encodeURIComponent(s.id)}`)}>
                    <b>{s.short}</b> {s.side === 'o' ? 'over' : 'under'} {s.line}
                  </Link>
                  <span className="sig-card__tag">Candidate</span>
                  {s.clock && <span className="sig-card__clock">as of {s.clock}</span>}
                </p>
                <p className="sig-card__note">{s.note}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sig__none">{live ? 'Nothing flagged right now. A prop shows up here when its pace and the player’s usage pull well away from the line.' : 'Signals show up here during games.'}</p>
      )}
      <p className="sig__rg">
        Live betting moves fast. Decide your limits before the game, and take a break whenever you want: <Link to="/me#limits">Limits and breaks</Link>.
      </p>
    </section>
  )
}

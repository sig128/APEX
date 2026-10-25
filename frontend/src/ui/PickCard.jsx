import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Headshot } from './Img.jsx'
import { EliteBadge } from './Bits.jsx'
import { odds, units as fmtUnits, ago, kickoff, pct, bookName, impliedOf } from '../lib/format.js'
import { importLegs } from '../lib/slip.js'
import { SITE_URL } from '../lib/config.js'
import { Odds } from './Odds.jsx'
import { SendToBook } from './Books.jsx'
import { api } from '../lib/api.js'

const RESULT = { win: 'Won', loss: 'Lost', push: 'Push', void: 'Void' }

export function Avatar({ profile, size = 40 }) {
  return <Headshot src={profile?.avatar} name={profile?.name || profile?.handle} size={size} className="avatar" />
}

/** One posted pick: legs, price, units, and how it turned out. */
export function PickCard({ pick, showProfile = false, onDelete, owner = false }) {
  const locked = pick.locked || Date.now() >= pick.lockAt
  const [tails, setTails] = useState(pick.tails || 0)
  const [tailed, setTailed] = useState(false)
  const [sending, setSending] = useState(false)
  const tail = () => {
    // the legs go on your slip at the prices they were posted at; then pick a book
    importLegs(pick.legs, Object.fromEntries(pick.legs.filter((l) => Number.isFinite(l.price)).map((l) => [l.id, l.price])))
    setSending(true)
    if (!tailed) {
      setTailed(true)
      api(`/api/picks/${pick.id}/tail`, { method: 'POST', body: {} })
        .then((r) => Number.isFinite(r?.tails) && setTails(r.tails))
        .catch(() => {})
    }
  }
  const status = pick.status === 'graded' ? pick.result : locked ? 'live' : 'open'
  const shareText = `${pick.legs.length > 1 ? `${pick.legs.length}-leg parlay` : pick.legs[0].label}${pick.legs.length === 1 ? ` (${pick.legs[0].name})` : ''} ${odds(pick.price)}, ${pick.units}u. Graded live on APEX.`
  const pageUrl = `${SITE_URL}/u/${pick.handle}`
  return (
    <article className={`pick is-${status}`}>
      {showProfile && pick.profile && (
        <header className="pick__who">
          <Link to={`/u/${pick.profile.handle}`} className="pick__who-link">
            <Avatar profile={pick.profile} size={36} />
            <span>
              <b>{pick.profile.name}</b>
              <span className="muted"> @{pick.profile.handle}</span>
            </span>
          </Link>
          {pick.profile.elite && <EliteBadge small />}
          {pick.profile.record?.d30?.graded > 0 && (
            <span className={`pick__rec num${pick.profile.record.d30.units >= 0 ? ' is-plus' : ' is-minus'}`}>
              {pick.profile.record.d30.wins}-{pick.profile.record.d30.losses}, {fmtUnits(pick.profile.record.d30.units)} 30d
            </span>
          )}
        </header>
      )}
      <ul className="pick__legs">
        {pick.legs.map((l) => (
          <li key={l.id} className={`pick-leg${l.result ? ` is-${l.result}` : ''}`}>
            <Headshot src={l.headshot} name={l.name} size={30} />
            <span className="pick-leg__what">
              <Link to={`/nfl/prop/${encodeURIComponent(l.id)}`}>
                <b>{l.name}</b> {l.label}
              </Link>
              <span className="muted">
                {l.teamAbbr} {l.oppAbbr ? `vs ${l.oppAbbr}` : ''}, APEX {pct(l.prob)} when posted, {Number.isFinite(l.price) ? `${odds(l.price)} (${pct(impliedOf(l.price), 1)})${l.book ? ` at ${bookName(l.book)}` : ''}` : 'no price listed (graded at -110)'}
              </span>
            </span>
            <span className="pick-leg__res">{l.result ? `${RESULT[l.result] || l.result}${l.value != null ? ` (${l.value})` : ''}` : ''}</span>
          </li>
        ))}
      </ul>
      {pick.note && <p className="pick__note">{pick.note}</p>}
      <footer className="pick__foot">
        <Odds a={pick.price} className="pick__price" />
        <span className="pick__units num">{pick.units}u</span>
        <span className={`pick__status is-${status}`}>
          {status === 'open' && `Locks ${kickoff(new Date(pick.lockAt).toISOString())}`}
          {status === 'live' && 'In play'}
          {pick.status === 'graded' && `${RESULT[pick.result]}${pick.profit ? `, ${fmtUnits(pick.profit)}` : ''}`}
        </span>
        <span className="pick__when muted">
          {ago(pick.createdAt)}
          {tails > 0 && `, ${tails} tailing`}
        </span>
        <span className="pick__acts">
          {!locked && !owner && (
            <button type="button" className="btn btn--gold btn--s pick__tail" onClick={tail}>
              Tail
            </button>
          )}
          <a className="linkish" href={`https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}`} target="_blank" rel="noopener noreferrer">
            Post on X
          </a>
          {owner && !locked && onDelete && (
            <button type="button" className="linkish is-minus" onClick={() => onDelete(pick)}>
              Delete
            </button>
          )}
        </span>
      </footer>
      {sending && <SendToBook open={sending} onClose={() => setSending(false)} legs={pick.legs} p={pick.legs.reduce((x, l) => x * (l.prob || 0), 1) || null} title={`Tail ${pick.handle ? `@${pick.handle}` : 'this pick'} at a sportsbook`} />}
    </article>
  )
}

/** W-L, units, ROI and the last ten as a strip. */
export function RecordPanel({ title, r }) {
  if (!r) return null
  return (
    <div className="record">
      <p className="record__title">{title}</p>
      <p className="record__wl num">
        {r.wins}-{r.losses}
        {r.pushes ? `-${r.pushes}` : ''}
      </p>
      <dl className="record__facts">
        <div>
          <dt>Units</dt>
          <dd className={`num ${r.units > 0 ? 'is-plus' : r.units < 0 ? 'is-minus' : ''}`}>{fmtUnits(r.units)}</dd>
        </div>
        <div>
          <dt>ROI</dt>
          <dd className="num">{r.roi == null ? '–' : `${(r.roi * 100).toFixed(1)}%`}</dd>
        </div>
        <div>
          <dt>Hit rate</dt>
          <dd className="num">{r.hitRate == null ? '–' : pct(r.hitRate)}</dd>
        </div>
        <div>
          <dt>Streak</dt>
          <dd className="num">{r.streak || '–'}</dd>
        </div>
      </dl>
      {r.last10?.length > 0 && (
        <div className="record__last" aria-label={`Last ${r.last10.length}: ${r.last10.join(' ')}`}>
          {r.last10.map((x, i) => (
            <span key={i} className={x === 'W' ? 'is-w' : 'is-l'}>
              {x}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

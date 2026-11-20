import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useAuth } from '../context/AuthContext.jsx'
import { apiOf } from '../lib/sport.js'
import { Headshot } from './Img.jsx'
import { Section } from './Bits.jsx'

// Lineup and injury news on the board: changes as they happen, then the report as it stands.
// Members get the note on what each one means for the board; everyone else sees the headline and
// a frosted note (the server doesn't send it).

const TAG = { out: 'Out', doubtful: 'Doubtful', questionable: 'Questionable', daytoday: 'Day-to-day', probable: 'Probable' }
const since = (t) => {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

function Item({ x, locked }) {
  const tag = x.tag ? TAG[x.tag] || x.tag : 'Off the report'
  return (
    <li className={`news-item is-${x.tag || 'clear'}`}>
      <Headshot src={x.player.headshot} name={x.player.name} size={36} className="news-item__img" />
      <div className="news-item__body">
        <p className="news-item__top">
          <b>{x.player.name}</b>
          <span className={`news-tag is-${x.tag || 'clear'}`}>{tag}</span>
          {x.detail && <span className="news-item__detail">{x.detail}</span>}
          {x.kind === 'change' && <span className="news-item__when">{since(x.at)}</span>}
        </p>
        {locked ? (
          <p className="news-item__note is-frost" aria-hidden="true">
            <span />
            <span />
          </p>
        ) : (
          x.note && <p className="news-item__note">{x.note}</p>
        )}
      </div>
    </li>
  )
}

export function NewsFeed({ sport }) {
  const { user } = useAuth()
  const { data } = useApi(`${apiOf(sport)}/news${user ? '?u=1' : ''}`, { maxAgeMs: 60_000, pollMs: 120_000 })
  const [more, setMore] = useState(false)
  if (!data || (!data.changes.length && !data.report.length)) return null
  const report = more ? data.report : data.report.slice(0, 6)
  return (
    <Section id="news" title="Lineup & injury news">
      {data.locked && (
        <p className="news-lock">
          What each one means for the board (whose props come off, and which teammates produced more without him) is part of Pro. <Link to="/pricing">See Pro</Link>
        </p>
      )}
      {data.changes.length > 0 && (
        <>
          <p className="news-k">Just in</p>
          <ul className="news-list">
            {data.changes.slice(0, 8).map((x, i) => (
              <Item key={`${x.id}-${x.at}-${i}`} x={x} locked={data.locked} />
            ))}
          </ul>
        </>
      )}
      {report.length > 0 && (
        <>
          <p className="news-k">On the report</p>
          <ul className="news-list">
            {report.map((x) => (
              <Item key={x.id} x={x} locked={data.locked} />
            ))}
          </ul>
          {data.report.length > 6 && (
            <button type="button" className="linkish" onClick={() => setMore((v) => !v)}>
              {more ? 'Show fewer' : `Show all ${data.report.length}`}
            </button>
          )}
        </>
      )}
    </Section>
  )
}

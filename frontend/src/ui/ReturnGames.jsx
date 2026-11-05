import { useState } from 'react'

const RES = { hit: 'Over', miss: 'Under', push: 'Push' }

/**
 * How a player has done in his first games back from an absence this season, against today's
 * line. The server leaves it out under three games.
 */
export function ReturnGames({ r, name, marketLabel }) {
  const [all, setAll] = useState(false)
  if (!r?.show) return null
  const side = r.side === 'u' ? 'under' : 'over'
  const rows = all ? r.games : r.games.slice(0, 5)
  const word = (g) => (r.side === 'u' ? (g.result === 'hit' ? 'Under' : g.result === 'miss' ? 'Over' : 'Push') : RES[g.result] || '')
  return (
    <section className="returns" aria-labelledby="returns-title">
      <div className="returns__head">
        <h2 id="returns-title" className="section__title">
          Back from an absence
        </h2>
        <p className="returns__sum">
          <b className="num">
            {r.hits}/{r.decided}
          </b>{' '}
          {side} {r.line} in {name}’s first games back this season{r.n < 8 ? ' (small sample)' : ''}
        </p>
      </div>
      <p className="muted small">
        Each game is one of his first five after missing games, measured against today’s line of {r.line} {marketLabel ? marketLabel.toLowerCase() : ''}. Average margin {r.avgMargin > 0 ? '+' : ''}
        {r.avgMargin}.
      </p>
      <div className="table-wrap">
        <table className="log returns__table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Opp</th>
              <th scope="col" className="num-col">
                Game back
              </th>
              <th scope="col" className="num-col">
                Stat
              </th>
              <th scope="col" className="num-col">
                vs {r.line}
              </th>
              <th scope="col" className="num-col">
                Margin
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.eventId} className={g.result === 'hit' ? 'is-hit' : g.result === 'miss' ? 'is-miss' : ''}>
                <td>{g.date}</td>
                <td>
                  {g.home ? 'vs' : '@'} {g.opp}
                </td>
                <td className="num-col num">
                  {g.k}
                  <span className="muted returns__missed"> after {g.missed} missed</span>
                </td>
                <td className="num-col num">{g.v}</td>
                <td className="num-col">{word(g)}</td>
                <td className={`num-col num ${g.margin > 0 ? 'is-plus' : g.margin < 0 ? 'is-minus' : ''}`}>
                  {g.margin > 0 ? '+' : ''}
                  {g.margin}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.games.length > 5 && (
        <button type="button" className="linkish" onClick={() => setAll((x) => !x)}>
          {all ? 'Show fewer' : `Show all ${r.games.length}`}
        </button>
      )}
    </section>
  )
}

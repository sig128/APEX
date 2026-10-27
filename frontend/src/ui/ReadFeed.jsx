/**
 * The read behind a prop's numbers: the bottom line, then each reason in plain words, marked as
 * helping the pick, hurting it, or just context. The notes weigh the hit rate against tonight's
 * opponent (how the player does against defenses like this one), head to head, the projection,
 * the recent trend, injuries and line moves.
 */
const MARK = { for: '+', against: '−', info: '•' }
const SAY = { for: 'Helps the pick: ', against: 'Hurts the pick: ', info: '' }

export function ReadFeed({ p }) {
  if (!p?.read && !p?.notes?.length) return null
  return (
    <section className="read-feed" aria-label="The read">
      {p.read && (
        <p className={`read-feed__lean is-${p.read.lean}`}>
          <b>{p.read.label}:</b> {p.read.text}
        </p>
      )}
      {p.notes?.length > 0 && (
        <ul className="read-feed__list">
          {p.notes.map((n) => (
            <li key={n.key} className={`read-feed__item is-${n.tone}`}>
              <span className="read-feed__mark" aria-hidden="true">
                {MARK[n.tone] || MARK.info}
              </span>
              <span>
                {SAY[n.tone] && <span className="sr-only">{SAY[n.tone]}</span>}
                {n.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

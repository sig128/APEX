import { Link } from 'react-router-dom'
import { useTitle } from '../lib/hooks.js'

export function NotFound() {
  useTitle('Not found')
  return (
    <div className="container page">
      <div className="empty">
        <p className="empty__title">That page isn't here.</p>
        <p className="empty__body">The link may be old, or the game may be off this week's board.</p>
        <Link to="/" className="btn btn--gold">
          Back to today's props
        </Link>
      </div>
    </div>
  )
}

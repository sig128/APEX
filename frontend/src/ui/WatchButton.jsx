import { toggleWatch, useWatch } from '../lib/watch.js'

/** A star that adds the game to "My games". */
export function WatchButton({ game, className = '', label = false }) {
  const ids = useWatch()
  const on = ids.includes(String(game.id))
  const name = game.shortName || `${game.away?.abbr} at ${game.home?.abbr}`
  return (
    <button
      type="button"
      className={`watch${on ? ' is-on' : ''}${label ? ' watch--label' : ''} ${className}`}
      aria-pressed={on}
      aria-label={on ? `Stop watching ${name}` : `Watch ${name}`}
      title={on ? 'In My games' : 'Add to My games'}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        toggleWatch(game.id)
      }}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path d="M10 2.6l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 7.9l5-.7z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
      {label && <span>{on ? 'Watching' : 'Watch this game'}</span>}
    </button>
  )
}

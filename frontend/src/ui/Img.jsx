import { useState } from 'react'

/** ESPN headshot with a quiet silhouette when there isn't one. */
export function Headshot({ src, name, size = 40, className = '' }) {
  const [bad, setBad] = useState(false)
  const initials = String(name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
  return (
    <span className={`headshot ${className}`} style={{ width: size, height: size }}>
      {src && !bad ? <img src={src} alt="" loading="lazy" decoding="async" width={size} height={size} onError={() => setBad(true)} /> : <span className="headshot__initials" aria-hidden="true">{initials}</span>}
    </span>
  )
}

export function TeamLogo({ src, abbr, size = 20, className = '' }) {
  const [bad, setBad] = useState(false)
  if (!src || bad) return <span className={`team-logo team-logo--text ${className}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>{abbr}</span>
  return <img className={`team-logo ${className}`} src={src} alt={abbr ? `${abbr} logo` : ''} width={size} height={size} loading="lazy" decoding="async" onError={() => setBad(true)} />
}

/** Logo URL for a team abbreviation (ESPN's CDN); used where the API only gives the abbreviation. */
// ESPN keeps a logo per league folder; college teams go by id, so their cards carry the logo
const LOGO_DIR = { nfl: 'nfl', nba: 'nba', mlb: 'mlb', nhl: 'nhl', wnba: 'wnba' }
export const logoFor = (abbr, sport = 'nfl') => (abbr && LOGO_DIR[sport] ? `https://a.espncdn.com/i/teamlogos/${LOGO_DIR[sport]}/500/${String(abbr).toLowerCase()}.png` : null)

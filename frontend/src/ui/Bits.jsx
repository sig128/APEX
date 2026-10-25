import { ratio, rate } from '../lib/format.js'

/** Hit-rate chip: "L10 8/10", colored by how often it hit. */
export function RateChip({ w, label }) {
  if (!w) return null
  const r = rate(w)
  const tone = r == null ? '' : r >= 0.8 ? 'is-hot' : r >= 0.6 ? 'is-warm' : r < 0.4 ? 'is-cold' : ''
  return (
    <span className={`rate-chip ${tone}`} title={`${label || w.label}: hit ${ratio(w)}`}>
      <span className="rate-chip__k">{label || w.label}</span>
      <span className="rate-chip__v num">{ratio(w)}</span>
    </span>
  )
}

export function Tabs({ tabs, value, onChange, label, className = '' }) {
  return (
    <div className={`tabs ${className}`} role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={`tabs__tab${value === t.key ? ' is-on' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count != null && <span className="tabs__count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** A row of toggles (filters). multiple = several on at once. */
export function Pills({ options, value, onChange, multiple = false, label }) {
  const on = (k) => (multiple ? (value || []).includes(k) : value === k)
  const click = (k) => {
    if (!multiple) return onChange(value === k ? null : k)
    const cur = new Set(value || [])
    if (cur.has(k)) cur.delete(k)
    else cur.add(k)
    onChange([...cur])
  }
  return (
    <div className="pills" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" className={`pill${on(o.key) ? ' is-on' : ''}`} aria-pressed={on(o.key)} onClick={() => click(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <p className="empty__body">{children}</p>}
      {action}
    </div>
  )
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null
  return (
    <div className="error-box" role="alert">
      <p>{error.message || String(error)}</p>
      {onRetry && (
        <button type="button" className="btn btn--quiet" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

/** Grey bars in the shape of the content that's loading. */
export function Skeleton({ rows = 6, kind = 'row' }) {
  return (
    <div className={`skeleton skeleton--${kind}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton__bar" style={{ animationDelay: `${i * 60}ms` }} />
      ))}
    </div>
  )
}

export function EliteBadge({ small = false }) {
  return (
    <span className={`elite-badge${small ? ' elite-badge--s' : ''}`} title="Elite member">
      Elite
    </span>
  )
}

export function Section({ title, aside, children, id, className = '' }) {
  return (
    <section className={`section ${className}`} aria-labelledby={id}>
      <div className="section__head">
        <h2 className="section__title" id={id}>
          {title}
        </h2>
        {aside && <div className="section__aside">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

/** "+" that becomes a check once the prop is on the slip. */
export function SlipToggle({ on, onClick, label }) {
  return (
    <button type="button" className={`slip-toggle${on ? ' is-on' : ''}`} aria-pressed={on} aria-label={on ? `Remove ${label} from slip` : `Add ${label} to slip`} onClick={onClick}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        {on ? <path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />}
      </svg>
    </button>
  )
}

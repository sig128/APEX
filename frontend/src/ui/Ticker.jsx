import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { useApi, mutate, load } from '../lib/useApi.js'
import { useLive, resetLiveAuth } from '../lib/live.js'
import { useAuth } from '../context/AuthContext.jsx'
import { apiOf, sp } from '../lib/sport.js'

// The live movement ticker on PropPickz's posted picks. Members get it live (the stream, or a poll
// when streaming can't get through); everyone else sees a snapshot at least 30 minutes old under
// glass. The server decides which, so the live list never reaches a free browser.

// ---- a small shared store, so the board's rows can show a pick's latest move -----------------
const marks = new Map() // sport -> Map(key -> item)
const subs = new Set()
function publish(sport, items) {
  marks.set(sport, new Map((items || []).map((it) => [it.key, it])))
  for (const fn of subs) fn()
}
const subscribe = (fn) => {
  subs.add(fn)
  return () => subs.delete(fn)
}
const keyOf = (c) => `${c.playerId ? c.playerId : `t${c.teamId}`}.${c.market}.${c.side === 'u' ? 'u' : 'o'}`

/** The ticker's line for a board card, when the viewer gets the live ticker. */
export function useTickerItem(c, sport) {
  const s = c?.sport || sport
  return useSyncExternalStore(subscribe, () => (c ? marks.get(s)?.get(keyOf(c)) || null : null), () => null)
}

// ---- formatting -----------------------------------------------------------------------------
const fmtOdds = (a) => (a == null ? '' : a > 0 ? `+${a}` : `−${Math.abs(a)}`)
function since(t) {
  if (!t) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}
function newsOf(it) {
  const e = it.events?.[0]
  if (!e) return it.why || ''
  if (e.kind === 'post') return it.posted?.price != null ? `Posted at ${fmtOdds(it.posted.price)}` : 'Posted'
  return e.text
}
const STATUS_SHORT = { valid: 'Still valid', moved: 'Line moved', risk: 'At risk', void: 'Voided', live: 'In play', closed: 'Closed' }

function Arrow({ dir }) {
  if (dir === 'up')
    return (
      <svg className="tick__arrow is-up" viewBox="0 0 10 10" aria-label="Moved toward the pick" role="img">
        <path d="M5 1.5 9 8.5H1z" />
      </svg>
    )
  if (dir === 'down')
    return (
      <svg className="tick__arrow is-down" viewBox="0 0 10 10" aria-label="Moved against the pick" role="img">
        <path d="M5 8.5 1 1.5h8z" />
      </svg>
    )
  return <span className="tick__arrow is-flat" aria-hidden="true" />
}

// ---- alerts ---------------------------------------------------------------------------------
const PREF_KEY = 'apex_ticker_alerts'
const LEVELS = [
  { key: 'big', label: 'Big moves', note: 'A point or more, 20 cents or more, injury news and picks at risk' },
  { key: 'all', label: 'Every change', note: 'Each line, price and news update' },
  { key: 'risk', label: 'Only picks at risk', note: 'When a pick turns risky or is voided' },
  { key: 'off', label: 'Off', note: 'No alerts' },
]
function readPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) || 'null')
    return { level: LEVELS.some((l) => l.key === v?.level) ? v.level : 'big', notify: Boolean(v?.notify) }
  } catch {
    return { level: 'big', notify: false }
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p))
  } catch {
    /* blocked: kept for this visit */
  }
}
/** Does this change clear the viewer's bar for an alert? */
export function alertable(level, it, ev) {
  if (level === 'off' || ev.kind === 'post') return false
  if (level === 'all') return true
  const bad = it.status === 'risk' || it.status === 'void'
  if (level === 'risk') return bad && ev.kind !== 'book'
  if (ev.kind === 'line') return (ev.size ?? 1) >= 1 || bad
  if (ev.kind === 'price') return (ev.size ?? 0) >= 20 || bad
  if (ev.kind === 'book') return false
  return true
}

function Alerts({ prefs, setPrefs }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const off = (e) => {
      if (!box.current?.contains(e.target)) setOpen(false)
    }
    const esc = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const set = (p) => {
    const next = { ...prefs, ...p }
    setPrefs(next)
    savePrefs(next)
  }
  const canNotify = typeof Notification !== 'undefined'
  const toggleNotify = async () => {
    if (prefs.notify) return set({ notify: false })
    if (!canNotify) return
    const ok = Notification.permission === 'granted' || (await Notification.requestPermission().catch(() => 'denied')) === 'granted'
    set({ notify: ok })
  }
  return (
    <div className="ticker__alerts" ref={box}>
      <button type="button" className={`ticker__bell${prefs.level !== 'off' ? ' is-on' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} title="Alerts">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 2.5a5 5 0 0 0-5 5v3.2L3.6 13.4a.8.8 0 0 0 .7 1.2h11.4a.8.8 0 0 0 .7-1.2L15 10.7V7.5a5 5 0 0 0-5-5Zm-2 13.4a2 2 0 0 0 4 0" />
        </svg>
        <span className="sr-only">Alerts</span>
      </button>
      {open && (
        <div className="ticker__menu" role="dialog" aria-label="Line move alerts">
          <p className="ticker__menu-h">Alert me about</p>
          {LEVELS.map((l) => (
            <label key={l.key} className="ticker__opt">
              <input type="radio" name="ticker-level" checked={prefs.level === l.key} onChange={() => set({ level: l.key })} />
              <span>
                <b>{l.label}</b>
                <small>{l.note}</small>
              </span>
            </label>
          ))}
          {canNotify && (
            <label className="ticker__opt ticker__opt--check">
              <input type="checkbox" checked={prefs.notify} onChange={toggleNotify} disabled={prefs.level === 'off'} />
              <span>
                <b>Browser notifications</b>
                <small>Also while PropPickz is in another tab</small>
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}

function Toasts({ list, dismiss }) {
  if (!list.length) return null
  return (
    <div className="tick-toasts" role="status" aria-live="polite">
      {list.map(({ id, it, ev }) => (
        <div key={id} className={`tick-toast is-${it.status}`}>
          <Arrow dir={ev.dir} />
          <Link to={sp(it.sport, `/prop/${encodeURIComponent(it.id)}`)} className="tick-toast__body" onClick={() => dismiss(id)}>
            <b>
              {it.short} {it.shortLabel}
            </b>
            <span>{ev.text}</span>
          </Link>
          <button type="button" className="tick-toast__x" onClick={() => dismiss(id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

// ---- the bar ----------------------------------------------------------------------------------
function Item({ it, hidden }) {
  const tag = it.status !== 'valid'
  const body = (
    <>
      <Arrow dir={it.dir} />
      <span className="tick__who">{it.short}</span>
      <span className="tick__what">{it.shortLabel}</span>
      <span className="tick__news">{newsOf(it)}</span>
      {tag ? <span className={`tick__tag tick__tag--${it.status}`}>{STATUS_SHORT[it.status]}</span> : <span className="tick__tag tick__tag--valid">Still valid</span>}
      <span className="tick__ago">{since(it.at)}</span>
    </>
  )
  return (
    <li className={`tick is-${it.status}`}>
      {hidden ? (
        <span className="tick__link">{body}</span>
      ) : (
        <Link to={sp(it.sport, `/prop/${encodeURIComponent(it.id)}`)} className="tick__link" title={it.why || undefined}>
          {body}
        </Link>
      )}
    </li>
  )
}

const GHOSTS = Array.from({ length: 6 }, (_, i) => ({ key: `g${i}`, id: '', sport: 'nfl', short: ['J. Allen', 'C. McCaffrey', 'J. Chase', 'S. Barkley', 'T. Kelce', 'A. St. Brown'][i], shortLabel: ['O 245.5 Pass Yds', 'O 85.5 Rush Yds', 'O 6.5 Rec', 'Anytime TD', 'O 54.5 Rec Yds', 'O 7.5 Rec'][i], status: ['moved', 'valid', 'risk', 'moved', 'valid', 'moved'][i], dir: ['up', null, 'down', 'up', null, 'down'][i], events: [{ kind: 'line', text: 'Line moved' }], at: 0 }))

export function TickerBar({ sport }) {
  const url = `${apiOf(sport)}/ticker`
  const { user } = useAuth()
  const { data } = useApi(url, { maxAgeMs: 30_000 })
  const locked = data ? data.locked !== false : true
  const [prefs, setPrefs] = useState(readPrefs)
  const [toasts, setToasts] = useState([])
  const seen = useRef(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  // signed in or out: a fresh answer from the server, and a fresh ticket for the stream
  const uid = user?.uid || null
  const firstUid = useRef(uid)
  useEffect(() => {
    if (firstUid.current === uid) return
    firstUid.current = uid
    resetLiveAuth()
    load(url, { force: true }).catch(() => {})
  }, [uid, url])

  // members: changes arrive on the stream
  useLive(data && !locked ? 'ticker' : null, (d) => {
    if (d?.items) mutate(url, (cur) => ({ ...(cur || {}), ...d, live: true, locked: false }))
  })

  // share the live list with the board's rows, and raise alerts for news since the last look
  useEffect(() => {
    if (!data || locked) {
      publish(sport, [])
      return
    }
    publish(sport, data.items)
    const newest = Math.max(0, ...data.items.map((it) => it.events?.[0]?.t || 0))
    if (seen.current == null) {
      seen.current = newest
      return
    }
    const since0 = seen.current
    seen.current = Math.max(seen.current, newest)
    const { level, notify } = prefsRef.current
    const fresh = []
    for (const it of data.items) for (const ev of it.events || []) if (ev.t > since0 && alertable(level, it, ev)) fresh.push({ id: `${it.key}:${ev.t}:${ev.kind}`, it, ev })
    if (!fresh.length) return
    setToasts((cur) => [...fresh.slice(0, 3), ...cur].slice(0, 3))
    if (notify && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      for (const { it, ev } of fresh.slice(0, 3)) {
        try {
          new Notification(`${it.short} ${it.shortLabel}`, { body: ev.text, tag: it.key })
        } catch {
          /* some browsers only notify from a service worker */
        }
      }
    }
  }, [data, locked, sport])
  useEffect(() => () => publish(sport, []), [sport])

  // toasts leave on their own
  useEffect(() => {
    if (!toasts.length) return undefined
    const t = setTimeout(() => setToasts((cur) => cur.slice(0, -1)), 9000)
    return () => clearTimeout(t)
  }, [toasts])

  const items = useMemo(() => (locked ? (data?.items?.length ? data.items : GHOSTS) : data?.items || []), [data, locked])
  if (!data) return null
  const count = locked ? data.count || items.length : items.length
  // speed: about four seconds an item, never a blur
  const dur = Math.max(30, items.length * 4)
  const moving = items.length > 2
  return (
    <section className={`ticker${locked ? ' ticker--locked' : ''}`} aria-labelledby="ticker-h">
      <div className="ticker__in">
        <div className="ticker__label">
          <span className={`ticker__dot${locked ? '' : ' is-live'}`} aria-hidden="true" />
          <h2 id="ticker-h" className="ticker__title">
            Live moves
          </h2>
          <span className="ticker__count">{count ? `${count} picks` : 'Waiting for picks'}</span>
        </div>
        <div className="ticker__viewport" aria-hidden={locked || undefined}>
          {items.length ? (
            <ul className={`ticker__track${moving ? ' is-moving' : ''}`} style={{ '--dur': `${dur}s` }}>
              {items.map((it) => (
                <Item key={it.key} it={it} hidden={locked} />
              ))}
              {moving &&
                items.map((it) => (
                  <li key={`${it.key}-again`} className={`tick is-${it.status}`} aria-hidden="true">
                    <span className="tick__link" tabIndex={-1}>
                      <Arrow dir={it.dir} />
                      <span className="tick__who">{it.short}</span>
                      <span className="tick__what">{it.shortLabel}</span>
                      <span className="tick__news">{newsOf(it)}</span>
                      <span className={`tick__tag tick__tag--${it.status}`}>{STATUS_SHORT[it.status]}</span>
                      <span className="tick__ago">{since(it.at)}</span>
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="ticker__empty">No moves yet. Lines, prices and injury news on today’s picks show up here as they happen.</p>
          )}
        </div>
        {locked ? (
          <Link to="/pricing" className="ticker__unlock">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2h.5A1.5 1.5 0 0 1 13.5 8.5v5A1.5 1.5 0 0 1 12 15H4a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 4 7Zm1.5 0h4V5a2 2 0 1 0-4 0Z" />
            </svg>
            <span>
              Live with <b>Pro</b>
            </span>
          </Link>
        ) : (
          <Alerts prefs={prefs} setPrefs={setPrefs} />
        )}
      </div>
      {locked && <p className="ticker__note">Shown 30+ minutes late and blurred. Pro members see every move the moment it happens, with alerts.</p>}
      {!locked && <Toasts list={toasts} dismiss={(id) => setToasts((cur) => cur.filter((x) => x.id !== id))} />}
    </section>
  )
}

/** On a board card: the pick's latest move since it was posted (members). */
export function TickMark({ c }) {
  const it = useTickerItem(c)
  if (!it) return null
  const bad = it.status === 'risk' || it.status === 'void'
  const lineMoved = it.moved?.line ? it.now?.line : null
  const priceMoved = !lineMoved && it.now?.price != null && it.posted?.price != null && it.now.price !== it.posted.price ? it.now.price : null
  if (!bad && !it.dir && lineMoved == null && priceMoved == null) return null
  return (
    <span className={`tickmark${bad ? ` is-${it.status}` : it.dir ? ` is-${it.dir}` : ''}`} title={newsOf(it)}>
      {bad ? (
        <span className="tickmark__tag">{STATUS_SHORT[it.status]}</span>
      ) : (
        <>
          <Arrow dir={it.dir} />
          <span className="num">{lineMoved != null ? lineMoved : fmtOdds(priceMoved)}</span>
        </>
      )}
      <span className="tickmark__ago">{since(it.at)}</span>
    </span>
  )
}

import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useDebounced } from '../lib/hooks.js'
import { Headshot } from './Img.jsx'
import { useSport, apiOf, sp, sportInfo } from '../lib/sport.js'

/** Find a player: type a name, arrow to a result, Enter to open it. */
export function Search({ autoFocus = false, onDone }) {
  const sport = useSport()
  const [q, setQ] = useState('')
  const [res, setRes] = useState(null)
  const [i, setI] = useState(0)
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const dq = useDebounced(q.trim(), 180)
  const box = useRef(null)
  const listId = useId()

  useEffect(() => {
    if (dq.length < 2) {
      setRes(null)
      return undefined
    }
    let live = true
    api(`${apiOf(sport)}/search?q=${encodeURIComponent(dq)}`, { auth: false })
      .then((r) => live && (setRes(r), setI(0)))
      .catch(() => live && setRes({ players: [], teams: [] }))
    return () => {
      live = false
    }
  }, [dq, sport])

  useEffect(() => {
    const off = (e) => box.current && !box.current.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [])

  const players = res?.players || []
  const go = (p) => {
    setOpen(false)
    setQ('')
    onDone?.()
    nav(sp(sport, `/player/${p.id}`))
  }

  return (
    <div className="search" ref={box}>
      <svg className="search__icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M13.2 13.2L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <input
        className="search__input"
        type="search"
        placeholder={`Search ${sportInfo(sport).name} players`}
        aria-label={`Search ${sportInfo(sport).name} players`}
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setI((x) => Math.min(players.length - 1, x + 1))
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setI((x) => Math.max(0, x - 1))
          }
          if (e.key === 'Enter' && players[i]) go(players[i])
          if (e.key === 'Escape') setOpen(false)
        }}
        role="combobox"
        aria-expanded={open && players.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {open && res && dq.length >= 2 && (
        <ul className="search__results" id={listId} role="listbox">
          {players.length === 0 && <li className="search__none">No {sportInfo(sport).name} player matches “{dq}”.</li>}
          {players.map((p, k) => (
            <li key={p.id} role="option" aria-selected={k === i}>
              <button type="button" className={`search__item${k === i ? ' is-on' : ''}`} onMouseEnter={() => setI(k)} onClick={() => go(p)}>
                <Headshot src={p.headshot} name={p.name} size={28} />
                <span>{p.name}</span>
                <span className="search__meta">
                  {p.pos} {p.teamAbbr}
                </span>
                {!p.hasProps && <span className="search__meta">no props</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

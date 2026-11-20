import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'

/**
 * A small "?" next to a term: tap for its plain definition from Tips & Tricks, and a link to the
 * full entry. Definitions come from the same legend the Tips & Tricks page shows.
 */
export function HelpTip({ id, label }) {
  const [open, setOpen] = useState(false)
  const { data } = useApi(open ? '/api/learn' : null, { maxAgeMs: 10 * 60_000 })
  const x = data?.entries?.find((e) => e.id === id)
  const box = useRef(null)
  const tipId = useId()
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
  return (
    <span className="helptip" ref={box}>
      <button type="button" className="helptip__btn" aria-expanded={open} aria-controls={tipId} aria-label={`What is ${label || id.replace(/-/g, ' ')}?`} onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOpen((v) => !v)
      }}>
        ?
      </button>
      {open && (
        <span className="helptip__pop" id={tipId} role="tooltip">
          <b>{x?.term || label || id}</b>
          <span>{x ? x.def : 'Loading…'}</span>
          <Link to={`/learn#${id}`} onClick={() => setOpen(false)}>
            More in Tips &amp; Tricks
          </Link>
        </span>
      )}
    </span>
  )
}

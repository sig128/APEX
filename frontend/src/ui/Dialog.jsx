import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/** A modal sheet: traps focus, closes on Escape or a click outside, returns focus after. */
export function Dialog({ open, onClose, title, children, wide = false, labelledBy }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const prev = document.activeElement
    const el = ref.current
    const focusables = () => [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null)
    el.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
      if (e.key === 'Tab') {
        const f = focusables()
        if (!f.length) return
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault()
          f[f.length - 1].focus()
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault()
          f[0].focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      prev?.focus?.()
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="dialog" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`dialog__sheet${wide ? ' dialog__sheet--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy || 'dialog-title'} ref={ref} tabIndex={-1}>
        <div className="dialog__head">
          <h2 id={labelledBy || 'dialog-title'} className="dialog__title">
            {title}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="dialog__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Width of an element, kept current as it resizes. Returns a callback ref, so it follows the
 * element even when it mounts later (a chart that first rendered an empty state).
 */
export function useWidth(initial = 600) {
  const [w, setW] = useState(initial)
  const ro = useRef(null)
  const ref = useCallback((el) => {
    ro.current?.disconnect()
    ro.current = null
    if (!el) return
    const set = () => setW(Math.max(120, Math.round(el.getBoundingClientRect().width)))
    set()
    if (typeof ResizeObserver === 'undefined') return
    ro.current = new ResizeObserver(set)
    ro.current.observe(el)
  }, [])
  useEffect(() => () => ro.current?.disconnect(), [])
  return [ref, w]
}

export function useMedia(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  const [m, setM] = useState(get)
  useEffect(() => {
    if (!window.matchMedia) return undefined
    const mq = window.matchMedia(query)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [query])
  return m
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** copy(text) -> true when it landed on the clipboard; `copied` flips on for 1.6s. */
export function useCopy() {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  const copy = useCallback(async (text) => {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        ta.remove()
      } catch {
        ok = false
      }
    }
    if (ok) {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    }
    return ok
  }, [])
  return [copy, copied]
}

export function useTitle(title) {
  useEffect(() => {
    if (!title) return
    const prev = document.title
    document.title = `${title} | Propify`
    return () => {
      document.title = prev
    }
  }, [title])
}

/** Re-render every `ms` (for countdowns and "updated 2 min ago"). */
export function useTick(ms = 30_000) {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

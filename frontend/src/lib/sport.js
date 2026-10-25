// The league on screen, as hooks: the path's league, or for pages that belong to no league the
// one you came from. Everything without React is in leagues.js (and re-exported here).
import { useEffect, useSyncExternalStore } from 'react'
import { useLocation } from 'react-router-dom'
import { isSport, isSharedPath } from './leagues.js'

export * from './leagues.js'

// Pages that belong to no league (picks, tools, account) keep the league you came from, so the
// header, the tools and the search stay on it. Switching leagues there changes only that.
const KEY = 'apex.league'
let remembered = null
const subs = new Set()
function lastLeague() {
  if (remembered) return remembered
  try {
    const v = sessionStorage.getItem(KEY)
    if (isSport(v)) remembered = v
  } catch {
    /* storage can be off */
  }
  return remembered || 'nfl'
}
/** Make `s` the league for pages that belong to no league. */
export function setLeague(s) {
  if (!isSport(s) || lastLeague() === s) return
  remembered = s
  try {
    sessionStorage.setItem(KEY, s)
  } catch {
    /* storage can be off */
  }
  for (const fn of subs) fn()
}
const onLeague = (fn) => {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** The sport a path belongs to: its first segment when that's a league, the league you were on for shared pages, else NFL. */
export function sportFromPath(pathname = '/') {
  const path = String(pathname)
  const first = path.split('/')[1] || ''
  if (isSport(first)) return first
  if (isSharedPath(path)) return lastLeague()
  return 'nfl'
}

/** The league on screen. */
export function useSport() {
  const { pathname } = useLocation()
  const last = useSyncExternalStore(onLeague, lastLeague, () => 'nfl')
  const first = pathname.split('/')[1] || ''
  const shared = isSharedPath(pathname)
  const s = isSport(first) ? first : shared ? last : 'nfl'
  useEffect(() => {
    if (!shared) setLeague(s)
  }, [shared, s])
  return s
}


// The games you're watching, kept in this browser. They drive the board's "My games" filter and
// the home page list.
import { useSyncExternalStore } from 'react'

const KEY = 'apex_watch'
const MAX = 16

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => /^\d{6,12}$/.test(String(x))).map(String).slice(0, MAX) : []
  } catch {
    return []
  }
}

let ids = load()
const subs = new Set()

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    /* private mode: kept for this visit */
  }
  for (const fn of subs) fn()
}

export const getWatch = () => ids
export function onWatch(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}
export const isWatched = (id) => ids.includes(String(id))
export function toggleWatch(id) {
  const k = String(id)
  ids = ids.includes(k) ? ids.filter((x) => x !== k) : [k, ...ids].slice(0, MAX)
  save()
}
export function useWatch() {
  return useSyncExternalStore(onWatch, getWatch, getWatch)
}

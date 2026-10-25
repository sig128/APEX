// A small stale-while-revalidate store for GET requests: every component asking for the same
// path shares one request and one copy, cached data shows instantly while it refreshes, and
// live updates can patch it in place (mutate).
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api } from './api.js'

const entries = new Map() // path -> { data, error, at, promise, subs: Set }

function entry(path) {
  let e = entries.get(path)
  if (!e) {
    e = { data: undefined, error: null, at: 0, promise: null, subs: new Set(), v: 0 }
    entries.set(path, e)
  }
  return e
}

function notify(e) {
  e.v++
  for (const fn of e.subs) fn()
}

export function load(path, { force = false } = {}) {
  const e = entry(path)
  if (e.promise && !force) return e.promise
  const p = api(path)
    .then((data) => {
      e.data = data
      e.error = null
      e.at = Date.now()
      return data
    })
    .catch((err) => {
      e.error = err
      throw err
    })
    .finally(() => {
      if (e.promise === p) e.promise = null
      notify(e)
    })
  e.promise = p
  notify(e)
  return p
}

/** Replace or patch cached data (fn gets the current value). */
export function mutate(path, fn) {
  const e = entry(path)
  const next = typeof fn === 'function' ? fn(e.data) : fn
  if (next === undefined) return // nothing cached yet: let the next reader fetch it
  e.data = next
  e.at = Date.now()
  notify(e)
}

export function peek(path) {
  return entries.get(path)?.data
}

export function invalidate(prefix) {
  for (const [k, e] of entries) {
    if (k.startsWith(prefix)) {
      e.at = 0
      if (e.subs.size) load(k).catch(() => {})
    }
  }
}

/**
 * const { data, error, loading, refresh } = useApi('/api/nfl/home', { maxAgeMs: 15000, pollMs })
 * path null = don't fetch.
 */
export function useApi(path, { maxAgeMs = 15_000, pollMs = 0 } = {}) {
  const subscribe = useCallback(
    (cb) => {
      if (!path) return () => {}
      const e = entry(path)
      e.subs.add(cb)
      return () => e.subs.delete(cb)
    },
    [path],
  )
  const snap = useSyncExternalStore(subscribe, () => (path ? entry(path).v : 0))
  void snap
  const e = path ? entry(path) : null

  useEffect(() => {
    if (!path) return
    const cur = entry(path)
    if (!cur.promise && Date.now() - cur.at > maxAgeMs) load(path).catch(() => {})
    const onFocus = () => {
      if (document.visibilityState === 'visible' && Date.now() - entry(path).at > maxAgeMs) load(path).catch(() => {})
    }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    let timer = null
    if (pollMs > 0) {
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') load(path).catch(() => {})
      }, pollMs)
    }
    return () => {
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
      if (timer) clearInterval(timer)
    }
  }, [path, maxAgeMs, pollMs])

  return {
    data: e?.data,
    error: e?.data === undefined ? e?.error : null,
    staleError: e?.error || null,
    loading: Boolean(e && e.data === undefined && !e.error),
    refreshing: Boolean(e?.promise),
    refresh: useCallback(() => (path ? load(path, { force: true }) : Promise.resolve()), [path]),
  }
}

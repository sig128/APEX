// One live connection for the whole tab. Components subscribe to topics (scoreboard, tracker,
// game:<id>); the manager keeps a single EventSource open with the union of topics, reconnects
// with backoff, and falls back to polling when streaming isn't getting through (some proxies
// buffer event streams). Updates go to listeners and, for known topics, into the data cache.
import { useEffect, useRef, useState } from 'react'
import { streamUrl } from './config.js'
import { api } from './api.js'
import { mutate, load, peek } from './useApi.js'

const listeners = new Map() // topic -> Set<fn>
let es = null
let openTopics = ''
let state = 'idle' // idle | connecting | live | polling
let retry = 0
let helloTimer = null
let pollTimer = null
let reopenTimer = null
let ticket = null
const stateSubs = new Set()

function setState(s) {
  if (state === s) return
  state = s
  for (const fn of stateSubs) fn(s)
}

const wanted = () => [...listeners.keys()].filter((t) => listeners.get(t).size).sort().slice(0, 12)

const withScores = (g, live) => (g && live ? { ...g, status: live.status, situation: live.situation ?? g.situation, home: { ...g.home, score: live.home?.score ?? g.home?.score }, away: { ...g.away, score: live.away?.score ?? g.away?.score } } : g)

function deliver(topic, data) {
  if (topic === 'scoreboard' && data?.games) {
    const before = peek('/api/nfl/week')?.games || []
    mutate('/api/nfl/week', data)
    mutate('/api/nfl/home', (cur) => (cur ? { ...cur, games: data.games } : undefined))
    // a game that just kicked off or ended: its page (and the board) need a fresh read
    for (const g of data.games) {
      const old = before.find((x) => x.id === g.id)
      if (old && old.status?.state !== g.status?.state) {
        if (peek(`/api/nfl/games/${g.id}`)) load(`/api/nfl/games/${g.id}`, { force: true }).catch(() => {})
        if (peek('/api/nfl/home')) load('/api/nfl/home', { force: true }).catch(() => {})
        if (peek('/api/nfl/live')) load('/api/nfl/live', { force: true }).catch(() => {})
      }
    }
  }
  if (topic.startsWith('game:') && data) {
    const id = topic.slice(5)
    mutate(`/api/nfl/games/${id}`, (cur) => (cur ? { ...cur, live: data, game: withScores(cur.game, data) } : undefined))
    mutate('/api/nfl/live', (cur) => (cur ? { ...cur, games: cur.games.some((g) => g.id === id) ? cur.games.map((g) => (g.id === id ? data : g)) : [...cur.games, data] } : undefined))
    mutate('/api/nfl/week', (cur) => (cur ? { ...cur, games: cur.games.map((g) => (g.id === id ? withScores(g, data) : g)) } : undefined))
  }
  if (topic.startsWith('props:')) load(`/api/nfl/games/${topic.slice(6)}`).catch(() => {})
  for (const fn of listeners.get(topic) || []) {
    try {
      fn(data)
    } catch {
      /* a listener's problem */
    }
  }
}

async function getTicket() {
  try {
    const t = await api('/api/nfl/ticket')
    ticket = t?.required ? t.ticket : null
  } catch {
    ticket = null
  }
}

function close() {
  if (es) {
    es.onmessage = es.onerror = null
    es.close()
    es = null
  }
  clearTimeout(helloTimer)
}

function startPolling() {
  setState('polling')
  clearInterval(pollTimer)
  const tick = async () => {
    if (document.visibilityState !== 'visible') return
    const topics = wanted()
    if (topics.includes('scoreboard')) api('/api/nfl/week').then((d) => deliver('scoreboard', d), () => {})
    for (const t of topics.filter((x) => x.startsWith('game:'))) load(`/api/nfl/games/${t.slice(5)}`, { force: true }).then((d) => d?.live && deliver(t, d.live), () => {})
    if (topics.includes('tracker')) load('/api/nfl/live', { force: true }).then((d) => d?.games?.forEach((g) => deliver(`game:${g.id}`, g)), () => {})
  }
  tick()
  pollTimer = setInterval(tick, 12_000)
  // keep trying the stream now and then
  clearTimeout(reopenTimer)
  reopenTimer = setTimeout(() => open(true), 120_000)
}

async function open(force = false) {
  const topics = wanted()
  const key = topics.join(',')
  if (!topics.length) {
    close()
    clearInterval(pollTimer)
    setState('idle')
    openTopics = ''
    return
  }
  if (!force && key === openTopics && es) return
  close()
  openTopics = key
  if (typeof EventSource === 'undefined') return startPolling()
  if (ticket === null && retry === 0) await getTicket()
  setState('connecting')
  const url = streamUrl(`/api/nfl/stream?topics=${encodeURIComponent(key)}${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ''}`)
  const src = new EventSource(url)
  es = src
  helloTimer = setTimeout(() => {
    if (es === src && state !== 'live') {
      close()
      startPolling()
    }
  }, 7000)
  src.addEventListener('hello', () => {
    retry = 0
    clearTimeout(helloTimer)
    clearInterval(pollTimer)
    setState('live')
  })
  src.addEventListener('update', (ev) => {
    try {
      const { topic, data } = JSON.parse(ev.data)
      deliver(topic, data)
    } catch {
      /* bad frame */
    }
  })
  src.addEventListener('bye', () => open(true))
  src.onerror = () => {
    if (es !== src) return
    close()
    retry++
    if (retry > 4) return startPolling()
    setState('connecting')
    clearTimeout(reopenTimer)
    reopenTimer = setTimeout(() => {
      ticket = null
      open(true)
    }, Math.min(30_000, 1000 * 2 ** retry))
  }
}

let scheduled = false
function reconcile() {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    open()
  })
}

export function subscribe(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set())
  listeners.get(topic).add(fn)
  reconcile()
  return () => {
    listeners.get(topic)?.delete(fn)
    reconcile()
  }
}

/** useLive('game:401873020', (data) => ...) while the component is mounted. */
export function useLive(topic, fn) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!topic) return
    return subscribe(topic, (d) => ref.current?.(d))
  }, [topic])
}

export function useLiveState() {
  const [s, setS] = useState(state)
  useEffect(() => {
    stateSubs.add(setS)
    return () => stateSubs.delete(setS)
  }, [])
  return s
}

// A tab in the background lets go of the stream after half a minute (an open stream is billed
// server time) and picks it back up, with fresh data, when it's looked at again.
let hiddenTimer = null
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(hiddenTimer)
      hiddenTimer = setTimeout(() => {
        close()
        clearInterval(pollTimer)
        openTopics = ''
        setState('idle')
      }, 30_000)
      return
    }
    clearTimeout(hiddenTimer)
    if (wanted().length && !es && state !== 'polling') {
      for (const t of wanted()) {
        if (t === 'scoreboard') load('/api/nfl/week', { force: true }).catch(() => {})
        if (t.startsWith('game:')) load(`/api/nfl/games/${t.slice(5)}`, { force: true }).catch(() => {})
      }
      open(true)
    }
  })
}

// One live connection for the whole tab. Components subscribe to topics (scoreboard, tracker,
// game:<id>) of a sport; the manager keeps a single EventSource open for the sport on screen with
// the union of its topics, reconnects with backoff, and falls back to polling when streaming
// isn't getting through (some proxies buffer event streams). Updates go to listeners and, for
// known topics, into the data cache. Listener keys are "<sport>|<topic>".
import { useEffect, useRef, useState } from 'react'
import { streamUrl } from './config.js'
import { api } from './api.js'
import { mutate, load, peek } from './useApi.js'
import { useLocation } from 'react-router-dom'
import { sportFromPath } from './sport.js'

const listeners = new Map() // "<sport>|<topic>" -> Set<fn>
let es = null
let esSport = 'nfl'
let lastSport = 'nfl'
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

const live = () => [...listeners.keys()].filter((t) => listeners.get(t).size)
/** The sport whose topics get the stream: the one subscribed to most recently. */
const activeSport = () => {
  const sports = new Set(live().map((k) => k.split('|')[0]))
  return sports.has(lastSport) ? lastSport : [...sports][0] || lastSport
}
const wanted = (sport = activeSport()) =>
  live()
    .filter((k) => k.startsWith(`${sport}|`))
    .map((k) => k.slice(sport.length + 1))
    .sort()
    .slice(0, 12)

const withScores = (g, live) => (g && live ? { ...g, status: live.status, situation: live.situation ?? g.situation, home: { ...g.home, score: live.home?.score ?? g.home?.score }, away: { ...g.away, score: live.away?.score ?? g.away?.score } } : g)

function deliver(topic, data, sport = esSport) {
  const A = `/api/${sport}`
  if (topic === 'scoreboard' && data?.games) {
    const before = peek(`${A}/week`)?.games || []
    mutate(`${A}/week`, data)
    mutate(`${A}/home`, (cur) => (cur ? { ...cur, games: data.games } : undefined))
    // a game that just kicked off or ended: its page (and the board) need a fresh read
    for (const g of data.games) {
      const old = before.find((x) => x.id === g.id)
      if (old && old.status?.state !== g.status?.state) {
        if (peek(`${A}/games/${g.id}`)) load(`${A}/games/${g.id}`, { force: true }).catch(() => {})
        if (peek(`${A}/home`)) load(`${A}/home`, { force: true }).catch(() => {})
        if (peek(`${A}/live`)) load(`${A}/live`, { force: true }).catch(() => {})
      }
    }
  }
  if (topic.startsWith('game:') && data) {
    const id = topic.slice(5)
    mutate(`${A}/games/${id}`, (cur) => (cur ? { ...cur, live: data, game: withScores(cur.game, data) } : undefined))
    mutate(`${A}/live`, (cur) => (cur ? { ...cur, games: cur.games.some((g) => g.id === id) ? cur.games.map((g) => (g.id === id ? data : g)) : [...cur.games, data] } : undefined))
    mutate(`${A}/week`, (cur) => (cur ? { ...cur, games: cur.games.map((g) => (g.id === id ? withScores(g, data) : g)) } : undefined))
  }
  if (topic.startsWith('props:')) load(`${A}/games/${topic.slice(6)}`).catch(() => {})
  for (const fn of listeners.get(`${sport}|${topic}`) || []) {
    try {
      fn(data)
    } catch {
      /* a listener's problem */
    }
  }
}

async function getTicket() {
  try {
    const t = await api(`/api/${activeSport()}/ticket`)
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
    const sport = activeSport()
    const A = `/api/${sport}`
    const topics = wanted(sport)
    if (topics.includes('scoreboard')) api(`${A}/week`).then((d) => deliver('scoreboard', d, sport), () => {})
    for (const t of topics.filter((x) => x.startsWith('game:'))) load(`${A}/games/${t.slice(5)}`, { force: true }).then((d) => d?.live && deliver(t, d.live, sport), () => {})
    if (topics.includes('tracker')) load(`${A}/live`, { force: true }).then((d) => d?.games?.forEach((g) => deliver(`game:${g.id}`, g, sport)), () => {})
  }
  tick()
  pollTimer = setInterval(tick, 12_000)
  // keep trying the stream now and then
  clearTimeout(reopenTimer)
  reopenTimer = setTimeout(() => open(true), 120_000)
}

async function open(force = false) {
  const sport = activeSport()
  const topics = wanted(sport)
  const key = `${sport}|${topics.join(',')}`
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
  esSport = sport
  if (typeof EventSource === 'undefined') return startPolling()
  if (ticket === null && retry === 0) await getTicket()
  setState('connecting')
  const url = streamUrl(`/api/${sport}/stream?topics=${encodeURIComponent(topics.join(','))}${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ''}`)
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
      deliver(topic, data, sport)
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

export function subscribe(topic, fn, sport = 'nfl') {
  const key = `${sport}|${topic}`
  lastSport = sport
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key).add(fn)
  reconcile()
  return () => {
    listeners.get(key)?.delete(fn)
    reconcile()
  }
}

/** useLive('game:401873020', (data) => ...) while the component is mounted; the sport is the page's. */
export function useLive(topic, fn, sportIn) {
  const here = sportFromPath(useLocation().pathname)
  const sport = sportIn || here
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!topic) return
    return subscribe(topic, (d) => ref.current?.(d), sport)
  }, [topic, sport])
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
      const A = `/api/${activeSport()}`
      for (const t of wanted()) {
        if (t === 'scoreboard') load(`${A}/week`, { force: true }).catch(() => {})
        if (t.startsWith('game:')) load(`${A}/games/${t.slice(5)}`, { force: true }).catch(() => {})
      }
      open(true)
    }
  })
}

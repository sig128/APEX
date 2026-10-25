// Server-Sent Events hub. Topics: scoreboard, tracker, status, game:<id>, props:<id>.
import { log } from './log.js'

export function createHub({ maxBuffer = 1 << 20, heartbeatMs = 20_000, maxClients = 300, maxPerOwner = 6 } = {}) {
  const topics = new Map() // topic -> Set<client>
  const clients = new Set()
  const owners = new Map() // owner (caller address) -> open streams
  let nextId = 1
  const counters = { connects: 0, drops: 0, frames: 0, refused: 0 }

  function subscribe(client, list) {
    for (const t of list) {
      let set = topics.get(t)
      if (!set) {
        set = new Set()
        topics.set(t, set)
      }
      set.add(client)
    }
  }

  function unsubscribe(client) {
    for (const t of client.topics) {
      const set = topics.get(t)
      if (!set) continue
      set.delete(client)
      if (!set.size) topics.delete(t)
    }
  }

  function write(client, frame) {
    if (client.closed) return
    if (client.res.writableLength > maxBuffer) {
      counters.drops++
      client.close('slow')
      return
    }
    try {
      client.res.write(frame)
    } catch {
      client.close('error')
    }
  }

  /** Serialize once, write to every subscriber of the topic. */
  function publish(topic, event, data) {
    const set = topics.get(topic)
    if (!set || !set.size) return 0
    const frame = `event: ${event}\ndata: ${JSON.stringify({ topic, data })}\n\n`
    counters.frames++
    for (const c of [...set]) write(c, frame)
    return set.size
  }

  function hasSubscribers(topic) {
    const set = topics.get(topic)
    return Boolean(set && set.size)
  }

  /**
   * Express-style handler. list: topics to subscribe. initial(topic) may return data to send
   * right away so a fresh tab doesn't wait for the next change.
   */
  function stream(req, res, { list, initial, maxDurationMs = 30 * 60_000, owner = null } = {}) {
    // Streams hold a connection for up to half an hour, so they're capped: per caller (a few
    // tabs) and per instance (room left for ordinary requests). Callers past a cap get null and
    // fall back to polling.
    if (clients.size >= maxClients || (owner && (owners.get(owner) || 0) >= maxPerOwner)) {
      counters.refused++
      return null
    }
    const client = { id: nextId++, res, topics: list, closed: false, timers: [], owner }
    clients.add(client)
    if (owner) owners.set(owner, (owners.get(owner) || 0) + 1)
    client.close = (reason) => {
      if (client.closed) return
      client.closed = true
      clients.delete(client)
      if (owner) {
        const n = (owners.get(owner) || 1) - 1
        if (n > 0) owners.set(owner, n)
        else owners.delete(owner)
      }
      client.timers.forEach((t) => clearInterval(t))
      unsubscribe(client)
      try {
        if (reason === 'expired') res.write('event: bye\ndata: {}\n\n')
        res.end()
      } catch {
        /* already gone */
      }
      if (reason === 'slow') log.warn('sse client dropped (slow)', { id: client.id })
    }
    // Listeners first, then subscribe, so a client that disconnects instantly never leaks.
    req.on('close', () => client.close('closed'))
    res.on('error', () => client.close('error'))

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ topics: list, at: Date.now() })}\n\n`)
    counters.connects++
    subscribe(client, list)
    if (typeof initial === 'function') {
      for (const t of list) {
        try {
          const d = initial(t)
          if (d !== undefined && d !== null) write(client, `event: update\ndata: ${JSON.stringify({ topic: t, data: d })}\n\n`)
        } catch {
          /* best effort */
        }
      }
    }
    client.timers.push(setInterval(() => write(client, `: ping ${Date.now()}\n\n`), heartbeatMs))
    const expire = setTimeout(() => client.close('expired'), maxDurationMs)
    client.timers.push(expire)
    if (typeof expire.unref === 'function') expire.unref()
    return client
  }

  return {
    publish,
    stream,
    hasSubscribers,
    stats: () => ({ ...counters, clients: clients.size, owners: owners.size, topics: topics.size }),
    topics: () => [...topics.keys()],
  }
}

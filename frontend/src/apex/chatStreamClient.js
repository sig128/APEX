import { getChatStreamUrl } from './apiConfig.js'
import { authHeaders } from '../lib/api.js'
import { formatUserFacingError } from './humanReadableError.js'

/**
 * Consumes NDJSON from POST /api/chat/stream (same JSON body as /api/chat).
 * @param {object} body - { game } or { messages }
 * @param {{ onEvent?: (ev: object) => void }} [handlers]
 */
export async function postChatStream(body, handlers) {
  const url = getChatStreamUrl()

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch (e) {
    throw mapStreamNetworkError(e)
  }

  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    const raw = j.error ?? j.message ?? j
    const human =
      formatUserFacingError(raw) ||
      (res.status ? `Request failed (HTTP ${res.status}). Try again.` : 'Request failed. Try again.')
    throw new Error(human)
  }

  const reader = res.body?.getReader()
  if (!reader) {
    throw new Error('No response from server. Check your connection and try again.')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let complete = null
  /** True if we got any NDJSON event before a terminal `complete` (helps explain partial failures). */
  let sawStreamActivity = false

  function processLine(line) {
    if (!line.trim()) return
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    sawStreamActivity = true
    handlers?.onEvent?.(ev)
    if (ev.type === 'complete') complete = ev
    if (ev.type === 'error') {
      throw new Error(formatUserFacingError(ev.error) || 'Request failed. Try again.')
    }
    if (ev.type === 'stream_error') {
      throw new Error(formatUserFacingError(ev.error) || 'Stream failed. Try again.')
    }
  }

  while (true) {
    let done
    let value
    try {
      ;({ done, value } = await reader.read())
    } catch (e) {
      throw mapStreamNetworkError(e)
    }
    if (value) buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      processLine(line)
    }
    if (done) break
  }

  if (buffer.trim()) {
    processLine(buffer)
  }

  if (!complete?.messages) {
    // (a cut-off on Firebase Hosting usually means VITE_API_BASE isn't set: see apiConfig.js)
    throw new Error(
      sawStreamActivity
        ? 'The analysis was cut off before it finished. Try again.'
        : 'No answer came back from the analyzer. Try again in a moment.',
    )
  }

  return complete
}

function mapStreamNetworkError(e) {
  const msg = e?.message || String(e)
  if (
    msg === 'Failed to fetch' ||
    msg.includes('NetworkError') ||
    msg.includes('Load failed') ||
    msg.includes('network') ||
    (typeof e?.name === 'string' && e.name === 'TypeError' && msg.includes('fetch'))
  ) {
    return new Error('The connection dropped before the analysis finished. Check your connection and try again.')
  }
  return e instanceof Error ? e : new Error(msg)
}

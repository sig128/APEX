import { getChatStreamUrl } from './apiConfig.js'
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
      headers: { 'Content-Type': 'application/json' },
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
    const hostingHint =
      'On Firebase Hosting, long runs need VITE_API_BASE set to your Cloud Function URL in frontend/.env.production, then rebuild and redeploy — otherwise the connection can stop around 60 seconds.'
    const timeoutHint =
      'If this happened after a long wait, the server or proxy may have hit a time limit. Redeploy Cloud Functions if you raised the timeout; local npm run dev does not use that cap.'
    throw new Error(
      sawStreamActivity
        ? `The reply was cut off before it finished (connection closed mid-stream). ${timeoutHint} ${hostingHint}`
        : `No reply was received from the AI. ${hostingHint}`,
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
    return new Error(
      'Connection failed or was reset (often a timeout or blocked network). On Firebase Hosting, set VITE_API_BASE to your Cloud Function URL, rebuild, and redeploy, or long ANALYZE runs can stop around 60 seconds. Try a private window or disable browser extensions if this keeps happening.',
    )
  }
  return e instanceof Error ? e : new Error(msg)
}

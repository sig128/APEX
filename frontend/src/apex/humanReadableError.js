/**
 * Turns AI service, API and network errors into short, user-facing sentences (no raw JSON).
 * @param {unknown} err
 * @returns {string}
 */
export function formatUserFacingError(err) {
  if (err == null || err === '') return 'Something went wrong. Try again.'

  if (typeof err === 'string') {
    const t = err.trim()
    if (!t) return 'Something went wrong. Try again.'
    if (t.startsWith('{') || t.startsWith('[')) {
      const parsed = tryParseJson(t)
      if (parsed) {
        const out = formatFromParsedPayload(parsed)
        if (out) return out
      }
    }
    return mapKnownPhrases(t) || t
  }

  if (err instanceof Error) {
    return formatUserFacingError(err.message)
  }

  if (typeof err === 'object') {
    const o = /** @type {Record<string, unknown>} */ (err)
    const out = formatFromParsedPayload(o)
    if (out) return out
    if (typeof o.message === 'string') return formatUserFacingError(o.message)
    if (Object.keys(o).length === 0) return 'Something went wrong. Try again.'
  }

  return mapKnownPhrases(String(err)) || String(err)
}

/**
 * Short, safe copy when The Odds API / schedule requests fail (carousels, Today, team search).
 * Never surfaces API keys, env paths, or Firebase CLI hints.
 * @param {unknown} raw
 * @returns {string}
 */
export function humanizeOddsScheduleError(raw) {
  const s =
    typeof raw === 'string'
      ? raw.trim()
      : raw instanceof Error
        ? String(raw.message || '').trim()
        : ''
  if (!s) return "Couldn't load games. Try again in a moment."
  const lower = s.toLowerCase()
  if (
    lower.includes('the_odds_api_key') ||
    lower.includes('odds_api_key') ||
    lower.includes('firebase') ||
    lower.includes('functions:secrets') ||
    lower.includes('backend/.env') ||
    lower.includes('cloud function') ||
    lower.includes('redeploy') ||
    lower.includes('could not load schedules') ||
    (lower.includes('api') && lower.includes('not set'))
  ) {
    return "Schedules aren't available right now. Try again in a few minutes."
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return 'Too many requests right now. Try again in a minute.'
  }
  if (lower.includes('503') || lower.includes('service unavailable')) {
    return "Schedules aren't available right now. Try again in a few minutes."
  }
  if (lower.includes('502') || lower.includes('bad gateway')) {
    return "Schedules aren't available right now. Try again in a few minutes."
  }
  if (lower.includes('network') || lower.includes('failed to fetch')) {
    return 'Check your connection and try again.'
  }
  if (lower.includes('request failed')) {
    return "Couldn't load games. Try again in a moment."
  }
  if (s.length > 100 || /^[\s{[]/.test(s)) {
    return "Couldn't load games. Try again in a moment."
  }
  return "Couldn't load games. Try again in a moment."
}

/** @param {string} s */
function tryParseJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * @param {unknown} payload
 * @returns {string | null}
 */
function formatFromParsedPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (payload)

  // AI SSE/JSON: { type: "error", error: { type, message } }
  if (o.type === 'error' && o.error && typeof o.error === 'object') {
    const inner = /** @type {Record<string, unknown>} */ (o.error)
    const line = mapAiErrorType(
      typeof inner.type === 'string' ? inner.type : '',
      typeof inner.message === 'string' ? inner.message : '',
    )
    if (line) return line
  }

  // { error: "string" }
  if (typeof o.error === 'string') {
    return formatUserFacingError(o.error)
  }

  // { error: { type, message } }
  if (o.error && typeof o.error === 'object') {
    const inner = /** @type {Record<string, unknown>} */ (o.error)
    const line = mapAiErrorType(
      typeof inner.type === 'string' ? inner.type : '',
      typeof inner.message === 'string' ? inner.message : '',
    )
    if (line) return line
    if (typeof inner.message === 'string') return formatUserFacingError(inner.message)
  }

  if (typeof o.type === 'string' && typeof o.message === 'string') {
    const line = mapAiErrorType(o.type, o.message)
    if (line) return line
  }

  return null
}

/**
 * @param {string} type
 * @param {string} message
 */
function mapAiErrorType(type, message) {
  const msg = (message || '').trim()
  switch (type) {
    case 'overloaded_error':
    case 'server_error':
      return 'The AI is busy right now. Wait a moment and try again.'
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
      return 'Too many requests right now. Wait a minute and try again.'
    case 'authentication_error':
    case 'invalid_api_key':
      return 'The AI key was refused or is missing. Check OPENAI_API_KEY on the server.'
    case 'billing_error':
    case 'insufficient_quota':
      return 'The AI account is out of credit or over its quota. Check its plan and billing.'
    case 'permission_error':
      return 'This API key is not allowed to perform that action.'
    case 'not_found_error':
    case 'model_not_found':
      return 'That AI model is not available. Check OPENAI_MODEL if you set one.'
    case 'invalid_request_error':
      return msg ? `Invalid request: ${msg}` : 'The request was invalid. Check inputs and try again.'
    case 'api_error':
      return msg ? `AI service error: ${msg}` : 'The AI service returned an error. Try again in a moment.'
    case 'request_too_large':
      return 'Request or context is too large. Shorten the conversation or game details and try again.'
    default:
      break
  }
  if (msg && msg !== 'Overloaded') return msg
  if (type && type.endsWith('_error')) {
    const short = type.replace(/_error$/, '').replace(/_/g, ' ')
    return `AI service reported an error (${short}). Try again.`
  }
  return msg || null
}

/** @param {string} raw */
function mapKnownPhrases(raw) {
  const lower = raw.toLowerCase()
  if (lower.includes('overloaded')) {
    return 'The AI is busy right now. Wait a moment and try again.'
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'Too many requests right now. Wait a minute and try again.'
  }
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return 'The AI key was refused or is missing. Check OPENAI_API_KEY on the server.'
  }
  if (lower.includes('503') && lower.includes('service unavailable')) {
    return 'The AI service is temporarily unavailable. Try again shortly.'
  }
  if (lower.includes('popup-closed-by-user')) {
    return 'Sign-in was cancelled.'
  }
  if (lower.includes('auth/network-request-failed') || lower.includes('network-request-failed')) {
    return 'Network error during sign-in. Check your connection and try again.'
  }
  if (lower.includes('auth/too-many-requests')) {
    return 'Too many sign-in attempts. Wait a few minutes and try again.'
  }
  if (lower.includes('auth/user-disabled')) {
    return 'This account is disabled.'
  }
  return null
}

/**
 * Maps the AI's stop_reason values to short UI labels (status line, not an error).
 * @param {string | null | undefined} sr
 * @returns {string}
 */
export function formatStopReasonForUi(sr) {
  if (!sr) return 'Finished'
  switch (sr) {
    case 'end_turn':
      return 'Finished'
    case 'max_tokens':
      return 'Stopped at output limit'
    case 'tool_use':
      return 'Finished (tool use)'
    case 'stop_sequence':
      return 'Finished'
    default:
      return sr.replace(/_/g, ' ')
  }
}

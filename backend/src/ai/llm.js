// The AI behind the prop reads, the parlay check, game intel and the analyzer, on OpenAI
// (OPENAI_API_KEY, used whenever it's set) or Anthropic (ANTHROPIC_API_KEY). One small interface
// for both, so the features don't care which one answers:
//
//   const ai = createAi()                    // keys from the environment (or pass getters)
//   ai.ready() / ai.provider() / ai.model('insight')
//   await ai.stream({ feature, system, messages, maxTokens, webSearch, onText, onActivity, signal })
//   await ai.complete({ feature, system, messages, maxTokens, webSearch, signal })
//     -> { text, stop, id, usage, model, citations }
//
// messages: [{ role: 'user' | 'assistant', content: string | Part[] }], where a Part is
// { type: 'text', text } or { type: 'image', mediaType, data } (base64). webSearch: { maxUses,
// domains } or a falsy value. stop is 'end_turn', 'max_tokens', 'refusal' or null.
//
// OpenAI goes through its Responses API with plain fetch (no SDK). Settings, all optional:
//   OPENAI_MODEL (default gpt-6-sol), OPENAI_INSIGHT_MODEL, OPENAI_PARLAY_MODEL, OPENAI_INTEL_MODEL
//   OPENAI_REASONING_EFFORT (default low; "off" sends none), OPENAI_REASONING_TOKENS (room left
//   for the model's thinking on top of each answer's length, default 4000)
//   APEX_AI_PROVIDER=anthropic to prefer Anthropic while both keys are set.
import Anthropic from '@anthropic-ai/sdk'

export const OPENAI_URL = 'https://api.openai.com/v1/responses'
const DEFAULTS = { openai: 'gpt-6-sol', anthropic: 'claude-sonnet-5-5' }
const FEATURE_ENV = { insight: 'INSIGHT', parlay: 'PARLAY', intel: 'INTEL' }

/** The model a feature uses on a provider: the feature's own setting, the general one, the default. */
export function modelFor(provider, feature, env = process.env) {
  const p = provider === 'openai' ? 'OPENAI' : 'ANTHROPIC'
  const f = FEATURE_ENV[feature]
  return (f && env[`${p}_${f}_MODEL`]) || env[`${p}_MODEL`] || DEFAULTS[provider] || DEFAULTS.openai
}

/** The analyzer's web search: on unless switched off, a few searches per answer. */
export function chatWebSearch(env = process.env) {
  const off = (v) => v === '0' || String(v).toLowerCase() === 'false'
  if (off(env.APEX_WEB_SEARCH) || off(env.ANTHROPIC_WEB_SEARCH)) return null
  const n = parseInt(env.APEX_WEB_SEARCH_MAX_USES || env.ANTHROPIC_WEB_SEARCH_MAX_USES || '5', 10) || 5
  return { maxUses: Math.min(Math.max(n, 1), 20) }
}

/** Never hand an API key, even a masked one, back to a browser or a log. */
export function scrubKeys(text) {
  return String(text ?? '').replace(/\b(sk|rk|pk)-[A-Za-z0-9_*.-]{6,}/g, '[key]')
}

class AiError extends Error {
  constructor(message, { status = 0, code = '', param = '' } = {}) {
    super(scrubKeys(message))
    this.status = status
    this.code = code
    this.param = param
  }
}

// ---- OpenAI (Responses API) -------------------------------------------------------------------

function openaiInput(messages) {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    const content = m.content.map((p) =>
      p.type === 'image' ? { type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}` } : { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: p.text },
    )
    return { role: m.role, content }
  })
}

function openaiError(status, body) {
  let e = null
  try {
    e = JSON.parse(body)?.error || null
  } catch {
    /* not JSON */
  }
  const code = String(e?.code || e?.type || '')
  // plain words for the failures people can fix; the API's own text otherwise (keys scrubbed)
  const message =
    code === 'invalid_api_key' || status === 401
      ? 'The AI key was refused (check OPENAI_API_KEY).'
      : code === 'insufficient_quota'
        ? 'The OpenAI account is out of credit or over its quota.'
        : code === 'model_not_found'
          ? `That AI model isn't available on this OpenAI account (check OPENAI_MODEL).`
          : e?.message || `OpenAI answered HTTP ${status}`
  return new AiError(message, { status, code, param: String(e?.param || '') })
}

/** A model that doesn't take one of the optional settings gets asked again without it. */
function withoutRejected(err, req) {
  if (err.status !== 400) return null
  const what = `${err.param} ${err.message}`
  if (req.reasoning && /reasoning/i.test(what)) {
    const { reasoning, ...rest } = req
    return { ...rest, max_output_tokens: req.answerTokens ?? rest.max_output_tokens }
  }
  if ((req.tools || req.max_tool_calls) && /tool|web_search/i.test(what)) {
    const { tools, max_tool_calls, include, ...rest } = req
    return rest
  }
  return null
}

/** Server-sent events from a fetch body, one parsed JSON payload at a time. */
export async function* sseEvents(body) {
  const dec = new TextDecoder()
  let buf = ''
  const frames = function* (final) {
    let i
    while ((i = buf.indexOf('\n\n')) >= 0 || (final && buf.trim())) {
      const frame = i >= 0 ? buf.slice(0, i) : buf
      buf = i >= 0 ? buf.slice(i + 2) : ''
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data || data === '[DONE]') continue
      try {
        yield JSON.parse(data)
      } catch {
        /* a keep-alive or a partial line */
      }
    }
  }
  for await (const chunk of body) {
    buf = (buf + (typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true }))).replace(/\r\n/g, '\n')
    yield* frames(false)
  }
  buf += dec.decode()
  yield* frames(true)
}

function responseText(resp) {
  if (typeof resp?.output_text === 'string') return resp.output_text
  let s = ''
  for (const item of resp?.output || []) {
    if (item?.type !== 'message') continue
    for (const c of item.content || []) {
      if (c?.type === 'output_text' && typeof c.text === 'string') s += c.text
      else if (c?.type === 'refusal' && typeof c.refusal === 'string') s += c.refusal
    }
  }
  return s
}

function responseCitations(resp) {
  const out = []
  for (const item of resp?.output || []) {
    if (item?.type === 'web_search_call') for (const s of item.action?.sources || []) if (s?.url) out.push({ url: s.url, title: s.title || '' })
    if (item?.type !== 'message') continue
    for (const c of item.content || []) for (const a of c?.annotations || []) if (a?.type === 'url_citation' && a.url) out.push({ url: a.url, title: a.title || '' })
  }
  return out
}

function responseStop(resp) {
  if (resp?.status !== 'incomplete') {
    const refused = (resp?.output || []).some((i) => i?.type === 'message' && (i.content || []).some((c) => c?.type === 'refusal'))
    return refused ? 'refusal' : 'end_turn'
  }
  const why = resp.incomplete_details?.reason
  return why === 'max_output_tokens' ? 'max_tokens' : why === 'content_filter' ? 'refusal' : why || 'max_tokens'
}

function openaiAdapter(key, { fetchImpl, env }) {
  const effort = () => {
    const e = String(env.OPENAI_REASONING_EFFORT ?? 'low').trim().toLowerCase()
    return e && e !== 'off' ? e : null
  }
  function request({ model, system, messages, maxTokens, webSearch, stream }) {
    const e = effort()
    const room = e && e !== 'none' ? Math.max(0, parseInt(env.OPENAI_REASONING_TOKENS || '4000', 10) || 0) : 0
    const req = {
      model,
      input: openaiInput(messages),
      max_output_tokens: maxTokens + room,
      store: false,
      ...(system ? { instructions: system } : {}),
      ...(e ? { reasoning: { effort: e } } : {}),
      ...(stream ? { stream: true } : {}),
    }
    if (webSearch) {
      req.tools = [{ type: 'web_search', ...(webSearch.domains?.length ? { filters: { allowed_domains: webSearch.domains.slice(0, 100) } } : {}) }]
      if (webSearch.maxUses) req.max_tool_calls = webSearch.maxUses
      req.include = ['web_search_call.action.sources']
    }
    // what to fall back to if the model turns the reasoning setting down (not sent)
    Object.defineProperty(req, 'answerTokens', { value: maxTokens, enumerable: false })
    return req
  }
  async function post(req, { signal, timeoutMs }) {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    let body = req
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetchImpl(OPENAI_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(body),
        signal: sig,
      })
      if (res.ok) return res
      const err = openaiError(res.status, await res.text().catch(() => ''))
      const next = withoutRejected(err, body)
      if (!next) throw err
      body = next
    }
    throw new AiError('OpenAI kept refusing the request settings.')
  }
  const finish = (resp, streamed, model) => ({
    text: streamed || responseText(resp),
    stop: responseStop(resp),
    id: resp?.id || null,
    usage: resp?.usage ? { input_tokens: resp.usage.input_tokens ?? null, output_tokens: resp.usage.output_tokens ?? null } : null,
    model: resp?.model || model,
    citations: responseCitations(resp),
  })
  return {
    async complete({ model, system, messages, maxTokens, webSearch, signal }) {
      const res = await post(request({ model, system, messages, maxTokens, webSearch }), { signal, timeoutMs: webSearch ? 240_000 : 120_000 })
      const resp = await res.json()
      if (resp?.status === 'failed') throw new AiError(resp.error?.message || 'The AI answer failed.', { code: resp.error?.code })
      return finish(resp, '', model)
    },
    async stream({ model, system, messages, maxTokens, webSearch, onText, onActivity, signal }) {
      const res = await post(request({ model, system, messages, maxTokens, webSearch, stream: true }), { signal, timeoutMs: 280_000 })
      let text = ''
      let final = null
      for await (const ev of sseEvents(res.body)) {
        switch (ev?.type) {
          case 'response.output_text.delta':
          case 'response.refusal.delta':
            if (typeof ev.delta === 'string' && ev.delta) {
              text += ev.delta
              onText?.(ev.delta)
            }
            break
          case 'response.output_item.added':
            if (ev.item?.type === 'web_search_call') onActivity?.({ phase: 'web_search', detail: 'Web search…' })
            else if (ev.item?.type === 'message') onActivity?.({ phase: 'writing', detail: 'Writing analysis…' })
            break
          case 'response.output_item.done':
            if (ev.item?.type === 'web_search_call' && ev.item.action?.query) onActivity?.({ phase: 'web_search', detail: `Search query: ${ev.item.action.query}` })
            break
          case 'response.completed':
          case 'response.incomplete':
            final = ev.response || {}
            break
          case 'response.failed':
            throw new AiError(ev.response?.error?.message || 'The AI answer failed.', { code: ev.response?.error?.code })
          case 'error':
            throw new AiError(ev.message || ev.error?.message || 'The AI stream failed.', { code: ev.code || ev.error?.code })
          default:
        }
      }
      if (!final) throw new AiError('The AI stream ended before the answer finished.')
      return finish(final, text, model)
    },
  }
}

// ---- Anthropic (Messages API, through its SDK) ----------------------------------------------

function anthropicMessages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } } : { type: 'text', text: p.text })),
  }))
}

const anthropicTools = (webSearch) =>
  webSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: webSearch.maxUses || 5, ...(webSearch.domains?.length ? { allowed_domains: webSearch.domains } : {}) }] : null

function anthropicText(msg) {
  return (msg?.content || [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

function anthropicCitations(msg) {
  const out = []
  for (const b of msg?.content || []) {
    if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r?.url) out.push({ url: r.url, title: r.title || '' })
    if (b?.type === 'text' && Array.isArray(b.citations)) for (const c of b.citations) if (c?.url) out.push({ url: c.url, title: c.title || '' })
  }
  return out
}

function anthropicAdapter(key) {
  const client = () => new Anthropic({ apiKey: key })
  const params = ({ model, system, messages, maxTokens, webSearch }) => {
    const tools = anthropicTools(webSearch)
    return { model, max_tokens: maxTokens, system, messages: anthropicMessages(messages), ...(tools ? { tools } : {}) }
  }
  const finish = (msg, text, model) => ({ text: text || anthropicText(msg), stop: msg?.stop_reason ?? null, id: msg?.id || null, usage: msg?.usage || null, model, citations: anthropicCitations(msg) })
  return {
    async complete(opts) {
      const msg = await client().messages.create(params(opts), opts.signal ? { signal: opts.signal } : undefined)
      return finish(msg, '', opts.model)
    },
    async stream(opts) {
      const s = client().messages.stream(params(opts), opts.signal ? { signal: opts.signal } : undefined)
      let text = ''
      let lastQuery = ''
      s.on('text', (d) => {
        if (!d) return
        text += d
        opts.onText?.(d)
      })
      if (opts.onActivity) {
        s.on('streamEvent', (event) => {
          const b = event?.type === 'content_block_start' ? event.content_block : null
          if (b?.type === 'server_tool_use' && b.name === 'web_search') opts.onActivity({ phase: 'web_search', detail: 'Web search…' })
          else if (b?.type === 'web_search_tool_result') opts.onActivity({ phase: 'web_search', detail: 'Processing search results…' })
          else if (b?.type === 'text') opts.onActivity({ phase: 'writing', detail: 'Writing analysis…' })
        })
        s.on('inputJson', (_partial, input) => {
          const q = typeof input?.query === 'string' ? input.query : ''
          if (q && q !== lastQuery) {
            lastQuery = q
            opts.onActivity({ phase: 'web_search', detail: `Search query: ${q}` })
          }
        })
      }
      const final = await s.finalMessage()
      return finish(final, text, opts.model)
    },
  }
}

// ---- the shared front ---------------------------------------------------------------------------

/**
 * openaiKey / anthropicKey: getters (or strings). With both set OpenAI answers, unless
 * APEX_AI_PROVIDER=anthropic.
 */
export function createAi({ openaiKey = () => process.env.OPENAI_API_KEY, anthropicKey = () => process.env.ANTHROPIC_API_KEY, env = process.env, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const read = (g) => {
    try {
      const v = typeof g === 'function' ? g() : g
      return typeof v === 'string' ? v.trim() : ''
    } catch {
      return ''
    }
  }
  function pick() {
    const o = read(openaiKey)
    const a = read(anthropicKey)
    const want = String(env.APEX_AI_PROVIDER || '').toLowerCase()
    if (want === 'anthropic' && a) return { provider: 'anthropic', key: a }
    if (o) return { provider: 'openai', key: o }
    if (a) return { provider: 'anthropic', key: a }
    return null
  }
  const adapter = (p) => (p.provider === 'openai' ? openaiAdapter(p.key, { fetchImpl, env }) : anthropicAdapter(p.key))
  const run = (how) => async (opts) => {
    const p = pick()
    if (!p) throw new AiError('AI is not configured on this server (OPENAI_API_KEY).', { code: 'ai_off', status: 503 })
    const model = opts.model || modelFor(p.provider, opts.feature, env)
    try {
      return await adapter(p)[how]({ ...opts, model })
    } catch (e) {
      if (e instanceof AiError || e?.name === 'AbortError' || e?.name === 'TimeoutError') throw e
      throw new AiError(e?.message || String(e), { status: e?.status || 0, code: e?.error?.type || e?.code || '' })
    }
  }
  return {
    ready: () => Boolean(pick()),
    provider: () => pick()?.provider || null,
    model: (feature) => {
      const p = pick()
      return p ? modelFor(p.provider, feature, env) : null
    },
    stream: run('stream'),
    complete: run('complete'),
  }
}

/** A stand-in for routes and tests: answers nothing, says it's off. */
export const NO_AI = createAi({ openaiKey: null, anthropicKey: null })

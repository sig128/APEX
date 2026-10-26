// The AI layer: OpenAI whenever its key is set (Anthropic otherwise), the Responses API requests
// it sends, streamed answers, the fallbacks when a model turns a setting down, and keys that
// never leak into an error. Then a prop read and the analyzer end to end on OpenAI.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createAi, modelFor, chatWebSearch, scrubKeys, sseEvents, OPENAI_URL } from '../src/ai/llm.js'
import { createApexApp } from '../app.js'
import { createStore } from '../src/lib/store.js'
import { fixtureHttp } from './helpers.js'
import { clock, loadAll, testAuth, USERS, bearer, withEnv, serve } from './support.js'

const restoreEnv = withEnv({
  OPENAI_API_KEY: null,
  ANTHROPIC_API_KEY: null,
  APEX_AI_PROVIDER: null,
  OPENAI_MODEL: null,
  OPENAI_INSIGHT_MODEL: null,
  OPENAI_REASONING_EFFORT: null,
  OPENAI_REASONING_TOKENS: null,
  APEX_TREASURY_ADDRESS: null,
  APEX_PAYWALL: 'off',
  APEX_READS_NEED_AUTH: null,
  APEX_AUTH: null,
  K_SERVICE: null,
  APEX_LOG_LEVEL: 'error',
})

/** A stand-in for fetch: records each request, answers from a script. */
function fakeOpenAi(script) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body })
    const next = typeof script === 'function' ? script(body, calls.length) : script.shift()
    return next
  }
  return { calls, fetchImpl }
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
/** An event stream, cut into awkward chunks the way a network delivers it. */
function sse(events, { crlf = false, chunk = 7 } = {}) {
  const nl = crlf ? '\r\n' : '\n'
  const text = events.map((e) => `event: ${e.type}${nl}data: ${JSON.stringify(e)}${nl}${nl}`).join('')
  const parts = []
  for (let i = 0; i < text.length; i += chunk) parts.push(text.slice(i, i + chunk))
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p))
        c.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}
const answer = (text, extra = {}) => ({
  id: 'resp_1',
  status: 'completed',
  model: 'gpt-6-sol',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
})

after(() => restoreEnv())

test('provider: OpenAI whenever its key is set, Anthropic otherwise, nothing without a key', () => {
  assert.equal(createAi({ openaiKey: 'sk-o', anthropicKey: 'sk-a' }).provider(), 'openai')
  assert.equal(createAi({ openaiKey: '', anthropicKey: 'sk-a' }).provider(), 'anthropic')
  assert.equal(createAi({ openaiKey: () => '  ', anthropicKey: () => null }).ready(), false)
  assert.equal(createAi({ openaiKey: () => { throw new Error('no secret') }, anthropicKey: 'sk-a' }).provider(), 'anthropic', 'a secret that fails to load counts as unset')
  assert.equal(createAi({ openaiKey: 'sk-o', anthropicKey: 'sk-a', env: { APEX_AI_PROVIDER: 'anthropic' } }).provider(), 'anthropic')
  assert.equal(createAi({ openaiKey: 'sk-o', anthropicKey: null, env: { APEX_AI_PROVIDER: 'anthropic' } }).provider(), 'openai', 'asked for Anthropic but only OpenAI has a key')
})

test('models: the feature setting, then the general one, then the default', () => {
  assert.equal(modelFor('openai', 'insight', {}), 'gpt-6-sol')
  assert.equal(modelFor('openai', 'insight', { OPENAI_MODEL: 'gpt-6-luna' }), 'gpt-6-luna')
  assert.equal(modelFor('openai', 'insight', { OPENAI_MODEL: 'gpt-6-luna', OPENAI_INSIGHT_MODEL: 'gpt-6-astra' }), 'gpt-6-astra')
  assert.equal(modelFor('openai', 'chat', { OPENAI_INSIGHT_MODEL: 'gpt-6-astra' }), 'gpt-6-sol', 'the analyzer uses the general setting')
  assert.equal(modelFor('anthropic', 'parlay', { ANTHROPIC_PARLAY_MODEL: 'claude-x' }), 'claude-x')
  assert.equal(chatWebSearch({ APEX_WEB_SEARCH: '0' }), null)
  assert.deepEqual(chatWebSearch({ APEX_WEB_SEARCH_MAX_USES: '50' }), { maxUses: 20 })
})

test('OpenAI request: Responses API, system as instructions, images as data URLs, search limited to outlets', async () => {
  const { calls, fetchImpl } = fakeOpenAi([
    json(
      answer('{"legs":[]}', {
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'lions injury report', sources: [{ type: 'url', url: 'https://www.espn.com/nfl/story/1' }] } },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"summary":"ok"}', annotations: [{ type: 'url_citation', url: 'https://www.nfl.com/news/x', title: 'News', start_index: 0, end_index: 5 }] }] },
        ],
      }),
    ),
  ])
  const ai = createAi({ openaiKey: 'sk-test-openai-123456', anthropicKey: null, env: {}, fetchImpl })
  const out = await ai.complete({
    feature: 'intel',
    system: 'You are APEX Intel.',
    messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'text', text: 'Read this.' }] }],
    maxTokens: 2500,
    webSearch: { maxUses: 6, domains: ['espn.com', 'nfl.com'] },
  })
  const { url, headers, body } = calls[0]
  assert.equal(url, OPENAI_URL)
  assert.equal(headers.authorization, 'Bearer sk-test-openai-123456')
  assert.equal(body.model, 'gpt-6-sol')
  assert.equal(body.instructions, 'You are APEX Intel.')
  assert.equal(body.store, false, 'answers are not kept on OpenAI’s side')
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.equal(body.max_output_tokens, 2500 + 4000, 'room for the model’s thinking on top of the answer')
  assert.deepEqual(body.input[0].content[0], { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' })
  assert.deepEqual(body.input[0].content[1], { type: 'input_text', text: 'Read this.' })
  assert.deepEqual(body.tools, [{ type: 'web_search', filters: { allowed_domains: ['espn.com', 'nfl.com'] } }])
  assert.equal(body.max_tool_calls, 6)
  assert.equal(out.text, '{"summary":"ok"}')
  assert.equal(out.stop, 'end_turn')
  assert.deepEqual(out.citations.map((c) => c.url), ['https://www.espn.com/nfl/story/1', 'https://www.nfl.com/news/x'])
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5 })
})

test('OpenAI stream: text arrives as it is written, searches show as activity, a cut-off answer says so', async () => {
  const events = [
    { type: 'response.created', response: { id: 'resp_2', status: 'in_progress' } },
    { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1' } },
    { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'chiefs depth chart' } } },
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', delta: 'VERDICT: ' },
    { type: 'response.output_text.delta', delta: 'PRIME — over 64.5' },
    { type: 'response.incomplete', response: { id: 'resp_2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, model: 'gpt-6-sol', output: [], usage: { input_tokens: 40, output_tokens: 900 } } },
  ]
  for (const crlf of [false, true]) {
    const { calls, fetchImpl } = fakeOpenAi([sse(events, { crlf, chunk: 5 })])
    const ai = createAi({ openaiKey: 'sk-o-stream-test', env: { OPENAI_REASONING_EFFORT: 'none' }, fetchImpl })
    const deltas = []
    const acts = []
    const out = await ai.stream({ feature: 'chat', system: 's', messages: [{ role: 'user', content: 'Go' }, { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: 'More?' }], maxTokens: 900, webSearch: { maxUses: 3 }, onText: (d) => deltas.push(d), onActivity: (a) => acts.push(a.detail) })
    assert.equal(calls[0].body.stream, true)
    assert.equal(calls[0].body.max_output_tokens, 900, 'no extra room when the model is told not to reason')
    assert.deepEqual(calls[0].body.reasoning, { effort: 'none' })
    assert.deepEqual(calls[0].body.input[1], { role: 'assistant', content: 'Earlier answer' }, 'the thread goes back as it was')
    assert.deepEqual(deltas, ['VERDICT: ', 'PRIME — over 64.5'])
    assert.equal(out.text, 'VERDICT: PRIME — over 64.5')
    assert.equal(out.stop, 'max_tokens')
    assert.deepEqual(acts, ['Web search…', 'Search query: chiefs depth chart', 'Writing analysis…'])
  }
  // the parser keeps going across a frame split mid-line, and skips keep-alives
  const got = []
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(c) {
      for (const p of [': ping\n\n', 'data: {"type":"a",', '"n":1}\n', '\ndata: {"type":"b"}']) c.enqueue(enc.encode(p))
      c.close()
    },
  })
  for await (const ev of sseEvents(body)) got.push(ev.type)
  assert.deepEqual(got, ['a', 'b'])
})

test('OpenAI fallbacks: a model that turns down reasoning or search is asked again without it', async () => {
  const { calls, fetchImpl } = fakeOpenAi([
    json({ error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_parameter' } }, 400),
    json({ error: { message: 'Hosted tool web_search is not supported with this model.', type: 'invalid_request_error', param: 'tools', code: null } }, 400),
    json(answer('fine')),
  ])
  const ai = createAi({ openaiKey: 'sk-o-fallback', env: { OPENAI_MODEL: 'gpt-4.1' }, fetchImpl })
  const out = await ai.complete({ feature: 'intel', system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000, webSearch: { maxUses: 2 } })
  assert.equal(out.text, 'fine')
  assert.equal(calls.length, 3)
  assert.ok(calls[0].body.reasoning && calls[0].body.tools)
  assert.equal(calls[1].body.reasoning, undefined)
  assert.equal(calls[1].body.max_output_tokens, 1000, 'without reasoning, the answer’s own length')
  assert.ok(calls[1].body.tools)
  assert.equal(calls[2].body.tools, undefined)
  assert.equal(calls[2].body.max_tool_calls, undefined)
})

test('OpenAI errors: plain words, and never the key', async () => {
  const bad = fakeOpenAi([json({ error: { message: 'Incorrect API key provided: sk-proj-********************abcd. You can find your API key at https://platform.openai.com.', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)])
  await assert.rejects(createAi({ openaiKey: 'sk-proj-secret-value-abcd', fetchImpl: bad.fetchImpl }).complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }), (e) => {
    assert.equal(e.message, 'The AI key was refused (check OPENAI_API_KEY).')
    assert.equal(e.status, 401)
    return true
  })
  const broke = fakeOpenAi([json({ error: { message: 'Something about sk-live-abcdef123456 went wrong', type: 'server_error' } }, 500)])
  await assert.rejects(createAi({ openaiKey: 'sk-o', fetchImpl: broke.fetchImpl }).complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }), (e) => !e.message.includes('sk-live') && /\[key\]/.test(e.message))
  const quota = fakeOpenAi([json({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429)])
  await assert.rejects(createAi({ openaiKey: 'sk-o', fetchImpl: quota.fetchImpl }).complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }), /out of credit/)
  const failed = fakeOpenAi([sse([{ type: 'response.output_text.delta', delta: 'Half' }, { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'The model crashed' } } }])])
  const seen = []
  await assert.rejects(createAi({ openaiKey: 'sk-o', fetchImpl: failed.fetchImpl }).stream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10, onText: (d) => seen.push(d) }), /crashed/)
  assert.deepEqual(seen, ['Half'])
  const cut = fakeOpenAi([sse([{ type: 'response.output_text.delta', delta: 'Half' }])])
  await assert.rejects(createAi({ openaiKey: 'sk-o', fetchImpl: cut.fetchImpl }).stream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }), /ended before/)
  assert.equal(scrubKeys('key sk-ant-api03-abcdefghijk and sk-proj-xyz123456'), 'key [key] and [key]')
  await assert.rejects(createAi({ openaiKey: null, anthropicKey: null }).complete({ messages: [] }), (e) => e.code === 'ai_off')
})

let api
let engine
let calls
before(async () => {
  const fake = fakeOpenAi((body) =>
    body.stream
      ? sse([
          { type: 'response.output_item.added', item: { type: 'message' } },
          { type: 'response.output_text.delta', delta: 'VERDICT: STANDARD — ' },
          { type: 'response.output_text.delta', delta: 'over the line' },
          { type: 'response.completed', response: answer('VERDICT: STANDARD — over the line', { id: 'resp_route' }) },
        ])
      : json(answer('One-shot analysis.')),
  )
  calls = fake.calls
  const ai = createAi({ openaiKey: () => 'sk-test-openai-routes', anthropicKey: () => null, fetchImpl: fake.fetchImpl })
  const { http } = fixtureHttp()
  const made = createApexApp({ engineMode: 'lazy', http, store: createStore({ driver: 'memory' }), auth: testAuth(USERS, { invited: ['u_pro'] }), ai, oddsKey: () => null, now: clock() })
  engine = made.engine
  await loadAll(engine)
  api = await serve(made.app)
})
after(async () => {
  await api?.close()
  engine?.stop()
})

const ndjson = (text) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('on OpenAI: a prop read and the analyzer stream through, and health says which AI answers', async () => {
  const health = await api.get('/api/health')
  assert.equal(health.body.ai, true)
  assert.equal(health.body.aiProvider, 'openai')
  assert.ok(!health.text.includes('sk-test-openai-routes'))
  const propId = (await api.get('/api/nfl/games/401873020')).body.props[0].id
  const read = await api.post('/api/nfl/insight', { propId }, { headers: bearer('u_pro') })
  assert.equal(read.status, 200, read.text)
  const ev = ndjson(read.text)
  assert.equal(ev[0].type, 'start')
  assert.equal(ev[0].model, 'gpt-6-sol')
  assert.equal(ev.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'VERDICT: STANDARD — over the line')
  assert.equal(ev.at(-1).type, 'complete')
  assert.equal(ev.at(-1).stop_reason, 'end_turn')
  const sent = calls.at(-1).body
  assert.match(sent.instructions, /APEX NFL Betting Intelligence/)
  assert.match(sent.input[0].content, /PROP:/, 'the model gets the APEX brief')
  const game = { homeTeam: 'Detroit Lions', awayTeam: 'Green Bay Packers', date: '2026-10-25' }
  const chat = await api.post('/api/chat/stream', { game }, { headers: bearer('u_pro') })
  assert.equal(chat.status, 200, chat.text)
  const done = ndjson(chat.text).find((e) => e.type === 'complete')
  assert.equal(done.text, 'VERDICT: STANDARD — over the line')
  assert.equal(done.messages.at(-1).role, 'assistant')
  assert.equal(done.id, 'resp_route')
  assert.equal(calls.at(-1).body.tools[0].type, 'web_search', 'the analyzer searches the web')
  const once = await api.post('/api/chat', { game: { ...game, context: 'one shot' } }, { headers: bearer('u_pro') })
  assert.equal(once.status, 200, once.text)
  assert.equal(once.body.text, 'One-shot analysis.')
})

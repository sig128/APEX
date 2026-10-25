import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicWebSearchTools } from './anthropicWebTools.js'
import {
  getApexSystemPrompt,
  computeEffectivePromptMode,
  normalizeMlbBettingScope,
} from './prompts/resolveApexSystemPrompt.js'

/**
 * Optional live APEX data for NFL game analyses. app.js installs a provider that returns a
 * short text block (top props with hit rates, injuries, odds) for the game being analyzed.
 */
let gameContextProvider = null
export function setGameContextProvider(fn) {
  gameContextProvider = typeof fn === 'function' ? fn : null
}
const CONTEXT_CAP = 6000
function applyGameContext(game, sportKey) {
  if (!gameContextProvider || sportKey !== 'americanfootball_nfl') return ''
  try {
    const text = gameContextProvider(game)
    return typeof text === 'string' && text.trim() ? `\n\n===== APEX LIVE DATA (use it, cite hit rates) =====\n${text.slice(0, CONTEXT_CAP)}` : ''
  } catch {
    return ''
  }
}

/**
 * @param {object} body - game fields
 * @param {'full' | 'compact' | 'mid'} effectivePromptMode
 * @param {'full_board' | 'player_props'} mlbBettingScope
 * @param {string | undefined} resolvedSportKey
 */
function buildGameUserMessage(body, effectivePromptMode, mlbBettingScope, resolvedSportKey) {
  const {
    homeTeam,
    awayTeam,
    date,
    gameTime,
    stadium,
    homeStarter,
    awayStarter,
    bankroll,
    mlOdds,
    totalOu,
    context,
    sportKey,
  } = body

  let g = `HOME TEAM: ${homeTeam}\nAWAY TEAM: ${awayTeam}\nDATE: ${date}`
  if (typeof sportKey === 'string' && sportKey.trim()) {
    g += `\nSPORT (league id): ${sportKey.trim()}`
  }
  if (gameTime) g += `\nGAME TIME: ${gameTime}`
  g += stadium ? `\nSTADIUM: ${stadium}` : '\nSTADIUM: (auto-search)'
  g += homeStarter ? `\nHOME STARTER: ${homeStarter}` : '\nHOME STARTER: (auto-search)'
  g += awayStarter ? `\nAWAY STARTER: ${awayStarter}` : '\nAWAY STARTER: (auto-search)'
  if (bankroll) g += `\nBANKROLL: $${bankroll}`
  if (mlOdds) g += `\nCURRENT ML: ${mlOdds}`
  if (totalOu) g += `\nCURRENT TOTAL: ${totalOu}`
  if (context) g += `\nCONTEXT: ${context}`

  const sk =
    typeof resolvedSportKey === 'string' && resolvedSportKey.trim()
      ? resolvedSportKey.trim()
      : typeof sportKey === 'string' && sportKey.trim()
        ? sportKey.trim()
        : ''
  const playerPropMlb = sk === 'baseball_mlb' && mlbBettingScope === 'player_props'

  const important = playerPropMlb
    ? 'IMPORTANT: Player Prop Exclusivity mode — recommend ONLY individual player performance props. ' +
      'Do not output ML, run line, game total, team totals, F5 sides/totals, or inning run props as plays. ' +
      'Use team/game context only to calibrate player props. Finish sections A→H in order. ' +
      'After section G, output the <<<APEX_BET_CARDS_JSON>>> … <<<END_APEX_BET_CARDS_JSON>>> block: ' +
      'singleLegLock and every parlay leg must name player props only (see system prompt). Valid JSON only.'
    : effectivePromptMode === 'compact'
      ? 'IMPORTANT: Dual-team analysis for THIS sport. Stay condensed: one merged prop board for real edges, not a giant table per player. ' +
        'No raw search dumps or long quotes. Finish A→G in order so the answer does not truncate mid-section. ' +
        'Follow compact sections (A–G) in the system prompt. Web search for uncertain lineups, odds, weather.\n\n' +
        'FINAL LINES (mandatory after section G): End your reply with the <<<APEX_BET_CARDS_JSON>>> … <<<END_APEX_BET_CARDS_JSON>>> block exactly as in the system prompt (single-leg lock + 2-leg + 3-leg arrays). Valid JSON only.'
      : 'IMPORTANT: Analyze BOTH teams fully for this sport. Use the variables and sections defined in the system prompt. ' +
        'Evaluate available props across both sides, rank by edge, apply SLCM, and produce complete output Sections A through H (including bet cards).'

  return `===== GAME TO ANALYZE =====\n${g}${applyGameContext(body, sk)}\n\n${important}`
}

/** @returns {Array<{role:'user'|'assistant',content:string}>|null} */
function validateMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i]
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null
    if (typeof m.content !== 'string' || m.content.length === 0) return null
    if (m.content.length > 900_000) return null
    const expect = i % 2 === 0 ? 'user' : 'assistant'
    if (m.role !== expect) return null
    out.push({ role: m.role, content: m.content })
  }
  if (out[out.length - 1].role !== 'user') return null
  return out
}

export function extractTextFromMessage(msg) {
  const blocks = msg?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/**
 * Shared validation for POST /api/chat and POST /api/chat/stream
 * @returns {{ ok: false, status: number, error: string } | { ok: true, messagesForApi: Array, model: string, maxTokens: number, system: string, resolvedSportKey?: string }}
 */
export function parseChatBody(req) {
  const {
    game,
    messages: rawMessages,
    sportKey: bodySportKey,
    apexPromptMode,
    apexSystemPromptMode,
    apexMlbBettingScope,
  } = req.body || {}
  const clientPromptRaw = apexPromptMode ?? apexSystemPromptMode

  /** Odds API sport_key (e.g. icehockey_nhl). From game.sportKey or top-level sportKey for follow-ups. */
  let resolvedSportKey
  if (game && typeof game === 'object' && typeof game.sportKey === 'string' && game.sportKey.trim()) {
    resolvedSportKey = game.sportKey.trim()
  } else if (typeof bodySportKey === 'string' && bodySportKey.trim()) {
    resolvedSportKey = bodySportKey.trim()
  }

  const effectivePromptMode = computeEffectivePromptMode(resolvedSportKey, clientPromptRaw)
  const mlbBettingScope = normalizeMlbBettingScope(apexMlbBettingScope)

  let messagesForApi
  if (game && typeof game === 'object') {
    const { homeTeam, awayTeam, date, commenceTimeIso } = game
    if (!homeTeam?.trim() || !awayTeam?.trim() || !date?.trim()) {
      return {
        ok: false,
        status: 400,
        error: 'For a new analysis, game.homeTeam, game.awayTeam, and game.date are required.',
      }
    }
    const ct =
      typeof commenceTimeIso === 'string' && commenceTimeIso.trim() ? commenceTimeIso.trim() : ''
    if (ct) {
      const startMs = new Date(ct).getTime()
      if (!Number.isNaN(startMs) && Date.now() >= startMs) {
        return {
          ok: false,
          status: 400,
          error:
            'This game has already started. Pre-game analysis is not available. (Live betting may be offered separately.)',
        }
      }
    }
    messagesForApi = [
      {
        role: 'user',
        content: buildGameUserMessage(game, effectivePromptMode, mlbBettingScope, resolvedSportKey),
      },
    ]
  } else if (rawMessages != null) {
    const v = validateMessages(rawMessages)
    if (!v) {
      return {
        ok: false,
        status: 400,
        error:
          'Invalid messages: must alternate user/assistant starting with user, and end with a user message.',
      }
    }
    messagesForApi = v
  } else {
    return {
      ok: false,
      status: 400,
      error: 'Send JSON with either `game` (new analysis) or `messages` (follow-up turn).',
    }
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
  const maxTokens = Math.min(
    Math.max(parseInt(process.env.ANTHROPIC_MAX_TOKENS || '16384', 10) || 16384, 1024),
    200000,
  )

  return {
    ok: true,
    messagesForApi,
    model,
    maxTokens,
    system: getApexSystemPrompt(resolvedSportKey, effectivePromptMode, mlbBettingScope),
    resolvedSportKey: typeof resolvedSportKey === 'string' && resolvedSportKey ? resolvedSportKey : undefined,
  }
}

/**
 * NDJSON stream of Claude activity + text deltas; ends with `{ type: 'complete', ... }` (same shape as non-stream /api/chat JSON).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string | undefined} apiKey
 */
export async function handleChatStream(req, res, apiKey) {
  if (!apiKey) {
    res.status(503).json({
      error: 'ANTHROPIC_API_KEY is not set in backend/.env (the file the server loads).',
    })
    return { ok: false, produced: false }
  }

  // the gate may have parsed it already (and fingerprinted that exact prompt): use the same one
  const parsed = req.apexParsed || parseChatBody(req)
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error })
    return { ok: false, produced: false }
  }

  const { getDisabledSportKeys } = await import('./sportsConfig.js')
  const disabled = await getDisabledSportKeys()
  if (parsed.resolvedSportKey && disabled.includes(parsed.resolvedSportKey)) {
    res.status(403).json({ error: 'This sport is temporarily unavailable.' })
    return { ok: false, produced: false }
  }
  let produced = false
  let failed = false

  const { messagesForApi, model, maxTokens, system } = parsed

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const write = (obj) => {
    res.write(`${JSON.stringify(obj)}\n`)
  }

  const started = Date.now()
  let lastSearchLine = ''

  try {
    const anthropic = new Anthropic({ apiKey })
    const tools = getAnthropicWebSearchTools()
    write({
      type: 'start',
      model,
      maxTokens,
      webSearch: Boolean(tools),
    })

    const stream = anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      messages: messagesForApi,
      ...(tools ? { tools } : {}),
    })

    stream.on('streamEvent', (event) => {
      try {
        if (event.type === 'content_block_start') {
          const b = event.content_block
          if (!b) return
          if (b.type === 'server_tool_use' && b.name === 'web_search') {
            write({ type: 'activity', phase: 'web_search', detail: 'Web search…' })
          }
          if (b.type === 'web_search_tool_result') {
            write({ type: 'activity', phase: 'web_search', detail: 'Processing search results…' })
          }
          if (b.type === 'text') {
            write({ type: 'activity', phase: 'writing', detail: 'Writing analysis…' })
          }
        }
        if (event.type === 'message_delta' && event.delta?.stop_reason) {
          write({ type: 'stop_reason', stop_reason: event.delta.stop_reason })
        }
      } catch {
        /* ignore */
      }
    })

    stream.on('text', (textDelta) => {
      if (textDelta) produced = true
      write({ type: 'text_delta', text: textDelta })
    })

    stream.on('inputJson', (_partial, input) => {
      const q = input && typeof input === 'object' && typeof input.query === 'string' ? input.query : ''
      if (q && q !== lastSearchLine) {
        lastSearchLine = q
        write({ type: 'activity', phase: 'web_search', detail: `Search query: ${q}` })
      }
    })

    stream.on('error', (err) => {
      write({ type: 'stream_error', error: err?.message || String(err) })
    })

    const finalMessage = await stream.finalMessage()
    const assistantText = extractTextFromMessage(finalMessage)
    const fullThread = [...messagesForApi, { role: 'assistant', content: assistantText }]

    const ms = Date.now() - started
    console.log('[api/chat/stream] done', {
      ms,
      sec: (ms / 1000).toFixed(1),
      stop_reason: finalMessage?.stop_reason,
      id: finalMessage?.id,
    })

    write({
      type: 'complete',
      text: assistantText,
      messages: fullThread,
      model,
      id: finalMessage.id,
      usage: finalMessage.usage,
      stop_reason: finalMessage.stop_reason ?? null,
    })
  } catch (e) {
    const errMsg = e?.message || String(e)
    const status = e?.status >= 400 && e?.status < 600 ? e.status : 502
    console.error('[api/chat/stream] Anthropic error:', errMsg, { afterMs: Date.now() - started })
    failed = true
    try {
      write({ type: 'error', error: errMsg, status })
    } catch {
      /* response may be closed */
    }
  } finally {
    res.end()
  }
  return { ok: !failed, produced }
}

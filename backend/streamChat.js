import { chatWebSearch, scrubKeys } from './src/ai/llm.js'
import {
  getApexSystemPrompt,
  computeEffectivePromptMode,
  normalizeMlbBettingScope,
} from './prompts/resolveApexSystemPrompt.js'

/**
 * Optional live Propify data for NFL game analyses. app.js installs a provider that returns a
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
    return typeof text === 'string' && text.trim() ? `\n\n===== PROPIFY LIVE DATA (use it, cite hit rates) =====\n${text.slice(0, CONTEXT_CAP)}` : ''
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

// What a game form can hold. Anything longer is cut, anything else is dropped, so an analysis
// prompt is always one the server wrote from a few short fields.
const GAME_FIELDS = { homeTeam: 80, awayTeam: 80, date: 40, gameTime: 40, stadium: 120, homeStarter: 80, awayStarter: 80, bankroll: 40, mlOdds: 80, totalOu: 80, context: 4000, sportKey: 60, oddsEventId: 64, commenceTimeIso: 40 }
function cleanGame(game) {
  const out = {}
  for (const [k, max] of Object.entries(GAME_FIELDS)) {
    const v = game[k]
    if (typeof v === 'string') out[k] = v.slice(0, max)
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v).slice(0, max)
  }
  return out
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

/**
 * Shared validation for POST /api/chat and POST /api/chat/stream
 * @returns {{ ok: false, status: number, error: string } | { ok: true, messagesForApi: Array, maxTokens: number, system: string, resolvedSportKey?: string }}
 */
export function parseChatBody(req) {
  let { game } = req.body || {}
  const {
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

  // Every game is analysed once and shared, so every analysis (and its follow-ups) runs on the
  // same settings: the server's depth and line type, never a per-person choice.
  void clientPromptRaw
  void apexMlbBettingScope
  const effectivePromptMode = computeEffectivePromptMode(resolvedSportKey, undefined)
  const mlbBettingScope = normalizeMlbBettingScope(undefined)

  let messagesForApi
  let kind
  let shared = null
  if (game != null && (typeof game !== 'object' || Array.isArray(game))) {
    return { ok: false, status: 400, error: '`game` must be an object with homeTeam, awayTeam and date.' }
  }
  if (game) {
    kind = 'analysis'
    game = cleanGame(game)
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
    // the shared analysis is written from the game alone: personal fields (bankroll, notes) and
    // typed-in details (odds, starters, stadium) would end up in everyone's copy, so they're left
    // out (the AI looks them up), and anything personal goes in a follow-up question
    shared = { homeTeam: game.homeTeam.trim(), awayTeam: game.awayTeam.trim(), date: game.date.trim(), ...(game.sportKey ? { sportKey: game.sportKey } : {}), ...(ct ? { commenceTimeIso: ct } : {}) }
    messagesForApi = [
      {
        role: 'user',
        content: buildGameUserMessage(shared, effectivePromptMode, mlbBettingScope, resolvedSportKey),
      },
    ]
  } else if (rawMessages != null) {
    kind = 'followup'
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

  const maxTokens = Math.min(
    Math.max(parseInt(process.env.APEX_AI_MAX_TOKENS || process.env.ANTHROPIC_MAX_TOKENS || '16384', 10) || 16384, 1024),
    128000,
  )

  return {
    ok: true,
    // 'analysis' (the server wrote the prompt from `game`) or 'followup' (the client sent the thread)
    kind,
    messagesForApi,
    maxTokens,
    system: getApexSystemPrompt(resolvedSportKey, effectivePromptMode, mlbBettingScope),
    resolvedSportKey: typeof resolvedSportKey === 'string' && resolvedSportKey ? resolvedSportKey : undefined,
    // the game an analysis is for (what makes it the same game for every member)
    game: shared,
  }
}

/** Starts an NDJSON reply; returns write(event). */
export function openNdjson(res) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  return (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}\n`)
    } catch {
      /* the reader left */
    }
  }
}

/** A stored analysis, sent the way a fresh one streams (start, the text, complete). */
export function writeStoredAnalysis(write, stored, { start = true } = {}) {
  if (start) write({ type: 'start', model: stored.model, shared: true, at: stored.at })
  write({ type: 'text_delta', text: stored.text })
  write({
    type: 'complete',
    text: stored.text,
    messages: [
      { role: 'user', content: stored.prompt },
      { role: 'assistant', content: stored.text },
    ],
    model: stored.model,
    id: null,
    usage: null,
    stop_reason: stored.stop ?? null,
    shared: true,
    at: stored.at,
  })
}

export function sendStoredAnalysis(res, stored) {
  writeStoredAnalysis(openNdjson(res), stored)
  res.end()
}

/**
 * NDJSON stream of the AI's activity + text deltas; ends with `{ type: 'complete', ... }` (same shape as non-stream /api/chat JSON).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {ReturnType<typeof import('./src/ai/llm.js').createAi>} ai
 */
export async function handleChatStream(req, res, ai, { keepGoing = false, onDone = null, before = null } = {}) {
  if (!ai?.ready()) {
    res.status(503).json({
      error: 'AI is not configured on this server (OPENAI_API_KEY).',
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

  const { messagesForApi, maxTokens, system } = parsed
  const model = ai.model('chat')

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const write = (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}\n`)
    } catch {
      /* the reader left */
    }
  }

  const started = Date.now()
  // a reader who leaves stops a follow-up; a shared analysis keeps going (it's stored for the
  // next member, who would otherwise pay for it again)
  const stop = new AbortController()
  if (!keepGoing) res.on?.('close', () => stop.abort())
  // e.g. "another member is writing this one": events to send before the AI starts
  if (before) for (const ev of before) write(ev)

  try {
    const webSearch = chatWebSearch()
    write({
      type: 'start',
      model,
      maxTokens,
      webSearch: Boolean(webSearch),
    })

    const out = await ai.stream({
      feature: 'chat',
      system,
      messages: messagesForApi,
      maxTokens,
      webSearch,
      signal: stop.signal,
      onText: (textDelta) => {
        if (textDelta) produced = true
        write({ type: 'text_delta', text: textDelta })
      },
      onActivity: (a) => write({ type: 'activity', phase: a.phase, detail: a.detail }),
    })
    if (out.stop) write({ type: 'stop_reason', stop_reason: out.stop })
    const assistantText = out.text
    const fullThread = [...messagesForApi, { role: 'assistant', content: assistantText }]

    const ms = Date.now() - started
    console.log('[api/chat/stream] done', {
      ms,
      sec: (ms / 1000).toFixed(1),
      stop_reason: out.stop,
      id: out.id,
      provider: ai.provider(),
    })

    if (onDone) await onDone({ prompt: messagesForApi[0]?.content, text: assistantText, model: out.model || model, stop: out.stop ?? null }).catch(() => {})
    write({
      type: 'complete',
      text: assistantText,
      messages: fullThread,
      model: out.model || model,
      id: out.id,
      usage: out.usage,
      stop_reason: out.stop ?? null,
    })
  } catch (e) {
    const errMsg = scrubKeys(e?.message || String(e))
    const status = e?.status >= 400 && e?.status < 600 ? e.status : 502
    console.error('[api/chat/stream] AI error:', errMsg, { afterMs: Date.now() - started, provider: ai.provider() })
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

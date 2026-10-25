import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicWebSearchTools } from './anthropicWebTools.js'
import { parseChatBody, extractTextFromMessage } from './streamChat.js'
import { getDisabledSportKeys } from './sportsConfig.js'

/**
 * POST /api/chat — same contract as local backend/server.js
 * @param {string} apiKey - Anthropic API key (from Secret Manager in prod)
 */
export async function handleChat(req, res, apiKey) {
  try {
    if (!apiKey) {
      return res.status(503).json({
        error: 'ANTHROPIC_API_KEY is not configured for Cloud Functions.',
      })
    }

    const parsed = parseChatBody(req)
    if (!parsed.ok) {
      return res.status(parsed.status).json({ error: parsed.error })
    }

    const disabled = await getDisabledSportKeys()
    if (parsed.resolvedSportKey && disabled.includes(parsed.resolvedSportKey)) {
      return res.status(403).json({ error: 'This sport is temporarily unavailable.' })
    }

    const { messagesForApi, model, maxTokens, system } = parsed

    const anthropic = new Anthropic({ apiKey })
    const tools = getAnthropicWebSearchTools()
    const msg = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: messagesForApi,
      ...(tools ? { tools } : {}),
    })

    const assistantText = extractTextFromMessage(msg)
    const fullThread = [
      ...messagesForApi,
      { role: 'assistant', content: assistantText },
    ]

    return res.json({
      text: assistantText,
      messages: fullThread,
      model,
      id: msg.id,
      usage: msg.usage,
    })
  } catch (e) {
    const errMsg = e?.message || String(e)
    const status = e?.status >= 400 && e?.status < 600 ? e.status : 500
    console.error('Chat error:', errMsg)
    if (!res.headersSent) {
      return res.status(status).json({ error: errMsg })
    }
  }
}

export { handleChatStream } from './streamChat.js'

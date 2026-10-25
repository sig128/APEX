/**
 * Anthropic server-side web search tool.
 * Enable for your org in Claude Console → Privacy / settings (see Anthropic web search docs).
 *
 * ANTHROPIC_WEB_SEARCH=0 or false — disable (no extra search charges).
 * ANTHROPIC_WEB_SEARCH_MAX_USES — max searches per /api/chat call (default 5). The old default of 1
 * caused Claude to stop mid-analysis (“exhausted search calls”) when the prompt needed multiple lookups.
 * Each search is billed (see Anthropic pricing). Cap at 20.
 */
export function getAnthropicWebSearchTools() {
  const off =
    process.env.ANTHROPIC_WEB_SEARCH === '0' ||
    process.env.ANTHROPIC_WEB_SEARCH === 'false'
  if (off) return undefined

  const maxUses = Math.min(
    Math.max(parseInt(process.env.ANTHROPIC_WEB_SEARCH_MAX_USES || '5', 10) || 5, 1),
    20,
  )

  return [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: maxUses,
    },
  ]
}

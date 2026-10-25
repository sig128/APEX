import { APEX_SYSTEM_PROMPT } from './apexSystemPrompt.js'
import { APEX_SYSTEM_PROMPT_COMPACT } from './apexSystemPromptCompact.js'
import { APEX_SYSTEM_PROMPT_MLB_MID } from './apexSystemPromptMlbMid.js'
import { APEX_SYSTEM_PROMPT_MLB_PLAYER_PROP } from './apexSystemPromptMlbPlayerProp.js'
import { APEX_SYSTEM_PROMPT_NHL } from './apexSystemPromptNhl.js'
import { APEX_SYSTEM_PROMPT_NHL_COMPACT } from './apexSystemPromptNhlCompact.js'
import { APEX_SYSTEM_PROMPT_NBA } from './apexSystemPromptNba.js'
import { APEX_SYSTEM_PROMPT_NBA_COMPACT } from './apexSystemPromptNbaCompact.js'
import { APEX_SYSTEM_PROMPT_NFL } from './apexSystemPromptNfl.js'
import { APEX_SYSTEM_PROMPT_NFL_COMPACT } from './apexSystemPromptNflCompact.js'
import { RULES_PROMPT } from '../src/nfl/rules.js'

/** Odds API sport_key values for big-4 (must match frontend / The Odds API). */
export const APEX_SPORT_KEYS = {
  MLB: 'baseball_mlb',
  NHL: 'icehockey_nhl',
  NBA: 'basketball_nba',
  NFL: 'americanfootball_nfl',
}

/** @returns {'full' | 'compact' | 'mid'} */
export function getApexSystemPromptMode() {
  const raw = process.env.APEX_SYSTEM_PROMPT_MODE
  const m = typeof raw === 'string' ? raw.toLowerCase().trim() : ''
  // Default for all sports: compact. Full prompts only when explicitly requested.
  if (m === 'full' || m === 'large' || m === 'long' || m === 'verbose') return 'full'
  if (m === 'mid' || m === 'medium') return 'mid'
  return 'compact'
}

/**
 * @param {unknown} raw - Client body field `apexPromptMode` (or legacy `apexSystemPromptMode`).
 * @returns {'full' | 'compact' | 'mid' | null}
 */
export function normalizeClientPromptMode(raw) {
  if (typeof raw !== 'string') return null
  const m = raw.toLowerCase().trim()
  if (m === 'full' || m === 'large' || m === 'long' || m === 'verbose') return 'full'
  if (m === 'mid' || m === 'medium') return 'mid'
  if (m === 'compact' || m === 'small' || m === 'short') return 'compact'
  return null
}

/** Client body field \`apexMlbBettingScope\` — MLB-only; ignored for other sports. Default: player props. */
export function normalizeMlbBettingScope(raw) {
  if (typeof raw !== 'string') return 'player_props'
  const m = raw.toLowerCase().trim()
  if (m === 'full_board' || m === 'full' || m === 'moneyline') return 'full_board'
  if (m === 'player_props' || m === 'player_prop' || m === 'props') return 'player_props'
  return 'player_props'
}

/**
 * MLB-only: client may override env via `apexPromptMode`. Other sports always use server env.
 * @param {string | undefined} resolvedSportKey
 * @param {unknown} clientRaw
 * @returns {'full' | 'compact' | 'mid'}
 */
export function computeEffectivePromptMode(resolvedSportKey, clientRaw) {
  const envMode = getApexSystemPromptMode()
  const clientMode = normalizeClientPromptMode(clientRaw)
  const sk = typeof resolvedSportKey === 'string' ? resolvedSportKey.trim() : ''
  if (sk === APEX_SPORT_KEYS.MLB && clientMode) return clientMode
  return envMode
}

/**
 * @param {string | undefined} sportKey - Odds API sport_key (e.g. icehockey_nhl). Defaults to MLB.
 * @param {'full' | 'compact' | 'mid' | undefined} [promptMode] - If set, use instead of env (caller should pass `computeEffectivePromptMode` result).
 * @param {'full_board' | 'player_props' | undefined} [mlbBettingScope] - MLB only: \`player_props\` uses exclusivity prompt; otherwise full board.
 * @returns {string}
 */
export function getApexSystemPrompt(sportKey, promptMode, mlbBettingScope) {
  // every sport and every prompt size answers to the same APEX rules
  return `${basePrompt(sportKey, promptMode, mlbBettingScope)}\n\n${RULES_PROMPT}`
}

function basePrompt(sportKey, promptMode, mlbBettingScope) {
  const sk = typeof sportKey === 'string' ? sportKey.trim() : ''
  const mode = promptMode !== undefined && promptMode !== null ? promptMode : getApexSystemPromptMode()
  const scope = mlbBettingScope === 'player_props' ? 'player_props' : 'full_board'

  if (sk === APEX_SPORT_KEYS.MLB && scope === 'player_props') {
    return APEX_SYSTEM_PROMPT_MLB_PLAYER_PROP
  }

  if (mode === 'compact') {
    switch (sk) {
      case APEX_SPORT_KEYS.NHL:
        return APEX_SYSTEM_PROMPT_NHL_COMPACT
      case APEX_SPORT_KEYS.NBA:
        return APEX_SYSTEM_PROMPT_NBA_COMPACT
      case APEX_SPORT_KEYS.NFL:
        return APEX_SYSTEM_PROMPT_NFL_COMPACT
      case APEX_SPORT_KEYS.MLB:
      default:
        return APEX_SYSTEM_PROMPT_COMPACT
    }
  }

  if (mode === 'mid') {
    // MLB-only mid prompt for testing; other sports use compact until sport-specific mid files exist.
    if (sk === APEX_SPORT_KEYS.MLB || sk === '') {
      return APEX_SYSTEM_PROMPT_MLB_MID
    }
    switch (sk) {
      case APEX_SPORT_KEYS.NHL:
        return APEX_SYSTEM_PROMPT_NHL_COMPACT
      case APEX_SPORT_KEYS.NBA:
        return APEX_SYSTEM_PROMPT_NBA_COMPACT
      case APEX_SPORT_KEYS.NFL:
        return APEX_SYSTEM_PROMPT_NFL_COMPACT
      default:
        return APEX_SYSTEM_PROMPT_COMPACT
    }
  }

  switch (sk) {
    case APEX_SPORT_KEYS.NHL:
      return APEX_SYSTEM_PROMPT_NHL
    case APEX_SPORT_KEYS.NBA:
      return APEX_SYSTEM_PROMPT_NBA
    case APEX_SPORT_KEYS.NFL:
      return APEX_SYSTEM_PROMPT_NFL
    case APEX_SPORT_KEYS.MLB:
    default:
      return APEX_SYSTEM_PROMPT
  }
}

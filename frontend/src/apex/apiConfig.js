/**
 * Chat API origin for production builds.
 * - Dev: leave VITE_API_BASE unset → same-origin `/api/...` (Vite proxy → local backend).
 * - Production: MUST set VITE_API_BASE to the Cloud Function HTTPS URL (see `.env.production`).
 *   If unset, the browser calls `/api/chat/stream` on Firebase Hosting; rewrites hit the same
 *   function but Hosting enforces ~60s, which cuts long AI streams mid-flight ("Load failed").
 */
const raw = import.meta.env.VITE_API_BASE
export const CHAT_API_BASE = typeof raw === 'string' ? raw.replace(/\/+$/, '') : ''

/** Same origin as chat in dev (Vite proxy); in production use `VITE_API_BASE` (Cloud Function URL). */
export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  return CHAT_API_BASE ? `${CHAT_API_BASE}${p}` : p
}

export function getChatStreamUrl() {
  const path = '/api/chat/stream'
  if (!CHAT_API_BASE) return path
  return `${CHAT_API_BASE}${path}`
}

/** True when built for production but no direct function URL — streaming will likely fail on long runs. */
export function isHostingChatApiMisconfigured() {
  return Boolean(import.meta.env.PROD && !import.meta.env.VITE_API_BASE)
}

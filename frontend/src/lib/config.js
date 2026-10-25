// Where the API lives.
// - DATA_BASE: JSON reads and writes. Leave VITE_DATA_BASE unset on Firebase Hosting so they go
//   through /api on the same origin (and its CDN cache); in dev Vite proxies /api to :8787.
// - STREAM_BASE: live streams and AI replies. Hosting rewrites stop at 60 seconds, so in
//   production set VITE_API_BASE to the Cloud Function URL (the analyzer already needs it).
const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '')
const env = import.meta.env || {} // undefined outside Vite (unit tests)

export const DATA_BASE = clean(env.VITE_DATA_BASE)
export const STREAM_BASE = clean(env.VITE_API_BASE) || DATA_BASE
export const PRIVY_APP_ID = clean(env.VITE_PRIVY_APP_ID)
export const SITE_URL = clean(env.VITE_PUBLIC_SITE_URL) || (typeof window !== 'undefined' ? window.location.origin : '')

export const dataUrl = (path) => `${DATA_BASE}${path}`
export const streamUrl = (path) => `${STREAM_BASE}${path}`

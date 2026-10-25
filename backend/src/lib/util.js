// Small shared helpers. No dependencies.

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
export const round = (x, d = 0) => {
  if (!Number.isFinite(x)) return x
  const f = 10 ** d
  return Math.round(x * f) / f
}
export const sum = (xs) => xs.reduce((s, x) => s + x, 0)
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : null)
export function median(xs) {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
export function sd(xs) {
  if (xs.length < 2) return null
  const m = mean(xs)
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1))
}

/** Parse ESPN-style numbers: "1,204", "--", "12.5", "3-7" (first part), "" -> null. */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/,/g, '')
  if (!s || s === '-' || s === '--') return null
  const m = s.match(/^[+-]?\d+(\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

export const uniq = (xs) => [...new Set(xs)]
export function groupBy(xs, fn) {
  const m = new Map()
  for (const x of xs) {
    const k = fn(x)
    const a = m.get(k)
    if (a) a.push(x)
    else m.set(k, [x])
  }
  return m
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const nowMs = () => Date.now()

export function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Names as books and ESPN spell them differently: "A.J. Brown Jr." -> "aj brown". */
export function nameKey(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/)
  if (parts.length < 2) return full || ''
  const last = parts.slice(1).join(' ')
  return `${parts[0][0]}. ${last}`
}

export function chunk(xs, n) {
  const out = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** Stable short hash (FNV-1a) for ETags and cache keys. */
export function hash(str) {
  let h = 0x811c9dc5
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function safeJson(s, fallback = null) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

/** Runs fn at most `limit` at a time over items, preserving order of results. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

export function envInt(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const v = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) ? clamp(v, min, max) : fallback
}

export function envNum(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const v = Number.parseFloat(process.env[name] ?? '')
  return Number.isFinite(v) ? clamp(v, min, max) : fallback
}

export function envBool(name, fallback = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase()
  if (!v) return fallback
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

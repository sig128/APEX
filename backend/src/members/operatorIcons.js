// Each operator's current App Store icon, from Apple's public lookup once a day, so a new icon (a
// rebrand, a holiday one) shows in the setup and on the slip too. The website and the app ship
// with the icons as they were when the list was made, and use these over them.
import { OPERATOR_APPS } from './operators.js'
import { log, errText } from '../lib/log.js'

const DAY = 24 * 3600_000
const RETRY = 3600_000
const NS = 'operators'
const KEY = 'icons'
// big enough for a 56px tile on a 3x screen
export const ICON_SIZE = '180x180bb.jpg'

/** Apple's icon address at our size, or null for anything not on Apple's image servers. */
export function iconFrom(url) {
  const u = typeof url === 'string' ? url : ''
  if (!/^https:\/\/is\d-ssl\.mzstatic\.com\/image\/thumb\/[\w./%~-]+\/[\w.-]+$/.test(u)) return null
  return u.replace(/\/[\w.-]+$/, `/${ICON_SIZE}`)
}

/** One lookup per App Store country: [country, url, [[key, id], ...]]. */
export function lookups() {
  const by = new Map()
  for (const [key, ref] of Object.entries(OPERATOR_APPS)) {
    const [country, id] = ref.split(':')
    if (!by.has(country)) by.set(country, [])
    by.get(country).push([key, id])
  }
  return [...by].map(([country, list]) => [country, `https://itunes.apple.com/lookup?country=${country}&id=${list.map(([, id]) => id).join(',')}`, list])
}

export function createOperatorIcons({ http, store = null, now = () => Date.now() }) {
  let mem = null // { icons, at }: at is when they were looked up (or when to look again, after a miss)
  let pending = null

  async function lookup() {
    const icons = {}
    await Promise.all(
      lookups().map(async ([country, url, list]) => {
        try {
          const j = await http.getJson(url, { timeoutMs: 8000, retries: 1, priority: 'background' })
          const art = new Map((j?.results || []).map((a) => [String(a.trackId), a.artworkUrl512 || a.artworkUrl100]))
          for (const [key, id] of list) {
            const icon = iconFrom(art.get(id))
            if (icon) icons[key] = icon
          }
        } catch (e) {
          log.warn('operator icons: lookup failed', { country, err: errText(e) })
        }
      }),
    )
    return icons
  }

  async function refresh() {
    const t = now()
    const kept = store ? await store.get(NS, KEY).catch(() => null) : null
    if (kept?.icons && t - kept.at < DAY) return (mem = kept)
    const icons = await lookup()
    if (Object.keys(icons).length) {
      mem = { icons, at: t }
      if (store) await store.set(NS, KEY, mem).catch(() => {})
      return mem
    }
    // Apple didn't answer: what we had (or nothing, and the shipped icons), and another try in an hour
    mem = { icons: kept?.icons || {}, at: t - DAY + RETRY }
    return mem
  }

  /** { icons: { key: url }, at } */
  async function get() {
    if (mem && now() - mem.at < DAY) return mem
    if (!pending) pending = refresh().finally(() => (pending = null))
    return pending
  }

  return { get }
}

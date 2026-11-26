// A page opened from the browser's cache can be an older build than the site's: Firebase lets a
// browser keep a page like /login for up to an hour. Once a visit, look at the site's current
// page, and when it names a newer build, load that instead, so a new version (the setup after
// signing up, say) shows straight away rather than an hour later.
const KEY = 'apex_fresh_build'
const BUILD = /\/assets\/index-[\w-]+\.js/

/** The build a page loads ("/assets/index-Dk8LUMt2.js"), from its HTML. */
export function buildOf(html) {
  return BUILD.exec(String(html || ''))?.[0] || null
}

/** Reloads onto the site's current build when this page is an older one (once per build a visit). */
export async function freshen({ doc = document, fetchImpl = fetch, store = sessionStorage, reload = () => window.location.reload() } = {}) {
  try {
    // the build this page is running; none on the dev server or in the iPhone app's own copy
    const mine = [...doc.scripts].map((s) => s.src || '').find((s) => BUILD.test(s))
    if (!mine) return false
    const res = await fetchImpl('/index.html', { cache: 'no-store' })
    if (!res.ok) return false
    const current = buildOf(await res.text())
    if (!current || mine.endsWith(current) || store.getItem(KEY) === current) return false
    store.setItem(KEY, current)
    reload()
    return true
  } catch {
    return false
  }
}

// Link previews for picks pages. When someone shares apex.../u/handle on X or in a group
// chat, the card shows their name and record instead of the generic site title. The page
// itself is the normal single-page app; only the <head> tags change.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function recordLine(r) {
  if (!r || !r.graded) return null
  const u = `${r.units > 0 ? '+' : ''}${r.units}u`
  return `${r.wins}-${r.losses}${r.pushes ? `-${r.pushes}` : ''}, ${u}`
}

/** html: the built index.html. view: picks.page() output. origin: https://site */
export function renderUserHead(html, view, origin) {
  const p = view.profile
  const d30 = recordLine(p.record?.d30)
  const all = recordLine(p.record?.all)
  const title = `${p.name} (@${p.handle}) on APEX`
  const parts = [d30 ? `Last 30 days: ${d30}.` : null, all && all !== d30 ? `All time: ${all}.` : null, p.bio || null, 'Every pick posted before kickoff and graded from the box score.']
  const desc = parts.filter(Boolean).join(' ').slice(0, 280)
  const url = `${origin}/u/${p.handle}`
  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="profile" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(`${origin}/logo.png`)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`,
    ...(p.x ? [`<meta name="twitter:creator" content="@${esc(p.x)}" />`] : []),
  ].join('\n    ')
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+(name|property)="(description|og:[a-z:]+|twitter:[a-z:]+)"[^>]*>\s*/gi, '')
    .replace(/<head>/i, `<head>\n    ${tags}`)
}

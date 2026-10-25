// Game intel: the official injury report plus what reputable outlets are reporting this week
// (practice participation, role changes, game-plan notes coaches said in public), read by the AI
// with web search limited to established news sources, then tied back to the APEX props it moves.
//
// Public reporting only. The prompt rules out leaked, confidential or insider material, anonymous
// social posts and betting touts, and every item has to carry the link it came from.
import Anthropic from '@anthropic-ai/sdk'
import { nameKey } from '../lib/util.js'
import { log, errText } from '../lib/log.js'

const MODEL = () => process.env.ANTHROPIC_INTEL_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'

/** Established outlets and the league's own sites. Search results outside these are not used. */
export const INTEL_DOMAINS = [
  'espn.com',
  'nfl.com',
  'apnews.com',
  'reuters.com',
  'theathletic.com',
  'nytimes.com',
  'cbssports.com',
  'nbcsports.com',
  'foxsports.com',
  'si.com',
  'usatoday.com',
  'yahoo.com',
  'profootballtalk.nbcsports.com',
  'pro-football-reference.com',
  'rotowire.com',
  'fantasypros.com',
  'theringer.com',
  'washingtonpost.com',
  'latimes.com',
  'bostonglobe.com',
  'chicagotribune.com',
  'freep.com',
  'detroitnews.com',
  'dallasnews.com',
  'nj.com',
  'philly.com',
  'inquirer.com',
  'seattletimes.com',
  'sfchronicle.com',
  'denverpost.com',
  'miamiherald.com',
  'tampabay.com',
  'ajc.com',
  'startribune.com',
  'jsonline.com',
  'cleveland.com',
  'pittsburghpostgazette.com',
  'post-gazette.com',
  'baltimoresun.com',
  'houstonchronicle.com',
  'kansascity.com',
  'azcentral.com',
  'tennessean.com',
  'indystar.com',
  'buffalonews.com',
  'charlotteobserver.com',
  'nola.com',
  'jacksonville.com',
  'reviewjournal.com',
  'sandiegouniontribune.com',
  'nydailynews.com',
  'newsday.com',
]

const allowedUrl = (u) => {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '')
    return h.endsWith('.com') && (INTEL_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`)) || /\.(nfl|clubs)\.com$/.test(h))
  } catch {
    return false
  }
}

export const INTEL_SYSTEM = `You are APEX Intel. You brief NFL bettors on what changed this week for ONE game, using web search.

Sources: only established news outlets, the NFL's and the teams' own sites, and the official injury report. Use ONLY public, on-the-record reporting: injury reports, practice participation, coach and player press conferences, depth chart moves, reported role or snap-share changes, weather, and game-plan comments coaches or coordinators made publicly.
Never use or repeat leaked, stolen, confidential or "insider" material, private team documents, anonymous social media accounts, betting touts or rumors with no named outlet. If something is only rumored, leave it out.

Search efficiently: the team names with "injury report", "practice", "depth chart", "press conference" for this week.

Reply with JSON only, no prose before or after, in this shape:
{
 "summary": "two plain sentences: the biggest things a bettor should know for this game",
 "injuries": [{"player":"Full Name","team":"ABR","status":"Out|Doubtful|Questionable|Limited|Full|IR|Probable","note":"what it is and what it means, under 20 words","url":"source link"}],
 "news": [{"headline":"short headline","team":"ABR","detail":"one or two sentences, what was reported and by whom","impact":"up|down|neutral","players":["Full Name"],"url":"source link","date":"YYYY-MM-DD"}],
 "angles": [{"player":"Full Name","lean":"boost|hurt","why":"how the news moves his props, under 25 words"}]
}
Up to 8 injuries, 6 news items and 6 angles; skip anything without a source link. "impact" is for the named players' production. Plain words a casual bettor understands.`

function parseJsonLoose(text) {
  const s = String(text || '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
}

const str = (v, n) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n))

/** What APEX already knows about the game, so the model looks for what's new. */
export function intelBrief(data) {
  const g = data.game
  const side = (s) => `${s.team.name} (${s.team.abbr}${s.team.record ? `, ${s.team.record}` : ''}). Official injury list: ${s.injuries.length ? s.injuries.map((i) => `${i.name || i.athleteName || i.athleteId} ${i.status}`).join(', ') : 'none listed'}.`
  const props = (data.props || []).slice(0, 10).map((p) => `${p.name} ${p.label} (APEX ${(p.prob * 100).toFixed(0)}%)`)
  return [
    `GAME: ${g.away?.name} at ${g.home?.name}, kickoff ${g.date}.`,
    data.venue ? `VENUE: ${typeof data.venue === 'string' ? data.venue : data.venue.name || ''}` : '',
    `AWAY: ${side(data.away)}`,
    `HOME: ${side(data.home)}`,
    props.length ? `TOP APEX PROPS: ${props.join('; ')}` : '',
    `TODAY: ${new Date().toISOString().slice(0, 10)}. Find this week's reporting for this game.`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Tie the players the model names back to the board: player page links and their best props. */
export function linkPlayers(out, data) {
  const byName = new Map()
  for (const p of data.props || []) {
    const k = nameKey(p.name)
    if (!byName.has(k)) byName.set(k, { playerId: p.playerId, props: [] })
    byName.get(k).props.push({ id: p.id, label: p.shortLabel || p.label, prob: p.prob, side: p.side })
  }
  // news that helps a player points at his overs, news that hurts at his unders
  const link = (name, lean) => {
    const hit = byName.get(nameKey(name))
    if (!hit) return { playerId: null, props: [] }
    const want = lean === 'hurt' ? 'u' : lean === 'boost' ? 'o' : null
    const fit = want ? hit.props.filter((p) => p.side === want) : hit.props
    return { playerId: hit.playerId, props: (fit.length ? fit : hit.props).slice(0, 3) }
  }
  return {
    ...out,
    injuries: out.injuries.map((i) => ({ ...i, ...link(i.player) })),
    angles: out.angles.map((a) => ({ ...a, ...link(a.player, a.lean) })),
  }
}

/** Clean what the model returned: types, lengths, and only links from allowed outlets. */
export function cleanIntel(json, citations = []) {
  const okUrl = (u) => (u && allowedUrl(u) ? String(u).slice(0, 400) : null)
  const injuries = (Array.isArray(json?.injuries) ? json.injuries : [])
    .slice(0, 8)
    .map((i) => ({ player: str(i.player, 60), team: str(i.team, 4).toUpperCase(), status: str(i.status, 16), note: str(i.note, 200), url: okUrl(i.url) }))
    .filter((i) => i.player && i.status)
  const news = (Array.isArray(json?.news) ? json.news : [])
    .slice(0, 6)
    .map((n) => ({ headline: str(n.headline, 120), team: str(n.team, 4).toUpperCase(), detail: str(n.detail, 400), impact: ['up', 'down', 'neutral'].includes(n.impact) ? n.impact : 'neutral', players: (Array.isArray(n.players) ? n.players : []).slice(0, 4).map((p) => str(p, 60)), url: okUrl(n.url), date: /^\d{4}-\d{2}-\d{2}$/.test(String(n.date || '')) ? n.date : null }))
    .filter((n) => n.headline && n.url)
  const angles = (Array.isArray(json?.angles) ? json.angles : [])
    .slice(0, 6)
    .map((a) => ({ player: str(a.player, 60), lean: a.lean === 'hurt' ? 'hurt' : 'boost', why: str(a.why, 220) }))
    .filter((a) => a.player && a.why)
  const seen = new Set()
  const sources = []
  for (const c of citations) {
    if (!c?.url || !allowedUrl(c.url) || seen.has(c.url)) continue
    seen.add(c.url)
    sources.push({ title: str(c.title, 140) || new URL(c.url).hostname, url: c.url })
    if (sources.length >= 12) break
  }
  return { summary: str(json?.summary, 400), injuries, news, angles, sources }
}

/**
 * One shared scan per game, cached: everyone looking at the game sees the same brief and the
 * searches are paid for once. Fresher close to kickoff.
 */
export function createIntel({ engine, apiKey, now = () => Date.now() }) {
  const cache = new Map() // gameId -> { at, data }
  const inflight = new Map()
  const ttl = (kick) => {
    const until = new Date(kick).getTime() - now()
    return until < 6 * 3600e3 ? 30 * 60e3 : until < 48 * 3600e3 ? 2 * 3600e3 : 6 * 3600e3
  }

  function cachedFor(gameId) {
    const hit = cache.get(gameId)
    if (!hit) return null
    const data = engine.views.game(gameId)
    if (!data) return null
    return now() - hit.at < ttl(data.game.date) ? hit : null
  }

  async function scan(gameId) {
    const key = typeof apiKey === 'function' ? apiKey() : apiKey
    const data = engine.views.game(gameId)
    if (!data) return null
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(10, Math.max(2, Number(process.env.APEX_INTEL_SEARCHES) || 6)), allowed_domains: INTEL_DOMAINS }]
    const msg = await new Anthropic({ apiKey: key }).messages.create({ model: MODEL(), max_tokens: 2500, system: INTEL_SYSTEM, tools, messages: [{ role: 'user', content: intelBrief(data) }] })
    const blocks = msg?.content || []
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const citations = []
    for (const b of blocks) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r?.url) citations.push({ url: r.url, title: r.title })
      if (b.type === 'text' && Array.isArray(b.citations)) for (const c of b.citations) if (c?.url) citations.push({ url: c.url, title: c.title })
    }
    const json = parseJsonLoose(text)
    if (!json) throw new Error('intel: no JSON in reply')
    const out = linkPlayers(cleanIntel(json, citations), data)
    for (const n of out.news) if (n.url && !out.sources.some((s) => s.url === n.url)) out.sources.push({ title: n.headline, url: n.url })
    const entry = { at: now(), data: { ...out, gameId, model: MODEL() } }
    cache.set(gameId, entry)
    if (cache.size > 64) cache.delete(cache.keys().next().value)
    return entry
  }

  return {
    cachedFor,
    /** { at, data } | null. Joins a scan already running for the same game. */
    async get(gameId, { fresh = false } = {}) {
      if (!fresh) {
        const hit = cachedFor(gameId)
        if (hit) return { ...hit, cached: true }
      }
      if (inflight.has(gameId)) return { ...(await inflight.get(gameId)), cached: true }
      const p = scan(gameId).finally(() => inflight.delete(gameId))
      inflight.set(gameId, p)
      try {
        const e = await p
        return e && { ...e, cached: false }
      } catch (e) {
        log.warn('intel scan failed', { gameId, err: errText(e) })
        throw e
      }
    },
  }
}

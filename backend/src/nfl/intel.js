// Game intel: the official injury report plus what reputable outlets are reporting this week
// (practice participation, role changes, game-plan notes coaches said in public), read by the AI
// with web search limited to established news sources, then tied back to the Propify props it moves.
//
// Public reporting only. The prompt rules out leaked, confidential or insider material, anonymous
// social posts and betting touts, and every item has to carry the link it came from.
import { nameKey } from '../lib/util.js'
import { log, errText } from '../lib/log.js'
import { createShared } from '../ai/shared.js'
import { dayET } from './proplog.js'

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

export const intelSystem = (sport = { title: 'NFL', calendar: 'week' }) => `You are Propify Intel. You brief ${sport.title} bettors on what changed ${sport.calendar === 'day' ? 'since the last game' : 'this week'} for ONE game, using web search.

Sources: only established news outlets, the league's and the teams' own sites, and the official injury report. Use ONLY public, on-the-record reporting: injury reports, practice participation, coach and player press conferences, depth chart moves, reported role or snap-share changes, weather, and game-plan comments coaches or coordinators made publicly.
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
export const INTEL_SYSTEM = intelSystem()

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

/** What Propify already knows about the game, so the model looks for what's new. */
export function intelBrief(data) {
  const g = data.game
  const side = (s) => `${s.team.name} (${s.team.abbr}${s.team.record ? `, ${s.team.record}` : ''}). Official injury list: ${s.injuries.length ? s.injuries.map((i) => `${i.name || i.athleteName || i.athleteId} ${i.status}`).join(', ') : 'none listed'}.`
  const props = (data.props || []).slice(0, 10).map((p) => `${p.name} ${p.label} (Propify ${(p.prob * 100).toFixed(0)}%)`)
  return [
    `GAME: ${g.away?.name} at ${g.home?.name}, kickoff ${g.date}.`,
    data.venue ? `VENUE: ${typeof data.venue === 'string' ? data.venue : data.venue.name || ''}` : '',
    `AWAY: ${side(data.away)}`,
    `HOME: ${side(data.home)}`,
    props.length ? `TOP PROPIFY PROPS: ${props.join('; ')}` : '',
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
 * One scan per game per day, shared by every member and every server: the brief and its web
 * searches are paid for once, and everyone opening the game that day sees the same one. Only
 * the admin can ask for a rescan.
 */
export function createIntel({ engine, ai, store = null, now = () => Date.now() }) {
  const mem = new Map() // key -> { at, data }
  const inflight = new Map()
  const shared = createShared({ store, ns: `ai-intel-${engine.sport?.key || 'nfl'}`, ready: (v) => Boolean(v?.data) })
  const keyOf = (gameId) => `${gameId}:${dayET(now())}`

  /** Today's scan for the game, from this server or the store, or null. */
  async function cachedFor(gameId) {
    if (!engine.views.game(gameId)) return null
    const key = keyOf(gameId)
    const hit = mem.get(key)
    if (hit) return hit
    const v = await shared.get(key)
    if (!v) return null
    const entry = { at: v.at, data: v.data }
    mem.set(key, entry)
    if (mem.size > 128) mem.delete(mem.keys().next().value)
    return entry
  }

  async function scan(gameId) {
    const data = engine.views.game(gameId)
    if (!data) return null
    // web search held to the established outlets above
    const webSearch = { maxUses: Math.min(10, Math.max(2, Number(process.env.APEX_INTEL_SEARCHES) || 6)), domains: INTEL_DOMAINS }
    const reply = await ai.complete({ feature: 'intel', system: intelSystem(engine.sport), messages: [{ role: 'user', content: intelBrief(data) }], maxTokens: 2500, webSearch })
    const json = parseJsonLoose(reply.text)
    if (!json) throw new Error('intel: no JSON in reply')
    const out = linkPlayers(cleanIntel(json, reply.citations || []), data)
    for (const n of out.news) if (n.url && !out.sources.some((s) => s.url === n.url)) out.sources.push({ title: n.headline, url: n.url })
    const entry = { at: now(), data: { ...out, gameId, model: reply.model || ai.model('intel') } }
    const key = keyOf(gameId)
    mem.set(key, entry)
    if (mem.size > 128) mem.delete(mem.keys().next().value)
    await shared.save(key, entry).catch((e) => log.warn('saving game intel failed', { gameId, err: errText(e) }))
    return entry
  }

  return {
    cachedFor,
    /**
     * { at, data, cached } | null. Joins a scan already running for the same game, here or on
     * another server. `fresh` (the admin's rescan) writes over today's.
     */
    async get(gameId, { fresh = false } = {}) {
      if (!fresh) {
        const hit = await cachedFor(gameId)
        if (hit) return { ...hit, cached: true }
      }
      const key = keyOf(gameId)
      if (inflight.has(key)) return { ...(await inflight.get(key)), cached: true }
      const run = async () => {
        const c = fresh ? { mine: null } : await shared.claim(key)
        if (c.stored) return { at: c.stored.at, data: c.stored.data, joined: true }
        if (c.wait) {
          const v = await shared.waitFor(key)
          if (v) return { at: v.at, data: v.data, joined: true }
          throw new Error('intel: the scan running elsewhere did not finish')
        }
        try {
          return await scan(gameId)
        } finally {
          if (c.mine) await shared.release(key, c.mine)
        }
      }
      const p = run().finally(() => inflight.delete(key))
      inflight.set(key, p)
      try {
        const e = await p
        return e && { at: e.at, data: e.data, cached: Boolean(e.joined) }
      } catch (e) {
        log.warn('intel scan failed', { gameId, err: errText(e) })
        throw e
      }
    },
  }
}

// Live signals: in-game value candidates on props, from what's happening in the game. A prop is
// flagged only when its live projection is well past the pre-game line AND the player's usage
// backs it (more minutes, attempts or carries than usual), with enough of the game played to mean
// something and enough left to matter. Notes are templates filled with real numbers, worded as a
// "signal" and a "candidate", never a sure thing. Every candidate is kept from the moment it was
// flagged and graded from the final box score, and the record is public.

const r1 = (x) => Math.round(x * 10) / 10
const FAMILY = { nfl: 'football', ncaaf: 'football', nba: 'basketball', wnba: 'basketball', ncaab: 'basketball', nhl: 'hockey' }
const USAGE_KEY = {
  football: { passYds: 'passAtt', passCmp: 'passAtt', passTd: 'passAtt', longPass: 'passAtt', rushYds: 'rushAtt', longRush: 'rushAtt', recYds: 'rec', longRec: 'rec', rushRecYds: 'rushAtt' },
  basketball: '*min',
  hockey: '*toi',
}
const USAGE_WORD = { passAtt: 'pass attempts', rushAtt: 'carries', rec: 'catches', min: 'minutes', toi: 'minutes on ice' }
const WATCH = {
  football: 'a lead that slows the game down or a shift away from him',
  basketball: 'foul trouble or a blowout that sends starters to the bench',
  hockey: 'a lead that slows the shooting',
}
// how big a gap, how much usage, and how much game: below these it's noise
export const RULES = { gap: 0.15, usageUp: 1.2, usageDown: 0.8, from: 0.2, to: 0.75 }

const num = (v) => {
  if (Number.isFinite(Number(v))) return Number(v)
  const m = /^(\d+):(\d{2})$/.exec(String(v || ''))
  return m ? Number(m[1]) + Number(m[2]) / 60 : null
}
export function usageKey(sport, market) {
  const u = USAGE_KEY[FAMILY[sport]]
  if (!u) return null
  if (typeof u === 'string') return u.slice(1)
  return u[market] || null
}

/**
 * One prop, mid-game: is it a candidate? p: the board card with its live progress
 * ({ cur, elapsed, ... }); box: the player's stats so far; history: his recent games' stats.
 * Returns the signal, or null.
 */
export function signalFor({ p, box, history = [], sport, clockText = '' }) {
  const live = p.live
  if (!live || live.final || p.kind === 'team') return null
  const e = live.elapsed
  if (!(e >= RULES.from && e <= RULES.to)) return null
  const fam = FAMILY[sport]
  // the pace so far, leaning on it more as the game goes on, the pre-game projection less
  const pre = Number.isFinite(p.proj) ? p.proj : p.line
  const rateLive = live.cur / e
  const rest = e * rateLive + (1 - e) * pre
  const projected = live.cur + (1 - e) * rest
  const gap = (projected - p.line) / Math.max(1, p.line)
  if (Math.abs(gap) < RULES.gap) return null
  const side = gap > 0 ? 'o' : 'u'
  // usage: this game's pace of minutes/attempts/carries against his recent average
  const key = usageKey(sport, p.market)
  let usage = null
  if (key && box && num(box[key]) != null) {
    const past = history.map((h) => num(h?.s?.[key])).filter((x) => x != null && x > 0).slice(-10)
    if (past.length >= 3) {
      const avg = past.reduce((a, b) => a + b, 0) / past.length
      const so = num(box[key])
      usage = { key, word: USAGE_WORD[key] || key, so: r1(so), pace: r1(so / e), avg: r1(avg), ratio: Math.round((so / e / avg) * 100) / 100 }
    }
  }
  // the usage has to back the direction; without usage numbers, ask for a bigger gap and more game
  if (usage) {
    if (side === 'o' && usage.ratio < RULES.usageUp) return null
    if (side === 'u' && usage.ratio > RULES.usageDown) return null
  } else if (Math.abs(gap) < RULES.gap * 1.7 || e < 0.35) return null
  const stat = String(p.label || '').replace(/^(over|under)\s+[\d.]+\s+/i, '').toLowerCase() || 'of the stat'
  const proj = r1(projected)
  const usageText = usage ? `${usage.so} ${usage.word} so far, a pace of ${usage.pace} against his recent ${usage.avg} a game` : null
  const signal = side === 'o' ? (usage ? `${usage.word} well above his usual` : 'pace well above the line') : usage ? `${usage.word} well below his usual` : 'pace well below the line'
  const note = [
    `${p.short || p.name} ${side === 'o' ? 'over' : 'under'} ${p.line} ${stat}${clockText ? `, ${clockText}` : ''}: ${live.cur} so far, on pace for about ${proj}.`,
    usageText ? `${usageText[0].toUpperCase()}${usageText.slice(1)}.` : null,
    `Signal: ${signal}. A candidate against the pre-game line of ${p.line}; live lines move, so check the price you’d get.`,
    `Watch for ${WATCH[fam] || 'a change in his role'}.`,
  ]
    .filter(Boolean)
    .join(' ')
  return { id: p.id, gameId: String(p.gameId), playerId: p.playerId ? String(p.playerId) : null, name: p.name, short: p.short || p.name, headshot: p.headshot || null, market: p.market, label: p.label, line: p.line, side, cur: live.cur, projected: proj, gap: Math.round(gap * 1000) / 1000, elapsed: live.elapsed, usage, note, clock: clockText }
}

/** A flagged candidate's grade from the final number. */
export function gradeSignal(sig, finalValue) {
  if (!Number.isFinite(finalValue)) return null
  if (finalValue === sig.line) return 'push'
  const over = finalValue > sig.line
  return (sig.side === 'o') === over ? 'hit' : 'miss'
}

export function createSignals({ engine, store, now = () => Date.now() }) {
  const sport = engine.sport?.key || 'nfl'
  const NS = `signals-${sport}`
  const day = (t) => new Date(t).toISOString().slice(0, 10)

  /** Every live candidate right now, built from the live games on the board. */
  function current() {
    const v = engine.views
    const out = []
    const lv = v.live()
    for (const g of lv.games || []) {
      if (!g || g.status?.state !== 'in') continue
      const s = engine.wh.summaries.get(String(g.id))?.data || null
      const clockText = g.status?.text || g.status?.short || ''
      for (const p of g.props || []) {
        if (!p.playerId) continue
        const box = s?.players?.[p.playerId]?.stats || null
        const sig = signalFor({ p, box, history: engine.wh.logs.get(String(p.playerId)) || [], sport, clockText })
        if (sig) out.push(sig)
      }
    }
    // one per player and stat: the strongest side
    const best = new Map()
    for (const x of out) {
      const k = `${x.playerId}.${x.market}`
      if (!best.has(k) || Math.abs(x.gap) > Math.abs(best.get(k).gap)) best.set(k, x)
    }
    return [...best.values()].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 30)
  }

  /** Keep each candidate from the moment it was first flagged (later looks don't move it). */
  async function remember(list, t = now()) {
    if (!list.length) return
    await store.update(NS, day(t), (cur) => {
      const doc = cur || { day: day(t), sport, items: {} }
      let changed = false
      for (const x of list) {
        const k = `${x.gameId}:${x.playerId}:${x.market}:${x.side}`
        if (doc.items[k]) continue
        doc.items[k] = { ...x, at: t, result: null, final: null }
        changed = true
      }
      return changed ? doc : undefined
    })
  }

  /** Grade candidates whose games are final, from the stored summary. */
  async function grade(t = now()) {
    for (const d of [day(t), day(t - 86_400_000), day(t - 2 * 86_400_000)]) {
      const doc = await store.get(NS, d)
      if (!doc) continue
      const open = Object.entries(doc.items).filter(([, x]) => !x.result)
      if (!open.length) continue
      const grades = {}
      for (const [k, x] of open) {
        const g = engine.wh.games.get(x.gameId)
        if (g?.status?.state !== 'post') continue
        const s = engine.wh.summaries.get(x.gameId)?.data
        const stats = s?.players?.[x.playerId]?.stats
        const mk = engine.sport?.fam?.MARKETS?.[x.market]
        const val = stats && mk?.stat ? mk.stat(stats) : null
        const res = gradeSignal(x, val)
        if (res) grades[k] = { result: res, final: val }
      }
      if (Object.keys(grades).length) {
        await store.update(NS, d, (cur) => {
          if (!cur) return undefined
          for (const [k, g] of Object.entries(grades)) if (cur.items[k] && !cur.items[k].result) cur.items[k] = { ...cur.items[k], ...g, gradedAt: t }
          return cur
        })
      }
    }
  }

  /** The public record: every graded candidate, by result, over the last 30 days. */
  async function record(days = 30) {
    const t = now()
    let hit = 0
    let miss = 0
    let push = 0
    let open = 0
    const recent = []
    for (let i = 0; i < days; i++) {
      const doc = await store.get(NS, day(t - i * 86_400_000))
      if (!doc) continue
      for (const x of Object.values(doc.items)) {
        if (x.result === 'hit') hit++
        else if (x.result === 'miss') miss++
        else if (x.result === 'push') push++
        else open++
        if (x.result && recent.length < 20) recent.push({ short: x.short, label: x.label, side: x.side, line: x.line, final: x.final, result: x.result, at: x.at })
      }
    }
    return { days, hit, miss, push, open, rate: hit + miss ? Math.round((hit / (hit + miss)) * 1000) / 1000 : null, recent }
  }

  /** What the live page asks for: the candidates now (kept and graded as it goes), and the record. */
  async function view() {
    const list = current()
    await remember(list).catch(() => {})
    await grade().catch(() => {})
    return { sport, at: now(), live: list, record: await record(), rules: RULES }
  }

  return { current, view, record, grade }
}

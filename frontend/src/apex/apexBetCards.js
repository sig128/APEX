/**
 * @typedef {'main' | 'alt'} ApexLineKind
 *
 * @typedef {{
 *   singleLegLock: string,
 *   twoLegParlay: string[],
 *   threeLegParlay: string[],
 *   quickReasoning: {
 *     singleLegLock: string,
 *     twoLegParlay: string,
 *     threeLegParlay: string,
 *   },
 *   lineSource?: {
 *     singleLegLock: ApexLineKind,
 *     twoLegParlay: ApexLineKind[],
 *     threeLegParlay: ApexLineKind[],
 *   }
 * }} ApexBetCards
 */

/** Markers must match compact prompt + streamChat user message (backend/functions). */
const START = '<<<APEX_BET_CARDS_JSON>>>'
const END = '<<<END_APEX_BET_CARDS_JSON>>>'

/**
 * @param {unknown} v
 * @returns {ApexLineKind}
 */
function normalizeLineKind(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return s === 'alt' ? 'alt' : 'main'
}

/**
 * @param {Record<string, unknown>} o
 * @param {string[]} twoLegParlay
 * @param {string[]} threeLegParlay
 * @param {boolean} hasSingle
 * @returns {ApexBetCards['lineSource'] | undefined}
 */
function parseLineSource(o, twoLegParlay, threeLegParlay, hasSingle) {
  const raw = o.lineSource
  if (!raw || typeof raw !== 'object') return undefined
  const ls = /** @type {Record<string, unknown>} */ (raw)

  const singleLegLock = hasSingle ? normalizeLineKind(ls.singleLegLock) : 'main'
  const twoArr = Array.isArray(ls.twoLegParlay) ? ls.twoLegParlay.map(normalizeLineKind) : []
  const threeArr = Array.isArray(ls.threeLegParlay) ? ls.threeLegParlay.map(normalizeLineKind) : []

  const twoLeg = twoLegParlay.map((_, i) => twoArr[i] || 'main')
  const threeLeg = threeLegParlay.map((_, i) => threeArr[i] || 'main')

  const anyAlt =
    singleLegLock === 'alt' ||
    twoLeg.some((x) => x === 'alt') ||
    threeLeg.some((x) => x === 'alt')
  if (!anyAlt) return undefined

  return {
    singleLegLock: hasSingle ? singleLegLock : 'main',
    twoLegParlay: twoLeg,
    threeLegParlay: threeLeg,
  }
}

/**
 * @param {string} kind
 * @returns {string}
 */
export function apexBetCardLineTagHtml(kind) {
  if (kind !== 'alt') return ''
  return `<span class="apex-bet-card-line-tag" title="Alternative line (not the book’s default main number)">Alt line</span>`
}

/**
 * @param {string} content
 * @returns {{ stripped: string, cards: ApexBetCards | null }}
 */
export function stripBetCardsBlockAndParse(content) {
  if (typeof content !== 'string' || !content) {
    return { stripped: '', cards: null }
  }
  const re = new RegExp(
    `${escapeRe(START)}\\s*([\\s\\S]*?)\\s*${escapeRe(END)}`,
    'i',
  )
  const m = content.match(re)
  const stripped = m ? content.replace(re, '').trim() : content.trim()
  if (!m) return { stripped, cards: null }
  let parsed
  try {
    parsed = JSON.parse(m[1].trim())
  } catch {
    return { stripped, cards: null }
  }
  return { stripped, cards: normalizeBetCardsPayload(parsed) }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalize bet cards from API / Firestore / model JSON (shared with persistence).
 * @param {unknown} raw
 * @returns {ApexBetCards | null}
 */
export function normalizeBetCardsPayload(raw) {
  if (!raw || typeof raw !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (raw)
  const singleLegLock =
    typeof o.singleLegLock === 'string' ? o.singleLegLock.trim() : ''
  const twoLegParlay = Array.isArray(o.twoLegParlay)
    ? o.twoLegParlay.map((x) => String(x).trim()).filter(Boolean)
    : []
  const threeLegParlay = Array.isArray(o.threeLegParlay)
    ? o.threeLegParlay.map((x) => String(x).trim()).filter(Boolean)
    : []
  const qrRaw =
    o.quickReasoning && typeof o.quickReasoning === 'object'
      ? /** @type {Record<string, unknown>} */ (o.quickReasoning)
      : {}
  const quickReasoning = {
    singleLegLock:
      typeof qrRaw.singleLegLock === 'string' ? qrRaw.singleLegLock.trim() : '',
    twoLegParlay:
      typeof qrRaw.twoLegParlay === 'string' ? qrRaw.twoLegParlay.trim() : '',
    threeLegParlay:
      typeof qrRaw.threeLegParlay === 'string' ? qrRaw.threeLegParlay.trim() : '',
  }
  if (!singleLegLock && twoLegParlay.length === 0 && threeLegParlay.length === 0) {
    return null
  }
  const lineSource = parseLineSource(o, twoLegParlay, threeLegParlay, Boolean(singleLegLock))
  /** @type {ApexBetCards} */
  const out = { singleLegLock, twoLegParlay, threeLegParlay, quickReasoning }
  if (lineSource) out.lineSource = lineSource
  return out
}

/**
 * @param {HTMLElement} root
 * @param {ApexBetCards | null} cards
 */
export function mountApexBetCards(root, cards) {
  const el = root.querySelector('#apex-bet-cards')
  if (!el) return
  mountApexBetCardsInto(el, cards)
}

/**
 * @param {HTMLElement} el
 * @param {ApexBetCards | null} cards
 */
export function mountApexBetCardsInto(el, cards) {
  if (!el) return
  if (!cards) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

  const ls = cards.lineSource

  const legRow = (label, text, lineKind) => {
    const tag = apexBetCardLineTagHtml(lineKind)
    return `<li class="apex-bet-card-leg"><span class="apex-bet-card-leg-l">${esc(label)}</span>${tag}<span class="apex-bet-card-leg-t">${esc(text)}</span></li>`
  }

  let twoHtml = ''
  if (cards.twoLegParlay.length >= 1) {
    twoHtml = '<ul class="apex-bet-card-legs">'
    cards.twoLegParlay.slice(0, 2).forEach((leg, i) => {
      const kind = ls?.twoLegParlay?.[i] || 'main'
      twoHtml += legRow(`Leg ${i + 1}`, leg, kind)
    })
    twoHtml += '</ul>'
  }

  let threeHtml = ''
  if (cards.threeLegParlay.length >= 1) {
    threeHtml = '<ul class="apex-bet-card-legs">'
    cards.threeLegParlay.slice(0, 3).forEach((leg, i) => {
      const kind = ls?.threeLegParlay?.[i] || 'main'
      threeHtml += legRow(`Leg ${i + 1}`, leg, kind)
    })
    threeHtml += '</ul>'
  }

  const singleKind = ls?.singleLegLock || 'main'
  const singleTag = apexBetCardLineTagHtml(singleKind)

  el.hidden = false
  el.innerHTML = `
    <div class="apex-bet-cards-inner">
      <article class="apex-bet-card apex-bet-card--single" aria-labelledby="apex-bet-single-title">
        <h3 class="apex-bet-card-title" id="apex-bet-single-title">Single leg lock</h3>
        <p class="apex-bet-card-body">${singleTag}<span class="apex-bet-card-body-text">${esc(cards.singleLegLock || '—')}</span></p>
      </article>
      <article class="apex-bet-card apex-bet-card--2" aria-labelledby="apex-bet-2-title">
        <h3 class="apex-bet-card-title" id="apex-bet-2-title">2-leg parlay</h3>
        ${twoHtml || '<p class="apex-bet-card-body apex-bet-card-body--empty">—</p>'}
      </article>
      <article class="apex-bet-card apex-bet-card--3" aria-labelledby="apex-bet-3-title">
        <h3 class="apex-bet-card-title" id="apex-bet-3-title">3-leg parlay</h3>
        ${threeHtml || '<p class="apex-bet-card-body apex-bet-card-body--empty">—</p>'}
      </article>
    </div>
  `
}

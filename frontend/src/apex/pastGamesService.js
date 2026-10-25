import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { normalizeBetCardsPayload } from './apexBetCards.js'
import { db } from '../firebase.js'

export const PAST_GAMES_COLLECTION = 'pastGames'

/**
 * @param {unknown} betCards
 * @returns {import('./apexBetCards.js').ApexBetCards | null}
 */
// Field limits match firestore.rules (saves outside them are refused there).
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

function sanitizeBetCards(betCards) {
  const normalized = normalizeBetCardsPayload(betCards)
  if (!normalized) return null
  const q = normalized.quickReasoning || {}
  return {
    singleLegLock: clip(normalized.singleLegLock, 600),
    twoLegParlay: normalized.twoLegParlay.slice(0, 2).map((x) => clip(x, 600)),
    threeLegParlay: normalized.threeLegParlay.slice(0, 3).map((x) => clip(x, 600)),
    quickReasoning: { singleLegLock: clip(q.singleLegLock, 2000), twoLegParlay: clip(q.twoLegParlay, 2000), threeLegParlay: clip(q.threeLegParlay, 2000) },
    ...(normalized.lineSource ? { lineSource: clip(normalized.lineSource, 200) } : {}),
  }
}

/**
 * @param {object} game
 * @returns {Record<string, string>}
 */
const GAME_FIELDS = { homeTeam: 80, awayTeam: 80, date: 40, gameTime: 40, stadium: 120, homeStarter: 80, awayStarter: 80, bankroll: 40, mlOdds: 80, totalOu: 80, context: 4000, sportKey: 60, oddsEventId: 64, commenceTimeIso: 40 }

function sanitizeGameForStore(game) {
  if (!game || typeof game !== 'object') return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const [k, v] of Object.entries(game)) {
    if (v === undefined || v === null || !(k in GAME_FIELDS)) continue
    out[k] = (typeof v === 'string' ? v : String(v)).slice(0, GAME_FIELDS[k])
  }
  return out
}

/**
 * @param {Array<{ role: string, content: string }>} messages
 */
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : '',
  }))
}

/**
 * @param {string} userId
 * @param {{ game: object, betCards: unknown }} payload
 * @returns {Promise<string>} new document id
 */
const QUOTA_COLLECTION = 'pastGamesQuota'
const SAVES_PER_DAY = 60
const DAY_MS = 86_400_000

/** Each save also bumps the user's daily counter, in the same batch (firestore.rules checks it). */
export async function createPastGame(userId, { game, betCards }) {
  if (!db) throw new Error('Firestore is not configured.')
  const g = sanitizeGameForStore(game)
  const bets = sanitizeBetCards(betCards)
  const qref = doc(db, QUOTA_COLLECTION, userId)
  const snap = await getDoc(qref)
  const cur = snap.exists() ? snap.data() : null
  const started = cur?.windowStart?.toMillis?.() ?? 0
  const save = async (fresh) => {
    const ref = doc(collection(db, PAST_GAMES_COLLECTION))
    const batch = writeBatch(db)
    batch.set(qref, fresh ? { windowStart: serverTimestamp(), n: 1 } : { windowStart: cur.windowStart, n: (cur.n || 0) + 1 })
    batch.set(ref, {
      userId,
      homeTeam: g.homeTeam ?? '',
      awayTeam: g.awayTeam ?? '',
      gameDate: g.date ?? '',
      gameTime: g.gameTime ?? '',
      game: g,
      betCards: bets,
      analyzedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    await batch.commit()
    return ref.id
  }
  const looksFresh = !cur || Date.now() - started > DAY_MS + 60_000
  if (!looksFresh && (cur.n || 0) >= SAVES_PER_DAY) throw new Error(`You've saved ${SAVES_PER_DAY} analyses in the last day. Older ones are still in your history.`)
  try {
    return await save(looksFresh)
  } catch (e) {
    // our clock and the server's disagree about whether the day is up: try the other way once
    if (!cur || e?.code !== 'permission-denied') throw e
    if (looksFresh && (cur.n || 0) >= SAVES_PER_DAY) throw e
    return save(!looksFresh)
  }
}

/**
 * @param {string} userId
 * @param {string} docId
 * @param {unknown} betCards
 */
export async function updatePastGameBetCards(userId, docId, betCards) {
  if (!db) throw new Error('Firestore is not configured.')
  const ref = doc(db, PAST_GAMES_COLLECTION, docId)
  const snap = await getDoc(ref)
  if (!snap.exists) throw new Error('Saved game not found.')
  const data = snap.data()
  if (data?.userId !== userId) throw new Error('Not allowed.')
  const bets = sanitizeBetCards(betCards)
  await updateDoc(ref, {
    betCards: bets,
    updatedAt: serverTimestamp(),
  })
}

/**
 * @param {string} docId
 * @param {string} userId
 * @returns {Promise<{ betCards: {
 *   singleLegLock: string,
 *   twoLegParlay: string[],
 *   threeLegParlay: string[],
 *   quickReasoning: { singleLegLock: string, twoLegParlay: string, threeLegParlay: string }
 * } | null, game: object } | null>}
 */
export async function loadPastGame(docId, userId) {
  if (!db) return null
  const ref = doc(db, PAST_GAMES_COLLECTION, docId)
  const snap = await getDoc(ref)
  if (!snap.exists) return null
  const data = snap.data()
  if (data?.userId !== userId) return null
  return {
    betCards: sanitizeBetCards(data.betCards),
    game: typeof data.game === 'object' && data.game ? data.game : {},
  }
}

/**
 * @param {string} userId
 * @param {(docs: Array<{ id: string, data: object }>) => void} onData
 * @returns {() => void} unsubscribe
 */
export function subscribePastGames(userId, onData) {
  if (!db || !userId) {
    onData([])
    return () => {}
  }
  const q = query(
    collection(db, PAST_GAMES_COLLECTION),
    where('userId', '==', userId),
    orderBy('analyzedAt', 'desc'),
    limit(50),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }))
      onData(rows)
    },
    () => {
      onData([])
    },
  )
}

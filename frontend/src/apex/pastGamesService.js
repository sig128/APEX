import {
  addDoc,
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
} from 'firebase/firestore'
import { normalizeBetCardsPayload } from './apexBetCards.js'
import { db } from '../firebase.js'

export const PAST_GAMES_COLLECTION = 'pastGames'

/**
 * @param {unknown} betCards
 * @returns {import('./apexBetCards.js').ApexBetCards | null}
 */
function sanitizeBetCards(betCards) {
  const normalized = normalizeBetCardsPayload(betCards)
  if (!normalized) return null
  return {
    singleLegLock: normalized.singleLegLock,
    twoLegParlay: normalized.twoLegParlay.slice(0, 2),
    threeLegParlay: normalized.threeLegParlay.slice(0, 3),
    quickReasoning: normalized.quickReasoning,
    ...(normalized.lineSource ? { lineSource: normalized.lineSource } : {}),
  }
}

/**
 * @param {object} game
 * @returns {Record<string, string>}
 */
function sanitizeGameForStore(game) {
  if (!game || typeof game !== 'object') return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const [k, v] of Object.entries(game)) {
    if (v === undefined || v === null) continue
    out[k] = typeof v === 'string' ? v : String(v)
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
export async function createPastGame(userId, { game, betCards }) {
  if (!db) throw new Error('Firestore is not configured.')
  const g = sanitizeGameForStore(game)
  const bets = sanitizeBetCards(betCards)
  const ref = await addDoc(collection(db, PAST_GAMES_COLLECTION), {
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
  return ref.id
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

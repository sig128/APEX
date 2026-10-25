// Documents for billing and picks: Firestore in production, the local store in dev and tests.
// Both expose the same small API, including transactions (all reads before writes).
import { log } from '../lib/log.js'

function stripUndefined(v) {
  if (Array.isArray(v)) return v.map(stripUndefined)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = stripUndefined(x)
    return o
  }
  return v
}

function deepMerge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return b
  const out = { ...a }
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}

export function createFirestoreDocs(db) {
  const ref = (col, id) => db.collection(col).doc(String(id))
  const api = {
    kind: 'firestore',
    async get(col, id) {
      const s = await ref(col, id).get()
      return s.exists ? s.data() : null
    },
    async set(col, id, data) {
      await ref(col, id).set(stripUndefined(data))
    },
    async merge(col, id, data) {
      await ref(col, id).set(stripUndefined(data), { merge: true })
    },
    async del(col, id) {
      await ref(col, id).delete()
    },
    async tx(fn) {
      return db.runTransaction(async (t) =>
        fn({
          get: async (col, id) => {
            const s = await t.get(ref(col, id))
            return s.exists ? s.data() : null
          },
          set: (col, id, data) => t.set(ref(col, id), stripUndefined(data)),
          merge: (col, id, data) => t.set(ref(col, id), stripUndefined(data), { merge: true }),
          del: (col, id) => t.delete(ref(col, id)),
        }),
      )
    },
    /** Newest first. where: [[field, op, value], ...] */
    async recent(col, { field = 'createdAt', limit = 50, where = [], before } = {}) {
      let q = db.collection(col)
      for (const [f, op, v] of where) q = q.where(f, op, v)
      q = q.orderBy(field, 'desc')
      if (before != null) q = q.startAfter(before)
      const snap = await q.limit(Math.min(200, limit)).get()
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    },
  }
  return api
}

/** Store-backed docs. Transactions are serialized per process, which is what a single server needs. */
export function createStoreDocs(store) {
  const ns = (col) => `billing_${col}`
  let chain = Promise.resolve()
  function exclusive(fn) {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }
  const api = {
    kind: store.kind || 'store',
    async get(col, id) {
      return (await store.get(ns(col), String(id))) ?? null
    },
    async set(col, id, data) {
      await store.set(ns(col), String(id), stripUndefined(data))
    },
    async merge(col, id, data) {
      await store.update(ns(col), String(id), (cur) => deepMerge(cur || {}, stripUndefined(data)))
    },
    async del(col, id) {
      await store.del(ns(col), String(id))
    },
    tx(fn) {
      return exclusive(async () => {
        const writes = []
        const result = await fn({
          get: (col, id) => api.get(col, id),
          set: (col, id, data) => writes.push(() => api.set(col, id, data)),
          merge: (col, id, data) => writes.push(() => api.merge(col, id, data)),
          del: (col, id) => writes.push(() => api.del(col, id)),
        })
        for (const w of writes) await w()
        return result
      })
    },
    async recent(col, { field = 'createdAt', limit = 50, where = [], before } = {}) {
      const keys = await store.keys(ns(col))
      const rows = []
      for (const k of keys) {
        const v = await store.get(ns(col), k)
        if (!v) continue
        const ok = where.every(([f, op, x]) => (op === '==' ? v[f] === x : op === '>=' ? v[f] >= x : op === '<=' ? v[f] <= x : op === '>' ? v[f] > x : op === '<' ? v[f] < x : true))
        if (ok && (before == null || v[field] < before)) rows.push({ id: k, ...v })
      }
      return rows.sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0)).slice(0, Math.min(200, limit))
    },
  }
  return api
}

/** Firestore when we're on Google Cloud (or told to), otherwise the local store. */
export function createDocs({ getFirestore, store }) {
  const force = String(process.env.APEX_BILLING_STORE || '').toLowerCase()
  const onGcp = Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIRESTORE_EMULATOR_HOST || process.env.APEX_STORE === 'firestore')
  if ((force === 'firestore' || (force !== 'store' && onGcp)) && typeof getFirestore === 'function') {
    try {
      const db = getFirestore()
      if (db) return createFirestoreDocs(db)
    } catch (e) {
      log.warn('firestore unavailable for billing, using local store', { err: e?.message })
    }
  }
  return createStoreDocs(store)
}

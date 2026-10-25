// Persistent key/value store with three drivers: memory (tests), disk (local dev, one server)
// and firestore (Cloud Functions, many instances). Every driver has an atomic update().
import fs from 'node:fs/promises'
import path from 'node:path'
import { log, errText } from './log.js'

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

/** Serialize work per key inside one process (update() reads, awaits, then writes). */
function keyLocks() {
  const locks = new Map()
  return function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {}).finally(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    locks.set(key, tail)
    return run
  }
}

function memoryDriver() {
  const data = new Map()
  const withLock = keyLocks()
  const ns = (n) => {
    let m = data.get(n)
    if (!m) {
      m = new Map()
      data.set(n, m)
    }
    return m
  }
  return {
    kind: 'memory',
    async get(n, k) {
      return clone(ns(n).get(k))
    },
    async set(n, k, v) {
      ns(n).set(k, clone(v))
    },
    async del(n, k) {
      ns(n).delete(k)
    },
    async keys(n) {
      return [...ns(n).keys()]
    },
    update(n, k, fn) {
      return withLock(`${n}/${k}`, async () => {
        const next = await fn(clone(ns(n).get(k)))
        if (next === undefined) return clone(ns(n).get(k))
        ns(n).set(k, clone(next))
        return clone(next)
      })
    },
  }
}

function safeName(k) {
  return encodeURIComponent(String(k)).replace(/\*/g, '%2A').slice(0, 200)
}

function diskDriver(dir) {
  const withLock = keyLocks()
  const file = (n, k) => path.join(dir, safeName(n), `${safeName(k)}.json`)
  async function read(n, k) {
    try {
      return JSON.parse(await fs.readFile(file(n, k), 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT') return undefined
      log.warn('store read failed', { n, k, err: errText(e) })
      return undefined
    }
  }
  async function write(n, k, v) {
    const f = file(n, k)
    await fs.mkdir(path.dirname(f), { recursive: true })
    const tmp = `${f}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(v))
    await fs.rename(tmp, f)
  }
  return {
    kind: 'disk',
    dir,
    get: read,
    set: (n, k, v) => withLock(`${n}/${k}`, () => write(n, k, v)),
    async del(n, k) {
      await withLock(`${n}/${k}`, () => fs.rm(file(n, k), { force: true }))
    },
    async keys(n) {
      try {
        const names = await fs.readdir(path.join(dir, safeName(n)))
        return names.filter((x) => x.endsWith('.json')).map((x) => decodeURIComponent(x.slice(0, -5)))
      } catch {
        return []
      }
    },
    update(n, k, fn) {
      return withLock(`${n}/${k}`, async () => {
        const cur = await read(n, k)
        const next = await fn(cur)
        if (next === undefined) return cur
        await write(n, k, next)
        return next
      })
    },
  }
}

// Firestore caps a document at 1 MiB. Big values (the week's lines and box scores can pass that
// on a busy Sunday) are split across part documents written before the head that points at
// them, so a reader sees either the old value or the new one, never half of each.
const PART_CHARS = 700_000

function firestoreDriver(getDb, collection = 'apexStore') {
  const docId = (n, k) => `${safeName(n)}__${safeName(k)}`.slice(0, 1400)
  const col = () => getDb().collection(collection)
  const ref = (n, k) => col().doc(docId(n, k))
  const partRef = (n, k, rev, i) => col().doc(`${docId(n, k).slice(0, 1300)}__p${rev}_${i}`)
  const parse = (json) => {
    try {
      return JSON.parse(json)
    } catch {
      return undefined
    }
  }
  async function decode(n, k, snap) {
    if (!snap.exists) return undefined
    const d = snap.data()
    if (!d.parts) return parse(d.json)
    const snaps = await Promise.all(Array.from({ length: d.parts }, (_, i) => partRef(n, k, d.rev, i).get()))
    if (snaps.some((x) => !x.exists)) return undefined // replaced while we read it
    return parse(snaps.map((x) => x.data().json).join(''))
  }
  const rev = () => Math.random().toString(36).slice(2, 10)
  return {
    kind: 'firestore',
    async get(n, k) {
      return decode(n, k, await ref(n, k).get())
    },
    async set(n, k, v) {
      const json = JSON.stringify(v)
      const head = ref(n, k)
      const prev = await head.get().catch(() => null)
      const old = prev?.exists ? prev.data() : null
      if (json.length <= PART_CHARS) {
        await head.set({ ns: n, key: String(k), json, updatedAt: Date.now() })
      } else {
        const r = rev()
        const parts = Math.ceil(json.length / PART_CHARS)
        for (let i = 0; i < parts; i++) await partRef(n, k, r, i).set({ part: true, json: json.slice(i * PART_CHARS, (i + 1) * PART_CHARS) })
        await head.set({ ns: n, key: String(k), parts, rev: r, updatedAt: Date.now() })
      }
      if (old?.parts) await Promise.all(Array.from({ length: old.parts }, (_, i) => partRef(n, k, old.rev, i).delete().catch(() => {})))
    },
    async del(n, k) {
      const snap = await ref(n, k).get()
      const d = snap.exists ? snap.data() : null
      await ref(n, k).delete()
      if (d?.parts) await Promise.all(Array.from({ length: d.parts }, (_, i) => partRef(n, k, d.rev, i).delete().catch(() => {})))
    },
    async keys(n) {
      const snap = await col().where('ns', '==', n).select('key').limit(5000).get()
      return snap.docs.map((d) => d.get('key'))
    },
    /** Small values only (counters, spend tracking): one document, one transaction. */
    async update(n, k, fn) {
      const db = getDb()
      const r = ref(n, k)
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(r)
        const d = snap.exists ? snap.data() : null
        if (d?.parts) throw new Error(`store.update on a split value ${n}/${k}`)
        const cur = d ? parse(d.json) : undefined
        const next = await fn(cur)
        if (next === undefined) return cur
        const json = JSON.stringify(next)
        if (json.length > PART_CHARS) throw new Error(`store.update value too big for ${n}/${k}`)
        tx.set(r, { ns: n, key: String(k), json, updatedAt: Date.now() })
        return next
      })
    },
  }
}

/**
 * driver: 'memory' | 'disk' | 'firestore' | 'auto'. auto = firestore on Cloud Functions / Cloud Run
 * (or when APEX_STORE=firestore), otherwise disk under backend/var/store.
 */
export function createStore({ driver = process.env.APEX_STORE || 'auto', dir, getFirestore } = {}) {
  let kind = driver
  if (kind === 'auto') kind = process.env.K_SERVICE || process.env.FUNCTION_TARGET ? 'firestore' : 'disk'
  if (kind === 'firestore' && typeof getFirestore !== 'function') kind = 'disk'
  if (kind === 'memory') return memoryDriver()
  if (kind === 'firestore') return firestoreDriver(getFirestore)
  return diskDriver(dir || process.env.APEX_STORE_DIR || path.resolve(process.cwd(), 'var', 'store'))
}

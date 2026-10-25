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

function firestoreDriver(getDb, collection = 'apexStore') {
  const ref = (n, k) => getDb().collection(collection).doc(`${safeName(n)}__${safeName(k)}`.slice(0, 1400))
  const decode = (snap) => {
    if (!snap.exists) return undefined
    const d = snap.data()
    try {
      return JSON.parse(d.json)
    } catch {
      return undefined
    }
  }
  return {
    kind: 'firestore',
    async get(n, k) {
      return decode(await ref(n, k).get())
    },
    async set(n, k, v) {
      await ref(n, k).set({ ns: n, key: String(k), json: JSON.stringify(v), updatedAt: Date.now() })
    },
    async del(n, k) {
      await ref(n, k).delete()
    },
    async keys(n) {
      const snap = await getDb().collection(collection).where('ns', '==', n).select('key').limit(5000).get()
      return snap.docs.map((d) => d.get('key'))
    },
    async update(n, k, fn) {
      const db = getDb()
      const r = ref(n, k)
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(r)
        const cur = decode(snap)
        const next = await fn(cur)
        if (next === undefined) return cur
        tx.set(r, { ns: n, key: String(k), json: JSON.stringify(next), updatedAt: Date.now() })
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

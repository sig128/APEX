// A small in-memory Firestore with the semantics the app relies on: merge vs mergeFields,
// where/orderBy/startAfter/limit/select, serialized transactions that must read before they
// write, and the 1 MiB document limit.
const clone = (v) => (v === undefined ? undefined : structuredClone(v))
const MAX_DOC_BYTES = 1_048_487

function deepMerge(a, b) {
  const out = { ...(a || {}) }
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? deepMerge(out[k], v) : clone(v)
  }
  return out
}

function checkSize(data) {
  const n = Buffer.byteLength(JSON.stringify(data))
  if (n > MAX_DOC_BYTES) throw Object.assign(new Error(`Document exceeds the maximum size (${n} bytes)`), { code: 3 })
}

function checkUndefined(v, path = '') {
  if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (${path})`)
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) checkUndefined(x, `${path}.${k}`)
}

export function fakeFirestore() {
  const cols = new Map()
  const stats = { reads: 0, writes: 0, txRetries: 0 }
  // composite indexes the queries would need in real Firestore: "col:field ASC,field DESC"
  const indexNeeds = new Set()
  const colMap = (name) => {
    if (!cols.has(name)) cols.set(name, new Map())
    return cols.get(name)
  }

  function snapOf(col, id) {
    const data = colMap(col).get(id)
    return { id, exists: data !== undefined, data: () => clone(data), get: (f) => clone(data?.[f]) }
  }

  /** The document after a write, without applying it (so a transaction can check every write first). */
  function nextState(col, id, data, opts = {}, base = colMap(col).get(id)) {
    checkUndefined(data)
    let next
    if (opts.merge) next = deepMerge(base, data)
    else if (opts.mergeFields) {
      next = { ...(base || {}) }
      for (const f of opts.mergeFields) next[f] = clone(data[f])
    } else next = clone(data)
    checkSize(next)
    return next
  }

  function write(col, id, data, opts = {}) {
    colMap(col).set(id, nextState(col, id, data, opts))
    stats.writes++
  }

  function docRef(col, id) {
    return {
      id,
      _col: col,
      async get() {
        stats.reads++
        return snapOf(col, id)
      },
      async set(data, opts) {
        write(col, id, data, opts)
      },
      async update(data) {
        if (!colMap(col).has(id)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 })
        write(col, id, data, { merge: true })
      },
      async delete() {
        colMap(col).delete(id)
        stats.writes++
      },
    }
  }

  function query(col, { wheres = [], order = null, lim = Infinity, after, fields = null } = {}) {
    const self = {
      where: (f, op, v) => query(col, { wheres: [...wheres, [f, op, v]], order, lim, after, fields }),
      orderBy: (f, dir = 'asc') => query(col, { wheres, order: [f, dir], lim, after, fields }),
      limit: (n) => query(col, { wheres, order, lim: n, after, fields }),
      startAfter: (v) => query(col, { wheres, order, lim, after: v, fields }),
      select: (...fs) => query(col, { wheres, order, lim, after, fields: fs }),
      async get() {
        const eq = wheres.filter(([, op]) => op === '==').map(([f]) => f)
        const range = [...new Set(wheres.filter(([, op]) => op !== '==').map(([f]) => f))]
        const orderField = order?.[0] ?? range[0]
        const fieldsUsed = new Set([...eq, ...range, ...(order ? [order[0]] : [])])
        if (fieldsUsed.size > 1) indexNeeds.add(`${col}:${[...new Set(eq)].map((f) => `${f} ASC`).concat(orderField && !eq.includes(orderField) ? [`${orderField} ${order?.[1] === 'desc' ? 'DESC' : 'ASC'}`] : []).join(',')}`)
        const ops = { '==': (a, b) => a === b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b }
        let rows = [...colMap(col)].filter(([, d]) => wheres.every(([f, op, v]) => d[f] !== undefined && ops[op](d[f], v)))
        if (order) {
          const [f, dir] = order
          rows = rows.filter(([, d]) => d[f] !== undefined)
          rows.sort((a, b) => (a[1][f] < b[1][f] ? -1 : a[1][f] > b[1][f] ? 1 : 0) * (dir === 'desc' ? -1 : 1))
          if (after !== undefined) rows = rows.filter(([, d]) => (dir === 'desc' ? d[f] < after : d[f] > after))
        }
        rows = rows.slice(0, lim)
        stats.reads += Math.max(1, rows.length)
        return {
          size: rows.length,
          empty: !rows.length,
          docs: rows.map(([id, d]) => {
            const data = fields ? Object.fromEntries(fields.map((f) => [f, d[f]])) : d
            return { id, exists: true, data: () => clone(data), get: (f) => clone(data[f]) }
          }),
        }
      },
    }
    return self
  }

  let txChain = Promise.resolve()
  async function runTransaction(fn) {
    const run = async () => {
      let wrote = false
      const writes = []
      const t = {
        async get(ref) {
          if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.')
          stats.reads++
          return snapOf(ref._col, ref.id)
        },
        set(ref, data, opts) {
          wrote = true
          checkUndefined(data)
          writes.push((staged) => {
            const key = `${ref._col}\u0000${ref.id}`
            const base = staged.has(key) ? staged.get(key) ?? undefined : colMap(ref._col).get(ref.id)
            staged.set(key, nextState(ref._col, ref.id, data, opts, base))
          })
          return t
        },
        update(ref, data) {
          return t.set(ref, data, { merge: true })
        },
        delete(ref) {
          wrote = true
          writes.push((staged) => staged.set(`${ref._col}\u0000${ref.id}`, null))
          return t
        },
      }
      const out = await fn(t)
      // all or nothing, like a real commit: build every new state first, then apply
      const staged = new Map()
      for (const w of writes) w(staged)
      for (const [key, next] of staged) {
        const [col, id] = key.split('\u0000')
        if (next === null) colMap(col).delete(id)
        else colMap(col).set(id, next)
        stats.writes++
      }
      return out
    }
    const p = txChain.then(run, run)
    txChain = p.catch(() => {})
    return p
  }

  const db = {
    collection: (name) => ({ doc: (id) => docRef(name, String(id)), ...query(name) }),
    runTransaction,
    batch() {
      const ops = []
      return {
        set: (ref, data, opts) => ops.push(() => write(ref._col, ref.id, data, opts)),
        delete: (ref) => ops.push(() => colMap(ref._col).delete(ref.id)),
        commit: async () => ops.forEach((f) => f()),
      }
    },
    _cols: cols,
    _stats: stats,
    _indexNeeds: indexNeeds,
  }
  return db
}

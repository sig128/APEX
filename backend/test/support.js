// Shared test fixtures: a fully loaded engine on the recorded slate, a scriptable chain, test
// sign-ins, and a running copy of the whole app.
import { fixtureHttp, CAPTURED_AT } from './helpers.js'
import { createEngine } from '../src/nfl/engine.js'
import { createStore } from '../src/lib/store.js'
import { createAuth } from '../src/security/auth.js'

export { CAPTURED_AT }

/** A clock tests can move. */
export function clock(start = CAPTURED_AT) {
  let t = start
  const now = () => t
  now.set = (v) => (t = v)
  now.add = (ms) => (t += ms)
  return now
}

/** Run every task once so the board, logs and lines are all in place. */
export async function loadAll(engine) {
  await engine.ensureStarted()
  for (const t of ['summaries', 'schedules', 'rosters', 'lines']) await engine.runTask(t)
  let r
  do r = await engine.logsTask(500)
  while (r.left > 0)
  return engine
}

export async function fullEngine({ now = clock(), store = createStore({ driver: 'memory' }) } = {}) {
  const { http } = fixtureHttp()
  const engine = createEngine({ mode: 'lazy', http, store, now })
  await loadAll(engine)
  return engine
}

export const TREASURY = '0x1111111111111111111111111111111111111111'
export const PAYER = '0x2222222222222222222222222222222222222222'
export const txHash = (n) => `0x${String(n).padStart(64, '0')}`

/**
 * A chain whose transfers are whatever the test says. send(hash, { amount, to, token, timestamp,
 * confirmations, status }) records one; verifyTransfer and findTransfer read them back.
 */
export function fakeChain({ head = 30_000_000 } = {}) {
  const txs = new Map()
  const calls = { verify: 0, find: 0 }
  const api = {
    head,
    txs,
    calls,
    send(hash, t) {
      txs.set(hash.toLowerCase(), { confirmations: 5, status: 'ok', from: PAYER, block: api.head - 4, ...t })
    },
    async blockNumber() {
      return api.head
    },
    async verifyTransfer({ txHash: h, token, to, amount, minConfirmations }) {
      calls.verify++
      const t = txs.get(String(h).toLowerCase())
      if (!t) return { status: 'pending' }
      if (t.status === 'failed') return { status: 'failed' }
      if (String(t.to).toLowerCase() !== String(to).toLowerCase() || String(t.amount) !== String(amount) || (t.token && t.token.toLowerCase() !== token.toLowerCase())) return { status: 'mismatch' }
      if (t.confirmations < minConfirmations) return { status: 'confirming', confirmations: t.confirmations, needed: minConfirmations }
      return { status: 'ok', from: t.from, blockNumber: t.block, confirmations: t.confirmations, timestamp: t.timestamp, txHash: h }
    },
    async findTransfer({ to, amount, fromBlock, toBlock }) {
      calls.find++
      for (const [h, t] of txs) {
        if (String(t.to).toLowerCase() === String(to).toLowerCase() && String(t.amount) === String(amount) && t.block >= fromBlock && t.block <= toBlock) return { txHash: h, blockNumber: t.block, scannedTo: toBlock }
      }
      return { txHash: null, scannedTo: toBlock }
    },
  }
  return api
}

/** Test sign-ins: Authorization: Bearer <token> where token is a key of `users`. */
export function testAuth(users = {}, { invited = [] } = {}) {
  const inv = new Set(invited)
  return createAuth({
    verifyIdToken: async (token) => {
      const u = users[token]
      if (!u) throw new Error('bad token')
      return { uid: u.uid, email: u.email, email_verified: u.emailVerified ?? true, name: u.name, picture: u.picture, admin: u.admin, exp: Math.floor(Date.now() / 1000) + 3600 }
    },
    lookupInvite: async (uid) => inv.has(uid),
  })
}

export const USERS = {
  'tok-free-user-0000000000001': { uid: 'u_free', email: 'free@example.com', name: 'Free Fan' },
  'tok-pro-user-00000000000002': { uid: 'u_pro', email: 'pro@example.com', name: 'Pro Bettor' },
  'tok-elite-user-000000000003': { uid: 'u_elite', email: 'elite@example.com', name: 'Elite Capper', picture: 'https://lh3.googleusercontent.com/a/abcdefghijklmnop=s96-c' },
  'tok-admin-user-000000000004': { uid: 'u_admin', email: 'boss@example.com', name: 'Boss' },
  'tok-elite-two-0000000000005': { uid: 'u_elite2', email: 'two@example.com', name: 'Second Elite' },
}
export const bearer = (uid) => {
  const tok = Object.keys(USERS).find((k) => USERS[k].uid === uid)
  return { authorization: `Bearer ${tok}` }
}

/** Set env vars for the duration of a test file; returns a restore function. */
export function withEnv(vars) {
  const before = {}
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k]
    if (v == null) delete process.env[k]
    else process.env[k] = String(v)
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Listen on a free port; fetch helpers that return { status, headers, body, text }. */
export async function serve(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  async function call(method, path, { headers = {}, body, raw = false } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    if (raw) return res
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not json */
    }
    return { status: res.status, headers: res.headers, body: json, text }
  }
  return {
    base,
    server,
    get: (p, o) => call('GET', p, o),
    post: (p, body, o = {}) => call('POST', p, { ...o, body }),
    put: (p, body, o = {}) => call('PUT', p, { ...o, body }),
    del: (p, o) => call('DELETE', p, o),
    raw: (method, p, o = {}) => call(method, p, { ...o, raw: true }),
    close: () => new Promise((r) => server.close(r)),
  }
}

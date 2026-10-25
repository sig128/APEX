// The Vercel entry: builds the same app, finds its settings in the environment, and runs
// without a database (stats only: no passes, no picks pages) until a service account is set.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { withEnv, TREASURY } from './support.js'

const restoreEnv = withEnv({ VERCEL: '1', FIREBASE_SERVICE_ACCOUNT: null, FIREBASE_PROJECT_ID: null, VITE_FIREBASE_PROJECT_ID: 'apex-test', APEX_STORE: null, APEX_EPHEMERAL: null, APEX_BILLING_STORE: null, APEX_TREASURY_ADDRESS: TREASURY, APEX_PAYWALL: null, K_SERVICE: null, APEX_LOG_LEVEL: 'error' })
let mod
let server
let base
before(async () => {
  mod = await import('../vercel.js')
  server = http.createServer((req, res) => mod.default(req, res))
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((ok) => server.close(ok))
  mod?._state.made?.engine.stop()
  restoreEnv()
})

const get = async (path, headers = {}) => {
  const r = await fetch(base + path, { headers })
  return { status: r.status, body: await r.json().catch(() => null) }
}

test('service account from the environment: JSON or base64, junk is ignored', () => {
  const sa = { type: 'service_account', project_id: 'apex-test', client_email: 'x@apex-test.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n' }
  const fromJson = mod.serviceAccountFromEnv(JSON.stringify(sa))
  assert.equal(fromJson.project_id, 'apex-test')
  assert.ok(fromJson.private_key.includes('\n'), 'escaped newlines restored')
  assert.equal(mod.serviceAccountFromEnv(Buffer.from(JSON.stringify(sa)).toString('base64')).client_email, sa.client_email)
  assert.equal(mod.serviceAccountFromEnv('not json'), null)
  assert.equal(mod.serviceAccountFromEnv(JSON.stringify({ hello: 1 })), null)
  assert.equal(mod.serviceAccountFromEnv(''), null)
})

test('no database: stats on, passes and picks pages off, the caller is who Vercel says', async () => {
  const h = await get('/api/health', { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' })
  assert.equal(h.status, 200)
  assert.equal(h.body.database, false)
  assert.equal(h.body.you, '203.0.113.9')
  assert.deepEqual(globalThis.__firebaseAdminInit, { projectId: 'apex-test' }, 'sign-ins are checked against the site’s Firebase project')
  const cfg = await get('/api/billing/config')
  assert.equal(cfg.body.paywall, false, 'no passes on sale without somewhere to keep them, even with a treasury')
  const page = await fetch(base + '/api/picks/me', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"handle":"someone"}' })
  assert.equal(page.status, 503)
  assert.equal((await page.json()).code, 'no_database')
  const code = await fetch(base + '/api/billing/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"APEX-1234"}' })
  assert.equal(code.status, 401, 'codes still need a sign-in first')
  const missing = await get('/api/nope')
  assert.equal(missing.status, 404)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderUserHead } from '../src/picks/og.js'

const HTML = `<!DOCTYPE html><html><head>
<title>APEX NFL</title>
<meta name="description" content="generic" />
<meta property="og:title" content="APEX NFL" />
<meta name="twitter:card" content="summary" />
<link rel="icon" href="/logo.png" />
</head><body><div id="root"></div></body></html>`

const view = (over = {}) => ({ profile: { handle: 'sharpside', name: 'Sharp <Side>', bio: 'Props "only"', x: 'sharpside', record: { d30: { wins: 10, losses: 3, pushes: 1, units: 10.65, graded: 13 }, all: { wins: 30, losses: 20, pushes: 0, units: 12.1, graded: 50 } }, ...over } })

test('link preview: name, record and links, escaped, generic tags replaced', () => {
  const out = renderUserHead(HTML, view(), 'https://apex.web.app')
  assert.match(out, /<title>Sharp &lt;Side&gt; \(@sharpside\) on APEX<\/title>/)
  assert.match(out, /Last 30 days: 10-3-1, \+10.65u\. All time: 30-20, \+12.1u\./)
  assert.match(out, /Props &quot;only&quot;/)
  assert.match(out, /<meta property="og:url" content="https:\/\/apex.web.app\/u\/sharpside" \/>/)
  assert.match(out, /twitter:creator" content="@sharpside"/)
  assert.equal((out.match(/<title>/g) || []).length, 1, 'one title')
  assert.equal((out.match(/name="description"/g) || []).length, 1, 'one description')
  assert.ok(!out.includes('content="generic"'))
  assert.ok(out.includes('<link rel="icon"'), 'other head tags stay')
  const fresh = renderUserHead(HTML, view({ record: null, bio: '' }), 'https://apex.web.app')
  assert.match(fresh, /Every pick posted before kickoff/)
})

test('route: /u/:handle serves the app with its own card when the build is present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-web-'))
  fs.writeFileSync(path.join(dir, 'index.html'), HTML)
  process.env.APEX_WEB_INDEX = path.join(dir, 'index.html')
  process.env.APEX_LOG_LEVEL = 'error'
  const { createApexApp } = await import(`../app.js?og=${Date.now()}`)
  const { createStore } = await import('../src/lib/store.js')
  const { fixtureHttp } = await import('./helpers.js')
  const { serve, clock } = await import('./support.js')
  const made = createApexApp({ engineMode: 'lazy', http: fixtureHttp().http, store: createStore({ driver: 'memory' }), now: clock() })
  await made.picks.saveProfile({ uid: 'u1', email: 'a@b.c', name: 'Pat' }, { handle: 'pat_picks', name: 'Pat' })
  const api = await serve(made.app)
  const r = await api.get('/u/pat_picks', { headers: { 'x-forwarded-host': 'apex-test.web.app' } })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /html/)
  assert.match(r.text, /<title>Pat \(@pat_picks\) on APEX<\/title>/)
  assert.match(r.text, /https:\/\/apex-test.web.app\/u\/pat_picks/)
  const forged = await api.get('/u/pat_picks', { headers: { 'x-forwarded-host': 'evil.example.com' } })
  assert.ok(!forged.text.includes('evil.example.com'), 'a forged host never reaches the card')
  const missing = await api.get('/u/nobody_here')
  assert.equal(missing.status, 200, 'unknown handles still get the app, which shows its own not-found')
  assert.match(missing.text, /<title>APEX NFL<\/title>/)
  await api.close()
  made.engine.stop()
  delete process.env.APEX_WEB_INDEX
})

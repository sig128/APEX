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
  assert.match(fresh, /og:image" content="https:\/\/apex.web.app\/logo.png"/, 'the logo without a picture')
  const pic = renderUserHead(HTML, view({ avatar: 'https://lh3.googleusercontent.com/a/abcdefghijklmnop=s96-c' }), 'https://apex.web.app')
  assert.match(pic, /og:image" content="https:\/\/lh3.googleusercontent.com\/a\/abcdefghijklmnop=s400-c"/, 'their own picture, card sized')
})

test('route: /u/:handle serves the app with its own card when the build is present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-web-'))
  fs.writeFileSync(path.join(dir, 'index.html'), HTML)
  const saved = { idx: process.env.APEX_WEB_INDEX, proj: process.env.GCLOUD_PROJECT, site: process.env.APEX_PUBLIC_SITE_URL }
  process.env.APEX_WEB_INDEX = path.join(dir, 'index.html')
  process.env.GCLOUD_PROJECT = 'apex-test'
  delete process.env.APEX_PUBLIC_SITE_URL
  process.env.APEX_LOG_LEVEL = 'error'
  const { createApexApp } = await import(`../app.js?og=${Date.now()}`)
  const { createStore } = await import('../src/lib/store.js')
  const { fixtureHttp } = await import('./helpers.js')
  const { serve, clock } = await import('./support.js')
  const made = createApexApp({ engineMode: 'lazy', http: fixtureHttp().http, store: createStore({ driver: 'memory' }), now: clock() })
  const api = await serve(made.app)
  try {
    await made.picks.saveProfile({ uid: 'u1', email: 'a@b.c', name: 'Pat' }, { handle: 'pat_picks', name: 'Pat' })
    const r = await api.get('/u/pat_picks', { headers: { 'x-forwarded-host': 'apex-test.firebaseapp.com' } })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /html/)
    assert.match(r.text, /<title>Pat \(@pat_picks\) on APEX<\/title>/)
    assert.match(r.text, /https:\/\/apex-test.firebaseapp.com\/u\/pat_picks/, 'this project’s own domains are used as asked')
    const forged = await api.get('/u/pat_picks', { headers: { 'x-forwarded-host': 'evil.example.com' } })
    assert.ok(!forged.text.includes('evil.example.com'), 'a forged host never reaches the card')
    assert.match(forged.text, /https:\/\/apex-test.web.app\/u\/pat_picks/, 'it falls back to this project’s web.app')
    const otherSite = await api.get('/u/pat_picks', { headers: { 'x-forwarded-host': 'someone-else.web.app' } })
    assert.ok(!otherSite.text.includes('someone-else'), 'anyone can have a web.app site; only ours count')
    const missing = await api.get('/u/nobody_here')
    assert.equal(missing.status, 200, 'unknown handles still get the app, which shows its own not-found')
    assert.match(missing.text, /<title>APEX NFL<\/title>/)
  } finally {
    await api.close()
    made.engine.stop()
    for (const [k, v] of [['APEX_WEB_INDEX', saved.idx], ['GCLOUD_PROJECT', saved.proj], ['APEX_PUBLIC_SITE_URL', saved.site]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('route: with no copy of the site to hand out, /u/:handle sends the browser to the app', async () => {
  const saved = { idx: process.env.APEX_WEB_INDEX, proj: process.env.GCLOUD_PROJECT, site: process.env.APEX_PUBLIC_SITE_URL }
  process.env.APEX_WEB_INDEX = path.join(os.tmpdir(), 'apex-no-such-dir', 'index.html')
  delete process.env.GCLOUD_PROJECT
  delete process.env.APEX_PUBLIC_SITE_URL
  const { createApexApp } = await import(`../app.js?og-missing=${Date.now()}`)
  const { createStore } = await import('../src/lib/store.js')
  const { fixtureHttp } = await import('./helpers.js')
  const { serve, clock } = await import('./support.js')
  const made = createApexApp({ engineMode: 'lazy', http: fixtureHttp().http, store: createStore({ driver: 'memory' }), now: clock() })
  const api = await serve(made.app)
  try {
    const r = await fetch(`${api.base}/u/Pat_Picks`, { redirect: 'manual' })
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), '/?to=%2Fu%2Fpat_picks')
  } finally {
    await api.close()
    made.engine.stop()
    for (const [k, v] of [['APEX_WEB_INDEX', saved.idx], ['GCLOUD_PROJECT', saved.proj], ['APEX_PUBLIC_SITE_URL', saved.site]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

// proppickz.com runs this API as a Firebase function (functions/), which installs only the
// packages in functions/package.json. A package the API imports that isn't listed there stops the
// whole server from starting ("PropPickz is starting up" on every request), as happened when the
// word filter (obscenity) and alerts (web-push) were added to backend/ alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(backend, '..')

test('the Firebase function installs every package the API imports', () => {
  const deps = JSON.parse(fs.readFileSync(path.join(root, 'functions', 'package.json'), 'utf8')).dependencies || {}
  // the files scripts/sync-functions.mjs copies into the function
  const sync = fs.readFileSync(path.join(root, 'scripts', 'sync-functions.mjs'), 'utf8')
  const top = JSON.parse(/const FILES = (\[[^\]]*\])/.exec(sync)[1].replace(/'/g, '"'))
  const dirs = JSON.parse(/const DIRS = (\[[^\]]*\])/.exec(sync)[1].replace(/'/g, '"'))
  const files = top.map((f) => path.join(backend, f))
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.m?js$/.test(e.name)) files.push(p)
    }
  }
  for (const d of dirs) walk(path.join(backend, d))
  const missing = new Map()
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'".][^'"]*)['"]/g)) {
      const spec = m[1]
      if (spec.startsWith('node:')) continue
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!(name in deps)) missing.set(name, path.relative(backend, f))
    }
  }
  assert.deepEqual(Object.fromEntries(missing), {}, 'add these to functions/package.json (npm install --prefix functions <name>)')
})

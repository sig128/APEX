// Every named import between our own files points at a file that exists and exports that name.
// Vite's build stops on a missing export (that is what failed the Oct 27 deploy), and a lazy
// page that names the wrong export only breaks once someone opens it. No bundler needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const CODE = /\.(js|jsx|mjs)$/
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : CODE.test(f) ? [p] : []
  })
const files = walk(SRC)
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))

/** './x' from a file, as Vite resolves it: exact, then .js/.jsx, then a folder's index. */
function resolveFrom(from, spec) {
  const base = resolve(dirname(from), spec.replace(/\?.*$/, ''))
  for (const p of [base, `${base}.js`, `${base}.jsx`, join(base, 'index.js'), join(base, 'index.jsx')]) {
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

// `a`, `a as b`: what the name is called on the other side
const names = (list, side) =>
  list
    .split(',')
    .map((s) => s.replace(/\/\/.*$|\/\*[\s\S]*?\*\//g, '').trim())
    .filter(Boolean)
    .map((s) => {
      const [left, right] = s.split(/\s+as\s+/)
      return side === 'local' ? (right || left).trim() : left.trim()
    })

const exportCache = new Map()
function exportsOf(file, seen = new Set()) {
  if (exportCache.has(file)) return exportCache.get(file)
  if (seen.has(file)) return new Set()
  seen.add(file)
  const src = text.get(file) ?? readFileSync(file, 'utf8')
  const out = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^export\s+class\s+([\w$]+)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([\w$]+)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+\{([^}]*)\}/gm)) for (const n of names(m[1], 'local')) out.add(n.split(':').pop().trim())
  for (const m of src.matchAll(/^export\s+default\b/gm)) out.add('default')
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const n of names(m[1], 'local')) out.add(n)
  for (const m of src.matchAll(/^export\s*\*\s*as\s+([\w$]+)\s+from/gm)) out.add(m[1])
  for (const m of src.matchAll(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) {
    const target = m[1].startsWith('.') ? resolveFrom(file, m[1]) : null
    if (target) for (const n of exportsOf(target, seen)) if (n !== 'default') out.add(n)
  }
  exportCache.set(file, out)
  return out
}

/** Every place one of our files asks another for a name: [file, spec, name, what]. */
function wants() {
  const out = []
  for (const [file, src] of text) {
    // import X, { a, b as c } from './y'   and   export { a } from './y'
    for (const m of src.matchAll(/^(?:import|export)\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*(?:from\s*)?['"](\.[^'"]+)['"]/gm)) {
      const [, def, list, spec] = m
      if (def && m[0].startsWith('import')) out.push([file, spec, 'default', 'import'])
      if (list) for (const n of names(list, 'remote')) out.push([file, spec, n, m[0].startsWith('import') ? 'import' : 're-export'])
      if (!def && !list && m[0].startsWith('import')) out.push([file, spec, null, 'side effect'])
    }
    // import X from './y'
    for (const m of src.matchAll(/^import\s+([\w$]+)\s+from\s*['"](\.[^'"]+)['"]/gm)) out.push([file, m[2], 'default', 'import'])
    // lazy pages: page(() => import('./pages/X.jsx'), 'X')   and   import('./x').then((m) => ({ default: m.X }))
    for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)\s*,\s*['"]([\w$]+)['"]/g)) out.push([file, m[1], m[2], 'lazy page'])
    for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)\.then\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\(\{\s*default:\s*\2\.([\w$]+)/g)) out.push([file, m[1], m[3], 'lazy'])
  }
  return out
}

test('every import between our files resolves to a real export', () => {
  const asks = wants()
  assert.ok(asks.length > 200, `found ${asks.length} imports; the scan is not reading the code`)
  const broken = []
  for (const [file, spec, name, what] of asks) {
    const where = relative(SRC, file)
    const target = resolveFrom(file, spec)
    // a missing stylesheet or image stops the build as surely as a missing module
    if (!target) broken.push(`${where}: ${spec} does not exist`)
    // names are only checked in our code (a ?raw import is text, not a module)
    else if (name != null && !spec.includes('?') && CODE.test(target) && !exportsOf(target).has(name)) {
      broken.push(`${where}: ${what} "${name}" is not exported by ${relative(SRC, target)}`)
    }
  }
  assert.deepEqual(broken, [])
})

test('the scan sees the export forms this code uses', () => {
  const sport = resolveFrom(join(SRC, 'x.js'), './lib/sport.js')
  assert.ok(exportsOf(sport).has('sp'), 'its own exports')
  assert.ok(exportsOf(sport).has('legRef'), 'and what export * brings in from leagues.js')
  const card = resolveFrom(join(SRC, 'ui/x.js'), './PickCard.jsx')
  for (const n of ['PickCard', 'Avatar', 'RecordPanel']) assert.ok(exportsOf(card).has(n), n)
})

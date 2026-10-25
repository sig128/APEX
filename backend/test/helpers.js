import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixtureTransport, createHttp } from '../src/lib/http.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let bundle = null

/** The ESPN capture from Saturday Oct 24, 2026 (Week 7 slate, plus two live college games). */
export function fixtures() {
  if (!bundle) bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, 'fixtures', 'espn-2026-10-25.json.gz'))).toString('utf8'))
  return bundle.fixtures
}
export const CAPTURED_AT = Date.parse('2026-10-25T02:29:00Z')

export function fixtureHttp(extra = {}) {
  const transport = createFixtureTransport({ ...fixtures(), ...extra })
  return { http: createHttp({ transport, maxPerHost: 16 }), transport }
}

// Load the recorded slate through the real engine and print what the board would show.
// Usage: node scripts/nfl-check.mjs [fixtures.json.gz]
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixtureTransport, createHttp } from '../src/lib/http.js'
import { createEngine } from '../src/nfl/engine.js'
import { createStore } from '../src/lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] || path.join(here, '..', 'test', 'fixtures', 'espn-2026-10-25.json.gz')
const { fixtures } = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
const transport = createFixtureTransport(fixtures)
const http = createHttp({ transport, maxPerHost: 16 })
const now = () => Date.parse('2026-10-25T02:29:00Z')
const engine = createEngine({ mode: 'lazy', http, store: createStore({ driver: 'memory' }), now })
const t0 = Date.now()
await engine.ensureStarted()
for (const t of ['summaries', 'schedules', 'rosters', 'lines']) await engine.runTask(t)
let r
do r = await engine.logsTask(400)
while (r.left > 0)
const t1 = Date.now()
const home = engine.views.home()
const t2 = Date.now()
console.log('loaded in', t1 - t0, 'ms; home in', t2 - t1, 'ms; again', (() => { const a = Date.now(); engine.views.home(); return Date.now() - a })(), 'ms')
console.log('status', JSON.stringify({ ...engine.status(), http: undefined, at: undefined }))
console.log('counts', home.counts, 'misses', transport.misses.size, [...transport.misses].slice(0, 5))
for (const [tab, rows] of Object.entries(home.tabs)) {
  console.log(`\n== ${tab} (${rows.length})`)
  for (const c of rows.slice(0, 6)) console.log(`  ${c.score} ${(c.prob * 100).toFixed(0)}% fair ${c.fair}  ${c.name} (${c.pos} ${c.teamAbbr} vs ${c.oppAbbr})  ${c.label}  L5 ${c.l5?.hits}/${c.l5?.n} L10 ${c.l10?.hits}/${c.l10?.n} streak ${c.streak} best ${c.best?.label} ${c.best?.hits}/${c.best?.n} proj ${c.proj}${c.move ? ` move ${c.move.delta}` : ''}${c.boost ? ` boost w/o ${c.boost.short}` : ''}`)
}
console.log('\ncheatsheets', home.cheatsheets.map((s) => `${s.title}: ${s.rows.length}`).join(' | '))
console.log('parlays', home.parlays.map((p) => `${p.size}-leg ${(p.prob * 100).toFixed(0)}% ${p.fair}`).join(' | '))
const g = engine.views.game('401873020')
console.log('\ngame', g.game.shortName, 'props', g.props.length, 'home trends', g.home.trends.map((t) => t.text), 'inj', g.home.injuries.length, 'implied', g.home.implied, g.away.implied)
const top = g.props[0]
const pr = engine.views.prop(top.id)
console.log('prop', pr.prop.label, pr.prop.name, 'windows', pr.prop.windows.map((w) => `${w.label} ${w.hits}/${w.n}`).join(', '), 'matchup', pr.prop.matchup?.text, 'others', pr.others.length, 'alts', pr.alts.length)
const pl = engine.views.player(top.playerId)
console.log('player', pl.player.name, pl.player.pos, 'props', pl.props.length, 'log rows', pl.log.rows.length, pl.log.cols)
const ex = engine.views.props({ market: 'core', sort: 'hit', window: 'L10', minHit: 0.8 })
console.log('explorer L10>=80%', ex.total, ex.rows.slice(0, 3).map((x) => `${x.name} ${x.shortLabel} ${x.win?.hits}/${x.win?.n}`))
console.log('search', engine.views.search('gibbs').players.map((p) => p.name))
const d = engine.views.dvp()
console.log('dvp RB rushYds top3', d.groups.RB.rushYds.slice(0, 3), 'n', d.groups.RB.rushYds.length)
console.log('track', JSON.stringify(engine.views.track([top.id, 'junk']).legs.map((l) => [l.id, l.missing || l.label])))
const lv = engine.views.live()
console.log('live games', lv.games.length, lv.games.map((x) => `${x.away.abbr}@${x.home.abbr} ${x.status.state} props ${x.props.length}`))
const fin = lv.games[0]?.props?.slice(0, 4).map((p) => `${p.name} ${p.shortLabel} cur ${p.live.cur} ${p.live.status}`)
console.log('final tracker', fin)

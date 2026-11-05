// The calibration page, open to everyone: every graded prop on file, grouped by the probability
// the model gave it before the game, against how often it hit. On the diagonal, a 70% rating
// hits 70% of the time. Each closed day's rows are public and fingerprinted, so anyone can check
// the record hasn't been touched since.
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../lib/useApi.js'
import { useTitle, useWidth, useCopy } from '../lib/hooks.js'
import { DATA_BASE, SITE_URL, dataUrl } from '../lib/config.js'
import { Empty, ErrorBox, Skeleton } from '../ui/Bits.jsx'

const WINDOWS = [
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'season', label: 'Season' },
  { key: 'all', label: 'All' },
]
const WINDOW_TEXT = { '30d': 'the last 30 days', '90d': 'the last 90 days', season: 'this season', all: 'everything on file' }
// what each filter is when it isn't in the address
const DEFAULTS = { league: 'all', market: 'all', window: 'season', season: '', basis: 'p' }

const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '–')
// percentage points with a sign, signed after rounding (never "−0.0")
const pts = (x) => {
  if (!Number.isFinite(x)) return '–'
  const v = Math.round(x * 1000) / 10
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`
}
const count = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '–')
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const dayLabel = (d) => (d ? dayFmt.format(new Date(`${d}T12:00:00Z`)) : '')
const timeLabel = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

export function CalibrationPage() {
  useTitle('Calibration: the model’s ratings against results')
  const [q, setQ] = useSearchParams()
  const league = q.get('league') || 'all'
  const market = q.get('market') || 'all'
  const win = WINDOWS.some((w) => w.key === q.get('window')) ? q.get('window') : 'season'
  const season = win === 'season' && /^\d{4}$/.test(q.get('season') || '') ? q.get('season') : ''
  const basis = q.get('basis') === 'p0' ? 'p0' : 'p'

  // filters build on the address bar as it is at the tap (two quick taps both count)
  const set = (changes) => {
    const next = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : q)
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === '' || v === DEFAULTS[k]) next.delete(k)
      else next.set(k, v)
    }
    if (next.get('window') && next.get('window') !== 'season') next.delete('season')
    setQ(next, { replace: true })
  }

  const scope = new URLSearchParams()
  if (league !== 'all') scope.set('league', league)
  if (win !== 'season') scope.set('window', win)
  if (season) scope.set('season', season)
  const full = new URLSearchParams(scope)
  if (market !== 'all') full.set('market', market)
  if (basis !== 'p') full.set('basis', basis)
  const live = useApi(`/api/calibration${full.toString() ? `?${full}` : ''}`, { maxAgeMs: 60_000 })
  // the last answer stays on screen (dimmed) while the next filter loads
  const last = useRef(null)
  if (live.data) last.current = live.data
  const data = live.data || last.current
  const updating = !live.data && Boolean(data)

  const leagueName = (k) => data?.leagues?.find((l) => l.key === k)?.name || String(k).toUpperCase()

  return (
    <div className="container page cal">
      <header className="page-head">
        <h1 className="page-title">Calibration</h1>
        <p className="page-sub">When the model rates a prop at 70%, it should hit about 70% of the time. Here is every graded prop on file, grouped by the probability the model gave it before the game, against how often it hit. Open to everyone, no sign-in.</p>
      </header>

      <Filters data={data} league={league} market={market} win={win} season={season} basis={basis} set={set} />

      {live.error && !data ? (
        <ErrorBox error={live.error} onRetry={live.refresh} />
      ) : !data ? (
        <Skeleton rows={5} />
      ) : (
        <div className={`cal-body${updating ? ' is-stale' : ''}`} aria-busy={updating || undefined}>
          {live.staleError && <ErrorBox error={live.staleError} onRetry={live.refresh} />}
          <Coverage data={data} leagueName={leagueName} />
          {data.overall.n + (data.outside?.below50?.n || 0) === 0 ? (
            <Empty title="Nothing graded in this range yet">Props count here once every game on their day is graded. Try a longer window or another league.</Empty>
          ) : (
            <>
              <Hero data={data} />
              <section className="cal-section" aria-labelledby="cal-chart-title">
                <h2 className="section__title" id="cal-chart-title">
                  Rated against hit
                </h2>
                <div className="cal-split">
                  <div className="cal-card">
                    <RatedVsHit bands={data.bands} small={data.small} />
                    <ChartKey bands={data.bands} small={data.small} />
                  </div>
                  <BandTable data={data} />
                </div>
              </section>
            </>
          )}
          <HowWeCount data={data} />
        </div>
      )}

      <Fingerprints scope={scope.toString()} leagueName={leagueName} win={win} />
    </div>
  )
}

function Filters({ data, league, market, win, season, basis, set }) {
  const leagues = data?.leagues || []
  const markets = data?.markets || []
  const seasons = data?.seasons || []
  const hasMarket = market === 'all' || markets.some((m) => m.key === market)
  return (
    <div className="cal-filters" role="group" aria-label="Filters">
      <label className="field cal-filter">
        <span>League</span>
        <select value={league} onChange={(e) => set({ league: e.target.value, market: null })}>
          <option value="all">All leagues</option>
          {leagues.map((l) => (
            <option key={l.key} value={l.key}>
              {l.name}
            </option>
          ))}
          {league !== 'all' && !leagues.some((l) => l.key === league) && <option value={league}>{league.toUpperCase()}</option>}
        </select>
      </label>
      <label className="field cal-filter">
        <span>Prop type</span>
        <select value={market} onChange={(e) => set({ market: e.target.value })}>
          <option value="all">All prop types</option>
          {markets.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
          {!hasMarket && <option value={market}>{market}</option>}
        </select>
      </label>
      <label className="field cal-filter">
        <span>Rated at</span>
        <select value={basis} onChange={(e) => set({ basis: e.target.value })}>
          <option value="p">Last look</option>
          <option value="p0">First look</option>
        </select>
      </label>
      <div className="field cal-filter cal-filter--window">
        <span id="cal-window">Window</span>
        <div className="seg seg--s" role="group" aria-labelledby="cal-window">
          {WINDOWS.map((w) => (
            <button key={w.key} type="button" className={win === w.key ? 'is-on' : ''} aria-pressed={win === w.key} onClick={() => set({ window: w.key, season: null })}>
              {w.label}
            </button>
          ))}
        </div>
      </div>
      {win === 'season' && seasons.length > 1 && (
        <label className="field cal-filter">
          <span>Season</span>
          <select value={season} onChange={(e) => set({ season: e.target.value })}>
            <option value="">This season</option>
            {seasons.map((s) => (
              <option key={s.key} value={String(s.key)}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

/** Exactly which days the numbers cover, and what is left out. */
function Coverage({ data, leagueName }) {
  const r = data.range
  const pending = r.pending || []
  const missing = r.missing || []
  const differ = r.reconciled?.differ || []
  return (
    <div className="cal-range">
      <p>{r.note}</p>
      {pending.length > 0 && (
        <p className="muted small">
          Waiting on results, not counted yet: {pending.map((x) => `${leagueName(x.league)} ${dayLabel(x.day)}`).join(', ')}.
        </p>
      )}
      {missing.length > 0 && (
        <p className="muted small">
          Closed, but no rows on file to count: {missing.map((x) => `${leagueName(x.league)} ${dayLabel(x.day)}`).join(', ')}.
        </p>
      )}
      {differ.length > 0 && (
        <p className="cal-warn small" role="note">
          These days count differently from the log’s own summary: {differ.map((x) => `${leagueName(x.league)} ${dayLabel(x.day)}`).join(', ')}.
        </p>
      )}
    </div>
  )
}

function Hero({ data }) {
  const h = data.headline
  const o = data.overall
  return (
    <section className="cal-hero" aria-label="Headline">
      {h ? (
        <>
          <p className="cal-hero__big num" aria-hidden="true">
            {pct(h.hit)}
          </p>
          <div className="cal-hero__words">
            <p className="cal-hero__text">{h.text}</p>
            <p className="cal-hero__sub">{h.sub}.</p>
          </div>
        </>
      ) : (
        <div className="cal-hero__words">
          <p className="cal-hero__text">No band has {data.small} graded props in this range yet.</p>
          <p className="cal-hero__sub">The headline waits for a band big enough to mean something. Every number is still in the table.</p>
        </div>
      )}
      {o.n > 0 && (
        <p className="cal-hero__all">
          Everything rated 50% or more: {plural(o.n, 'graded prop')} hit {pct(o.hit)}, against an average rating of {pct(o.avg)}.
        </p>
      )}
    </section>
  )
}

/**
 * The model's rating (across) against how often it hit (up), on one scale so the 45-degree line
 * is "right on". One gold series: dot area grows with the graded props, hollow dots are small
 * samples, and each dot carries its 95% range.
 */
function RatedVsHit({ bands, small }) {
  const [ref, W] = useWidth(480)
  const [hover, setHover] = useState(null)
  const shown = bands.filter((b) => b.n > 0 && Number.isFinite(b.hit) && Number.isFinite(b.avg))
  if (!shown.length) return null
  const lo = Math.min(0.5, Math.floor(Math.min(...shown.map((b) => b.hit)) * 10) / 10)
  const span = 1 - lo
  const pad = { t: 18, r: 16, b: 46, l: 58 }
  const size = Math.max(180, Math.min(W - pad.l - pad.r, 460))
  const width = size + pad.l + pad.r
  const height = size + pad.t + pad.b
  const x = (v) => pad.l + ((v - lo) / span) * size
  const y = (v) => pad.t + size - ((v - lo) / span) * size
  const maxN = Math.max(...shown.map((b) => b.n))
  const rad = (n) => Math.max(4.5, 13 * Math.sqrt(n / maxN))
  const ticks = []
  for (let i = Math.round(lo * 10); i <= 10; i++) ticks.push(i / 10)
  const h = hover != null ? shown[hover] : null
  const tipLeft = h ? Math.max(4, Math.min(x(h.avg) + 14, width - 208)) : 0
  return (
    <figure className="cal-chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Hit rate against the model’s rating, by band. ${shown.map((b) => `${b.label}: hit ${pct(b.hit)} of ${b.n}`).join('; ')}.`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(lo)} x2={x(1)} y1={y(v)} y2={y(v)} className="cal-grid" />
            <line x1={x(v)} x2={x(v)} y1={y(lo)} y2={y(1)} className="cal-grid" />
            <text x={x(lo) - 8} y={y(v) + 4} textAnchor="end" className="cal-tick">
              {Math.round(v * 100)}%
            </text>
            <text x={x(v)} y={y(lo) + 17} textAnchor="middle" className="cal-tick">
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        <line x1={x(lo)} y1={y(lo)} x2={x(1)} y2={y(1)} className="cal-ref" />
        <text x={x(1)} y={pad.t - 6} textAnchor="end" className="cal-tick cal-tick--strong">
          Rated = hit
        </text>
        <text x={pad.l + size / 2} y={height - 6} textAnchor="middle" className="cal-axis">
          Model’s rating (band average)
        </text>
        <text x={12} y={pad.t + size / 2} textAnchor="middle" className="cal-axis" transform={`rotate(-90 12 ${pad.t + size / 2})`}>
          Hit rate
        </text>
        {shown.map((b) => (
          <line key={`w${b.key}`} x1={x(b.avg)} x2={x(b.avg)} y1={y(Math.max(lo, b.low ?? b.hit))} y2={y(Math.min(1, b.high ?? b.hit))} className={`cal-whisker${b.small ? ' is-small' : ''}`} />
        ))}
        {shown.map((b, i) => (
          <g
            key={b.key}
            className="cal-pt"
            tabIndex={0}
            aria-label={`${b.label}: hit ${pct(b.hit)} of ${b.n} graded, average rating ${pct(b.avg)}${b.small ? `, fewer than ${small} graded` : ''}`}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <circle cx={x(b.avg)} cy={y(b.hit)} r={Math.max(12, rad(b.n) + 4)} fill="transparent" />
            <circle cx={x(b.avg)} cy={y(b.hit)} r={rad(b.n)} className={`cal-dot${b.small ? ' is-small' : ''}${hover === i ? ' is-hover' : ''}`} />
          </g>
        ))}
      </svg>
      {h && (
        <div className="cal-tip" style={{ left: tipLeft, top: Math.max(0, y(h.hit) - 10) }} role="status">
          <b className="num">{pct(h.hit)}</b> hit, rated {pct(h.avg)}
          <span className="cal-tip__sub">
            {h.label}: {count(h.n)} graded, {count(h.wins)}-{count(h.losses)}
          </span>
          <span className="cal-tip__sub">
            95% range {pct(h.low, 0)} to {pct(h.high, 0)}
            {h.small ? '. Small sample.' : ''}
          </span>
        </div>
      )}
    </figure>
  )
}

/** What the marks mean: the chart is one series, so this is a key to its marks, not a series legend. */
function ChartKey({ bands, small }) {
  const most = Math.max(0, ...bands.map((b) => b.n))
  const mark = (children) => (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      {children}
    </svg>
  )
  return (
    <div className="cal-key">
      <ul className="cal-key__list">
        <li>
          {mark(<circle cx="12" cy="12" r="6" className="cal-dot" />)}
          {small} or more graded
        </li>
        <li>
          {mark(<circle cx="12" cy="12" r="6" className="cal-dot is-small" />)}
          Fewer than {small} graded
        </li>
        <li>
          {mark(<line x1="4" y1="20" x2="20" y2="4" className="cal-ref" />)}
          Rated = hit
        </li>
        <li>
          {mark(<line x1="12" y1="3" x2="12" y2="21" className="cal-whisker" />)}
          95% range
        </li>
      </ul>
      <p className="cal-caption">
        Each dot is one band of ratings: across, the average rating of its props; up, how often they hit. On the line, a 70% rating hits 70% of the time. Dot area grows with the number of graded props (the biggest here holds {count(most)}). The line through a dot is its 95% range: with that many props, the true hit rate is likely somewhere on it.
      </p>
    </div>
  )
}

/** Every band with every number and its size; small bands marked. */
function BandTable({ data }) {
  const below = data.outside?.below50
  const moved = data.excluded?.lineMoved
  const o = data.overall
  const range = (b) => (Number.isFinite(b.low) && Number.isFinite(b.high) ? `${pct(b.low, 0)} to ${pct(b.high, 0)}` : '–')
  const row = (b, { head, sub } = {}) => (
    <tr key={b.key} className={b.small && b.n > 0 ? 'is-small' : b.n === 0 ? 'is-empty' : ''}>
      <th scope="row">
        {head || b.label}
        {b.small && b.n > 0 && <span className="cal-tag">Small</span>}
        {sub && <span className="cal-note">{sub}</span>}
        <span className="cal-sub">
          {count(b.wins)}-{count(b.losses)} · {plural(b.pushes, 'push', 'pushes')} · {plural(b.voids, 'void')}
          {b.postponed ? ` · ${count(b.postponed)} postponed` : ''}
        </span>
        {b.n > 0 && Number.isFinite(b.hit) && (
          <span className="cal-sub">
            Gap {pts(b.gap)} · 95% range {range(b)}
          </span>
        )}
      </th>
      <td className="num-col num">{count(b.n)}</td>
      <td className="num-col num">{pct(b.hit)}</td>
      <td className="num-col num">{pct(b.avg)}</td>
      <td className="num-col num cal-wide">{pts(b.gap)}</td>
      <td className="num-col cal-wide">{range(b)}</td>
      <td className="num-col cal-wide">
        {count(b.wins)}-{count(b.losses)}
      </td>
      <td className="num-col cal-wide">{count(b.pushes)}</td>
      <td className="num-col cal-wide">{count(b.voids)}</td>
      <td className="num-col cal-wide">{count(b.postponed)}</td>
    </tr>
  )
  return (
    <div className="cal-tablewrap">
      <table className="cal-table">
        <caption className="sr-only">Every band: graded props, hit rate, average rating, and what was left out</caption>
        <thead>
          <tr>
            <th scope="col">Rated</th>
            <th scope="col" className="num-col">
              Graded
            </th>
            <th scope="col" className="num-col">
              Hit
            </th>
            <th scope="col" className="num-col">
              Avg rating
            </th>
            <th scope="col" className="num-col cal-wide" title="Hit rate minus average rating, in percentage points">
              Gap
            </th>
            <th scope="col" className="num-col cal-wide" title="The range the true hit rate likely sits in, given this many props">
              95% range
            </th>
            <th scope="col" className="num-col cal-wide">
              Won-lost
            </th>
            <th scope="col" className="num-col cal-wide">
              Pushes
            </th>
            <th scope="col" className="num-col cal-wide">
              Voids
            </th>
            <th scope="col" className="num-col cal-wide">
              Postponed
            </th>
          </tr>
        </thead>
        <tbody>{data.bands.map((b) => row(b))}</tbody>
        <tfoot>
          {row({ ...o, small: false }, { head: 'All bands' })}
          {below && row({ ...below, small: below.small }, { head: 'Under 50%', sub: 'Yes-only props such as anytime scorer. Not on the chart.' })}
          {moved && moved.n + moved.pushes + moved.voids + moved.postponed > 0 && row({ ...moved, small: false, hit: null, avg: null, gap: null }, { head: 'Left out', sub: 'The line moved after the first look, so that rating was for another bet.' })}
        </tfoot>
      </table>
      <p className="cal-caption">Graded counts wins and losses only. Gap is the hit rate minus the average rating, in points: above zero, those props hit more often than rated. The 95% range is where the true hit rate likely sits, given how many props there are.</p>
    </div>
  )
}

function HowWeCount({ data }) {
  return (
    <section className="cal-section" aria-labelledby="cal-how-title">
      <h2 className="section__title" id="cal-how-title">
        How the count works
      </h2>
      <ul className="cal-list">
        <li>
          <b>Rated</b> means {data.basis.key === 'p0' ? 'the first probability the model gave the line, when it first saw it.' : 'the model’s last probability before the game started, the one it stood on.'} The props are the side the model backed on every main line it logged: the side it gave at least 50%, or the yes side of yes-only props like anytime scorer.
        </li>
        <li>Only wins and losses count toward the hit rate. Pushes (the stat landed on the line), voids (the player didn’t play) and props on games that were postponed or never finished are left out, and counted in their own columns.</li>
        <li>
          Bands run 5 points wide from 50% to 90%, then 90% or more. A band with fewer than {data.small} graded props is marked small: a hit rate on few props can swing a long way by chance.
        </li>
        <li>A game day (US Eastern) counts once every game on it is graded. Today’s games never count, and the days still waiting on results are named above.</li>
        <li>The headline band is picked by size, never by how it did: the band with the most graded props among those rated 60% or more, with at least {data.small} graded.</li>
        {data.basis.key === 'p0' && <li>On the first look, a prop whose line moved before the game is left out: the first rating was for a different bet. The log keeps the first line, not the first side, so a switch of sides at the same line can’t be seen.</li>}
      </ul>
    </section>
  )
}

function CopyHash({ text }) {
  const [copy, copied] = useCopy()
  return (
    <button type="button" className="linkish cal-copy" onClick={() => copy(text)} aria-label="Copy the fingerprint">
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** Each closed day's fingerprint, newest first, and how to check one. */
function Fingerprints({ scope, leagueName, win }) {
  const fp = useApi(`/api/calibration/fingerprints${scope ? `?${scope}` : ''}`, { maxAgeMs: 60_000 })
  const [all, setAll] = useState(false)
  const days = fp.data?.days || []
  const shown = all ? days : days.slice(0, 8)
  const origin = DATA_BASE || SITE_URL
  const example = days[0] ? `${origin}${days[0].url}` : `${origin}/api/calibration/day/nba/2026-11-03`
  return (
    <section className="cal-section" aria-labelledby="cal-fp-title">
      <h2 className="section__title" id="cal-fp-title">
        Daily fingerprints
      </h2>
      <p className="section__note">
        The first time a closed game day is read after grading, its graded rows are fingerprinted with SHA-256 and the fingerprint is stored once. It is never replaced. If a row on file changed later, its hash would stop matching, and this list would say so.
      </p>
      {fp.error && !fp.data ? (
        <ErrorBox error={fp.error} onRetry={fp.refresh} />
      ) : !fp.data ? (
        <Skeleton rows={3} />
      ) : !days.length ? (
        <p className="muted">No closed days in {WINDOW_TEXT[win] || 'this range'} yet.</p>
      ) : (
        <>
          <ul className="cal-fps">
            {shown.map((f) => (
              <li key={`${f.league}:${f.day}`} className={`cal-fp${f.mismatch ? ' is-off' : ''}`}>
                <p className="cal-fp__head">
                  <b>{dayLabel(f.day)}</b>
                  <span className="cal-fp__lg">{leagueName(f.league)}</span>
                  <span className="muted small">
                    {plural(f.rows, 'row')}
                    {f.counts ? `: ${count(f.counts.w)} won, ${count(f.counts.l)} lost, ${plural(f.counts.p, 'push', 'pushes')}, ${plural(f.counts.v, 'void')}` : ''}
                  </span>
                </p>
                <code className="cal-fp__hash">{f.sha256}</code>
                <p className="cal-fp__foot small">
                  <span className="muted">Stored {timeLabel(f.at)}</span>
                  <a className="link" href={dataUrl(f.url)} target="_blank" rel="noopener noreferrer">
                    Rows
                  </a>
                  <a className="link" href={dataUrl(`${f.url}?format=text`)} target="_blank" rel="noopener noreferrer">
                    Exact text
                  </a>
                  <CopyHash text={f.sha256} />
                </p>
                {f.mismatch && (
                  <p className="cal-warn small" role="note">
                    The rows on file changed after this fingerprint was stored ({timeLabel(f.mismatch.at)}): they now hash to <code>{f.mismatch.sha256}</code>. The fingerprint above is the original.
                  </p>
                )}
              </li>
            ))}
          </ul>
          {days.length > shown.length && (
            <button type="button" className="btn btn--quiet btn--s cal-more" onClick={() => setAll(true)}>
              Show all {count(days.length)} days
            </button>
          )}
        </>
      )}
      <details className="cal-check">
        <summary>Check a day yourself</summary>
        <ol className="cal-list">
          <li>
            Download the day’s rows: <code>{example}</code>. The <code>rows</code> field holds every graded row of that day.
          </li>
          <li>
            Write each row as compact JSON of <code>[id, p, p0, t0, t1, res, val]</code>: no spaces, numbers as they come, <code>null</code> for a missing value.
          </li>
          <li>Sort the lines as plain text, join them with a newline, and end with a newline.</li>
          <li>Hash that text with SHA-256. The 64 hex digits should match the fingerprint for that day.</li>
        </ol>
        <p className="small muted">In Node 18 or later (save it as check.mjs and run node check.mjs):</p>
        <pre className="cal-code">
          <code>{`const { rows } = await (await fetch('${example}')).json()
const lines = rows.map((r) => JSON.stringify([r.id, r.p, r.p0, r.t0, r.t1, r.res, r.val])).sort()
const text = lines.map((l) => l + '\\n').join('')
const { createHash } = await import('node:crypto')
console.log(createHash('sha256').update(text).digest('hex'))`}</code>
        </pre>
        <p className="small muted">In Python 3:</p>
        <pre className="cal-code">
          <code>{`import hashlib, json, urllib.request
rows = json.load(urllib.request.urlopen('${example}'))['rows']
lines = sorted(json.dumps([r[k] for k in ('id', 'p', 'p0', 't0', 't1', 'res', 'val')], separators=(',', ':')) for r in rows)
print(hashlib.sha256(''.join(l + '\\n' for l in lines).encode()).hexdigest())`}</code>
        </pre>
        <p className="small muted">
          The exact text we hash is also at <code>?format=text</code> on the same address, so <code>curl -s '{example}?format=text' | sha256sum</code> shows the same hash. Rebuilding the text from the rows yourself, as above, is the real check.
        </p>
      </details>
    </section>
  )
}

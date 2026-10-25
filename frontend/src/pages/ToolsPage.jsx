import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTitle } from '../lib/hooks.js'
import { impliedOf, noVigOf, decimalOf, americanOf, parseOdds, odds } from '../lib/format.js'

/** decimal - 1 as a short fraction ("10/11", "3/2") by continued fractions. */
function fractionOf(decimal) {
  const x = decimal - 1
  if (!(x > 0)) return ''
  let [h0, h1, k0, k1] = [0, 1, 1, 0]
  let v = x
  for (let i = 0; i < 12; i++) {
    const a = Math.floor(v)
    ;[h0, h1] = [h1, a * h1 + h0]
    ;[k0, k1] = [k1, a * k1 + k0]
    if (Math.abs(h1 / k1 - x) < 0.005 || k1 > 100) break
    v = 1 / (v - a)
  }
  return `${h1}/${k1}`
}

function parseFraction(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(s)
  return m && Number(m[2]) > 0 ? 1 + Number(m[1]) / Number(m[2]) : null
}

const fmtDec = (d) => (d ? d.toFixed(d < 10 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '') : '')

/** One price, every way of writing it. Typing in any box fills the others. */
function Converter() {
  const [state, setState] = useState({ from: 'american', american: '-110', decimal: '', fraction: '', pct: '' })
  let d = null
  if (state.from === 'american') d = decimalOf(parseOdds(state.american))
  if (state.from === 'decimal') d = Number(state.decimal) > 1 ? Number(state.decimal) : null
  if (state.from === 'fraction') d = parseFraction(state.fraction)
  if (state.from === 'pct') {
    const p = Number(String(state.pct).replace('%', '')) / 100
    d = p > 0 && p < 1 ? 1 / p : null
  }
  const am = d ? americanOf(d) : null
  const p = d ? 1 / d : null
  const shown = {
    american: state.from === 'american' ? state.american : am != null ? odds(am) : '',
    decimal: state.from === 'decimal' ? state.decimal : fmtDec(d),
    fraction: state.from === 'fraction' ? state.fraction : d ? fractionOf(d) : '',
    pct: state.from === 'pct' ? state.pct : p ? (p * 100).toFixed(2) : '',
  }
  const set = (from) => (e) => setState({ ...state, from, [from]: e.target.value })
  const win100 = d ? (d - 1) * 100 : null
  return (
    <section className="tool tool--hero" aria-labelledby="conv-title">
      <h2 id="conv-title" className="tool__title">Odds to percent</h2>
      <p className="tool__lede">Sportsbooks write chances as prices. Type a price in any format and see the chance it stands for.</p>
      <div className="conv">
        <label className="field">
          <span>American</span>
          <input inputMode="numeric" value={shown.american} onChange={set('american')} placeholder="-110" />
        </label>
        <label className="field">
          <span>Decimal</span>
          <input inputMode="decimal" value={shown.decimal} onChange={set('decimal')} placeholder="1.91" />
        </label>
        <label className="field">
          <span>Fractional</span>
          <input value={shown.fraction} onChange={set('fraction')} placeholder="10/11" />
        </label>
        <label className="field">
          <span>Chance (%)</span>
          <input inputMode="decimal" value={shown.pct} onChange={set('pct')} placeholder="52.38" />
        </label>
      </div>
      {p ? (
        <div className="conv__read">
          <p className="conv__big num">{(p * 100).toFixed(1)}%</p>
          <p className="conv__say">
            {am != null && am < 0 ? `Risk $${-am} to win $100.` : `Risk $100 to win $${Math.round(win100)}.`} The book is saying this happens about{' '}
            <b>
              {Math.round(p * 100)} times in 100
            </b>
            . To make money betting it, it has to happen more often than that.
          </p>
        </div>
      ) : (
        <p className="form-err">Enter a price like -110, +150, 1.91, 10/11 or 52%.</p>
      )}
    </section>
  )
}

/** Both sides of a market: how much the book keeps, and the chances without its cut. */
function TwoWay() {
  const [a, setA] = useState('-110')
  const [b, setB] = useState('-110')
  const nv = noVigOf(parseOdds(a), parseOdds(b))
  return (
    <section className="tool" aria-labelledby="vig-title">
      <h2 id="vig-title" className="tool__title">The book's cut</h2>
      <p className="tool__lede">Enter both sides (over and under, or both teams). Their chances add up to more than 100%; the extra is what the book keeps.</p>
      <div className="conv conv--2">
        <label className="field">
          <span>Side A</span>
          <input inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} />
        </label>
        <label className="field">
          <span>Side B</span>
          <input inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} />
        </label>
      </div>
      {nv ? (
        <dl className="tool__facts">
          <div>
            <dt>As priced</dt>
            <dd className="num">
              {(impliedOf(parseOdds(a)) * 100).toFixed(1)}% + {(impliedOf(parseOdds(b)) * 100).toFixed(1)}%
            </dd>
          </div>
          <div>
            <dt>Book's cut</dt>
            <dd className="num">{(nv.vig * 100).toFixed(2)}%</dd>
          </div>
          <div>
            <dt>Fair chances</dt>
            <dd className="num">
              {(nv.a * 100).toFixed(1)}% / {(nv.b * 100).toFixed(1)}%
            </dd>
          </div>
        </dl>
      ) : (
        <p className="form-err">Enter two prices like -110 and -110.</p>
      )}
    </section>
  )
}

const TOOLS = [
  { to: '/tools/sim', title: 'Parlay simulator', body: 'Play your parlay out 10,000 to 100,000 times: how often each leg hits, how often it all cashes, and what luck does to a bankroll.', plan: 'Pro' },
  { to: '/tools/check', title: 'Parlay check', body: 'Paste your legs or upload a screenshot of your betslip. The AI says which legs to keep and which to cut, and why.', plan: 'Pro' },
  { to: '/kelly', title: 'Kelly calculator', body: 'How much to bet from your edge and your bankroll, and thousands of simulated seasons of betting it.', plan: 'Pro' },
]

export function ToolsPage() {
  useTitle('Betting tools: odds to percent, parlay simulator, parlay check, Kelly')
  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">Tools</h1>
        <p className="page-sub">Read a price as a chance, play a parlay out before you place it, and size the bet.</p>
      </header>
      <div className="tools">
        <Converter />
        <TwoWay />
        <section className="tool-links" aria-label="More tools">
          {TOOLS.map((t) => (
            <Link key={t.to} to={t.to} className="tool-link">
              <span className="tool-link__plan">{t.plan}</span>
              <span className="tool-link__title">{t.title}</span>
              <span className="tool-link__body">{t.body}</span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  )
}

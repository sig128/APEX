// The edge finder: the board's record sliced every way the log can slice it, with the profit
// at real prices and how sure each number is. Calibration sits next to it: when the board
// says 65%, does it hit 65%?
import { useState } from 'react'
import { Calibration } from './charts.jsx'
import { GROUPS, groupRows, stats, confidence, pctTxt, signedPct, unitsTxt, record } from './numbers.js'

const MINS = [
  { key: 0, label: 'Every slice' },
  { key: 30, label: '30+ bets' },
  { key: 100, label: '100+ bets' },
  { key: 250, label: '250+ bets' },
]

export function Confidence({ s }) {
  const c = confidence(s)
  return <span className={`adm-conf is-${c.key}`}>{c.label}</span>
}

/** ROI as a bar from a center line: turf right of zero, flag left, the signed number beside it. */
export function RoiBar({ roi, scale }) {
  if (!Number.isFinite(roi)) return <span className="muted">–</span>
  const w = Math.min(1, Math.abs(roi) / (scale || 0.2)) * 50
  return (
    <span className="adm-roi">
      <span className="adm-roi__track" aria-hidden="true">
        <span className={`adm-roi__bar ${roi >= 0 ? 'is-plus' : 'is-minus'}`} style={roi >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
      </span>
      <span className="adm-roi__v num">{signedPct(roi)}</span>
    </span>
  )
}

export function EdgeFinder({ model, labels }) {
  const [group, setGroup] = useState('m')
  const [min, setMin] = useState(30)
  const seg = model?.seg || {}
  const rows = groupRows(seg, group, labels, { min })
  const scale = Math.max(0.05, ...rows.map((r) => Math.abs(r.roi || 0)))
  const calib = groupRows(seg, 'pb', labels).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
  const all = stats(Object.values(model?.leagues || {}).reduce((a, l) => l.all.map((x, i) => x + (a[i] || 0)), []))
  const hidden = groupRows(seg, group, labels).length - rows.length
  return (
    <div className="adm-edge">
      <div className="adm-edge__main">
        <div className="adm-edge__bar">
          <div className="pills-scroll" role="tablist" aria-label="Slice by">
            {GROUPS.map((g) => (
              <button key={g.key} type="button" role="tab" aria-selected={group === g.key} className={`pill${group === g.key ? ' is-on' : ''}`} onClick={() => setGroup(g.key)}>
                {g.label}
              </button>
            ))}
          </div>
          <label className="adm-select">
            <span className="sr-only">Smallest slice</span>
            <select value={min} onChange={(e) => setMin(Number(e.target.value))}>
              {MINS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!rows.length ? (
          <p className="adm-empty">{all.n ? `No slice has ${min}+ graded bets yet${hidden ? ` (${hidden} smaller ones hidden)` : ''}.` : 'Nothing graded in this range yet.'}</p>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">Slice</th>
                <th scope="col" className="num-col">
                  Bets
                </th>
                <th scope="col" className="num-col adm-hide-s">
                  Record
                </th>
                <th scope="col" className="num-col">
                  Hit
                </th>
                <th scope="col" className="num-col adm-hide-s">
                  Board said
                </th>
                <th scope="col">Profit per bet</th>
                <th scope="col" className="num-col adm-hide-s">
                  Units
                </th>
                <th scope="col" className="adm-hide-s">
                  How sure
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row">{r.name}</th>
                  <td className="num-col num">{r.n.toLocaleString()}</td>
                  <td className="num-col num adm-hide-s">{record(r)}</td>
                  <td className="num-col num">{pctTxt(r.hit)}</td>
                  <td className="num-col num adm-hide-s muted">{pctTxt(r.expected)}</td>
                  <td>
                    <RoiBar roi={r.roi} scale={scale} />
                    <span className="adm-show-s">
                      <Confidence s={r} />
                    </span>
                  </td>
                  <td className={`num-col num adm-hide-s ${r.units >= 0 ? 'is-plus' : 'is-minus'}`}>{unitsTxt(r.units)}</td>
                  <td className="adm-hide-s">
                    <Confidence s={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {hidden > 0 && rows.length > 0 && <p className="adm-note">{hidden} smaller slices hidden. Small slices swing a lot: 30 bets can look like an edge by luck alone.</p>}
        <p className="adm-note">
          Profit per bet is 1 unit flat on the board’s side at the best price we saw before the game, so +5% means about $5 back per $100 bet. “Board said” is the average probability it gave; when Hit runs above it, the board was too cautious there.
        </p>
      </div>
      <aside className="adm-edge__side">
        <h3 className="adm-h3">Does the board mean what it says?</h3>
        {calib.length ? (
          <>
            <Calibration rows={calib} />
            <table className="adm-table adm-table--tight">
              <thead>
                <tr>
                  <th scope="col">Board said</th>
                  <th scope="col" className="num-col">
                    Hit
                  </th>
                  <th scope="col" className="num-col">
                    Bets
                  </th>
                </tr>
              </thead>
              <tbody>
                {calib.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{r.name}</th>
                    <td className="num-col num">{pctTxt(r.hit)}</td>
                    <td className="num-col num">{r.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="adm-empty">Once a few hundred bets are graded, this shows whether 60% calls hit 60% of the time.</p>
        )}
      </aside>
    </div>
  )
}

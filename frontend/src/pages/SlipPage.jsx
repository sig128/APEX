import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { parseShare, importLegs, parlayMath } from '../lib/slip.js'
import { useLive } from '../lib/live.js'
import { useTitle } from '../lib/hooks.js'
import { pct, odds } from '../lib/format.js'
import { PropRow } from '../ui/PropRow.jsx'
import { Skeleton, Empty, ErrorBox } from '../ui/Bits.jsx'
import { sp, legRef, shareRef } from '../lib/sport.js'
import { trackLegs } from '../lib/track.js'

/** A shared slip (/slip?legs=...): see it, track it live, or copy it into your own slip. */
export function SlipPage() {
  const loc = useLocation()
  const { ids, refs, prices } = useMemo(() => parseShare(loc.search), [loc.search])
  const sport = refs[0]?.sport || 'nfl'
  const [legs, setLegs] = useState(null)
  const [err, setErr] = useState(null)
  const [imported, setImported] = useState(false)
  useTitle('Shared slip')
  useEffect(() => {
    if (!ids.length) return undefined
    let stop = false
    const load = () =>
      trackLegs(refs)
        .then((list) => !stop && setLegs(list))
        .catch((e) => !stop && setErr(e))
    load()
    const t = setInterval(load, 30_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [ids])
  const anyStarted = legs?.some((l) => l.live)
  // the live stream follows the first leg's league; the rest refresh every 30 seconds
  useLive(anyStarted ? 'tracker' : null, (diff) => setLegs((cur) => cur && cur.map((l) => (l.sport === sport && diff[l.id] ? { ...l, live: diff[l.id] } : l))), sport)
  if (!ids.length) return <div className="container page"><Empty title="This link has no legs on it" action={<Link to={sp(sport, '/props')} className="btn btn--quiet">Find props</Link>} /></div>
  const found = (legs || []).filter((l) => !l.missing)
  const missing = (legs || []).filter((l) => l.missing)
  const math = found.length ? parlayMath(found.map((l) => ({ ...l, price: prices[shareRef(l)] ?? null })), null) : null
  return (
    <div className="container page">
      <header className="page-head">
        <h1 className="page-title">{ids.length > 1 ? `${ids.length}-leg slip` : 'Shared pick'}</h1>
        {math && found.length > 1 && (
          <p className="page-sub">
            Propify gives it <b className="num">{pct(math.prob, 1)}</b>, fair <b className="num">{odds(math.fair)}</b>
            {math.book ? `, shared at ${odds(math.book)}` : ''}
          </p>
        )}
      </header>
      <ErrorBox error={err} />
      {!legs ? (
        <Skeleton rows={ids.length} />
      ) : (
        <>
          <div className="prop-list">
            {found.map((l) => (
              <PropRow key={legRef(l)} c={l} live={l.live && !l.live.untracked ? l.live : null} />
            ))}
          </div>
          {missing.length > 0 && <p className="muted">{missing.length === 1 ? 'One leg is' : `${missing.length} legs are`} no longer on the board.</p>}
          <div className="row">
            <button
              type="button"
              className="btn btn--gold"
              disabled={!found.length}
              onClick={() => {
                importLegs(found, prices)
                setImported(true)
                window.dispatchEvent(new Event('apex:open-slip'))
              }}
            >
              {imported ? 'Copied to your slip' : 'Use this slip'}
            </button>
            <Link to={sp(sport, '/live')} className="btn btn--quiet">
              Live tracker
            </Link>
          </div>
        </>
      )}
    </div>
  )
}

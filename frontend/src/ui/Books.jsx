import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { odds, pct, impliedOf, decimalOf } from '../lib/format.js'
import { Dialog } from './Dialog.jsx'
import { useSport, apiOf, legRef, legsSport } from '../lib/sport.js'

const STATES = ['AZ', 'CO', 'CT', 'DC', 'IA', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'NC', 'NH', 'NJ', 'NY', 'OH', 'PA', 'TN', 'VA', 'VT', 'WV', 'WY']
const read = (k, d) => {
  try {
    return localStorage.getItem(k) || d
  } catch {
    return d
  }
}
const write = (k, v) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode */
  }
}

/** Some books' links carry the state in the address. */
const withState = (url, st) => (url && url.includes('{state}') ? url.replaceAll('{state}', st.toLowerCase()) : url)

const memo = new Map()
/**
 * Every book's prices for these legs (POST /api/<league>/shop), cached for a minute. Legs can
 * come from several leagues; each is sent as its ref ("nba:<id>").
 */
export function useShop(legs, { enabled = true } = {}) {
  const here = useSport()
  const withSport = legs.map((l) => (l.sport ? l : { ...l, sport: here }))
  const refs = withSport.map(legRef)
  const key = refs.join(',')
  const [st, setSt] = useState(() => memo.get(key)?.v || { data: null, error: null })
  useEffect(() => {
    if (!enabled || !refs.length) return undefined
    const hit = memo.get(key)
    if (hit && Date.now() - hit.at < 60_000) {
      setSt(hit.v)
      return undefined
    }
    let live = true
    api(`${apiOf(legsSport(withSport, here))}/shop`, { method: 'POST', body: { legs: refs } })
      .then((data) => {
        const v = { data, error: null }
        memo.set(key, { at: Date.now(), v })
        if (live) setSt(v)
      })
      .catch((error) => live && setSt({ data: null, error }))
    return () => {
      live = false
    }
  }, [key, enabled])
  return st
}

function evText(p, american) {
  const d = decimalOf(american)
  if (!(p > 0) || !d) return null
  const ev = p * d - 1
  return { ev, text: `${ev >= 0 ? '+' : '−'}$${Math.abs(ev * 100).toFixed(0)} per $100` }
}

/**
 * The slip at every sportsbook, best price first, and a button that opens the book: with the
 * legs on its bet slip where the book's links allow it, otherwise one tap per leg.
 */
export function SendToBook({ open, onClose, legs, p = null, title = 'Send to sportsbook' }) {
  const { data, error } = useShop(legs, { enabled: open })
  const anyPrice = data?.books?.some((b) => b.priced)
  const [state, setState] = useState(() => read('apex_state', 'NJ'))
  const mine = read('apex_book', '')
  const needsState = data?.books?.some((b) => [b.link, ...(b.legLinks || [])].some((u) => u && u.includes('{state}')))
  const go = (book) => write('apex_book', book)

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="shopsheet">
        <p className="shopsheet__intro">
          {legs.length === 1 ? 'This bet' : `Your ${legs.length}-leg parlay`} at every sportsbook, best price first. The button opens the book’s app if you have it installed.
        </p>
        {error && <p className="ask__err">{error.message}</p>}
        {!data && !error && <p className="muted">Checking every book…</p>}
        {data && !data.oddsFeed && (
          <p className="shopsheet__note">
            {anyPrice
              ? 'Prices here are the ones DraftKings posts (via ESPN). Every other book fills in once the multi-book odds feed is connected; each one still opens from its button.'
              : 'Live sportsbook prices aren’t switched on for this site yet, so the books below open without a price. Prices appear once the odds feed is connected.'}
          </p>
        )}
        {data && (
          <ol className="shoplist">
            {data.books.map((b) => {
              const e = b.american != null ? evText(p, b.american) : null
              const isBest = data.best === b.book
              return (
                <li key={b.book} className={`shop${isBest ? ' is-best' : ''}`}>
                  <div className="shop__who">
                    <span className="shop__name">{b.name}</span>
                    {isBest && <span className="shop__tag">Best price</span>}
                    {b.book === mine && !isBest && <span className="shop__tag shop__tag--mine">Your book</span>}
                  </div>
                  <div className="shop__price">
                    {b.complete ? (
                      <>
                        <b className="num">{odds(b.american)}</b>
                        <span className="num muted">{pct(impliedOf(b.american), 1)}</span>
                        {e && <span className={`shop__ev ${e.ev >= 0 ? 'is-pos' : 'is-neg'}`}>{e.text}</span>}
                      </>
                    ) : b.noFeed ? (
                      <span className="muted">No price feed</span>
                    ) : b.priced ? (
                      <span className="muted">
                        Has {b.priced} of {legs.length} legs
                      </span>
                    ) : (
                      <span className="muted">No price posted</span>
                    )}
                  </div>
                  <a className={`btn ${isBest ? 'btn--gold' : 'btn--quiet'} shop__go`} href={withState(b.link, state)} target="_blank" rel="noopener noreferrer" onClick={() => go(b.book)}>
                    {b.allOnSlip ? `Open ${b.name} with ${legs.length > 1 ? 'all legs' : 'the bet'}` : `Open ${b.name}`}
                  </a>
                  {!b.allOnSlip && legs.length > 1 && b.legLinks?.some(Boolean) && (
                    <div className="shop__legs">
                      <span className="muted">Tap each leg to add it to your {b.name} slip:</span>
                      {b.legLinks.map((u, i) =>
                        u ? (
                          <a key={i} href={withState(u, state)} target="_blank" rel="noopener noreferrer" className="shop__leg" onClick={() => go(b.book)}>
                            Leg {i + 1}
                            {b.prices[i] != null && <span className="num"> {odds(b.prices[i])}</span>}
                          </a>
                        ) : (
                          <span key={i} className="shop__leg is-off">
                            Leg {i + 1}: not posted
                          </span>
                        ),
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
        {needsState && (
          <label className="shopsheet__state">
            <span>Your state (some books’ links need it)</span>
            <select
              value={state}
              onChange={(e) => {
                setState(e.target.value)
                write('apex_state', e.target.value)
              }}
            >
              {STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        {data?.spread > 0.02 && <p className="shopsheet__note">The best book pays {(data.spread * 100).toFixed(0)}% more than the worst on this exact slip. That’s line shopping.</p>}
        <p className="shopsheet__fine">21+. Sports betting is legal only in some states. APEX doesn’t take bets and isn’t paid by these books. If gambling stops being fun, call 1-800-GAMBLER.</p>
      </div>
    </Dialog>
  )
}

/** One prop at every book, inline on the prop page. */
export function LineShop({ row }) {
  const { data } = useShop([row])
  const leg = data?.legs?.[0]
  const books = (leg?.books || []).slice(0, 8)
  const [open, setOpen] = useState(false)
  if (!data) return null
  return (
    <section className="lineshop" aria-labelledby="lineshop-h">
      <div className="lineshop__head">
        <h2 className="section-h" id="lineshop-h">
          Line shopping
        </h2>
        <button type="button" className="btn btn--quiet btn--s" onClick={() => setOpen(true)}>
          Send to sportsbook
        </button>
      </div>
      {books.length ? (
        <ul className="lineshop__list">
          {books.map((b, i) => {
            const e = evText(row.prob, b.price)
            const name = data.books.find((x) => x.book === b.book)?.name || b.book
            return (
              <li key={b.book} className={i === 0 ? 'is-best' : ''}>
                <span className="lineshop__book">{name}</span>
                <b className="num">{odds(b.price)}</b>
                <span className="num muted">{pct(impliedOf(b.price), 1)}</span>
                {e && <span className={`shop__ev ${e.ev >= 0 ? 'is-pos' : 'is-neg'}`}>{e.text}</span>}
                {i === 0 && <span className="shop__tag">Best</span>}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted">{data.oddsFeed ? `No book has posted a price on ${row.label} yet.` : 'No sportsbook price on this line yet. You can still open any book from the button above.'}</p>
      )}
      <SendToBook open={open} onClose={() => setOpen(false)} legs={[row]} p={row.prob} title="Bet it at a sportsbook" />
    </section>
  )
}

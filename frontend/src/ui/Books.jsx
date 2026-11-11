import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { odds, pct, impliedOf, decimalOf, bookName } from '../lib/format.js'
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

const sideWord = (leg) => (leg?.side === 'u' ? 'Under' : 'Over')
/** "BetMGM’s", "BetRivers’" */
const owner = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`)

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

/** The books on the slip's grid, in this order; the best price leads. */
export const FEATURED_BOOKS = ['fanduel', 'draftkings', 'betmgm', 'bet365', 'fanatics', 'betrivers', 'espnbet']
/** Each book's color, behind its initial when its icon can't load. */
const BOOK_COLOR = { fanduel: '#1493ff', draftkings: '#53d337', bet365: '#127b4f', espnbet: '#2756e8', betmgm: '#b8955a', williamhill_us: '#0f4d3a', fanatics: '#1d1d1f', betrivers: '#f2a43a' }
/** Shorter names where a tile is narrow. */
const TILE_NAME = { espnbet: 'theScore', williamhill_us: 'Caesars' }
const BOOK_HOME = {
  fanduel: 'https://sportsbook.fanduel.com/',
  draftkings: 'https://sportsbook.draftkings.com/',
  betmgm: 'https://www.betmgm.com/',
  bet365: 'https://www.bet365.com/',
  fanatics: 'https://sportsbook.fanatics.com/',
  betrivers: 'https://www.betrivers.com/',
  espnbet: 'https://thescore.bet/',
}
/** Where each book's own site icon lives (served by the icon service, never redrawn here). */
const ICON_SITE = {
  fanduel: 'fanduel.com',
  draftkings: 'sportsbook.draftkings.com',
  betmgm: 'betmgm.com',
  bet365: 'bet365.com',
  fanatics: 'fanatics.com',
  betrivers: 'betrivers.com',
  espnbet: 'thescore.bet',
  williamhill_us: 'sportsbook.caesars.com',
}

/** The book's own app icon, so people know it at a glance; its initial if the icon won't load. */
export function BookLogo({ book, size = 20 }) {
  const [failed, setFailed] = useState(false)
  const site = ICON_SITE[book]
  if (!site || failed) {
    return (
      <span className="booklogo booklogo--initial" style={{ width: size, height: size, fontSize: Math.round(size * 0.55), '--book': BOOK_COLOR[book] || 'var(--seat-2)' }} aria-hidden="true">
        {(TILE_NAME[book] || bookName(book) || '?').slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return <img className="booklogo" src={`https://www.google.com/s2/favicons?domain=${site}&sz=64`} width={size} height={size} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

/**
 * The slip's sportsbooks on one small grid, no scrolling: each book's icon, its live price for
 * the whole slip (or how many legs it has posted), the best price first and marked. A tap opens
 * the book's app, with every leg on its bet slip where the book's links allow (FanDuel),
 * otherwise the first leg or the book. onMore opens SendToBook: every book, and each leg.
 */
export function BookRail({ legs, parlay = true, onMore = null, copied = false }) {
  const { data, error } = useShop(legs)
  const [state] = useState(() => read('apex_state', 'NJ'))
  const n = legs.length
  // one price for the whole slip: a parlay, or a single bet
  const whole = parlay || n === 1
  const byKey = new Map((data?.books || []).map((b) => [b.book, b]))
  const best = whole && data?.best ? data.best : null
  const order = best ? [best, ...FEATURED_BOOKS.filter((k) => k !== best)] : [...FEATURED_BOOKS]
  const live = Boolean(data?.books?.some((b) => b.priced))
  return (
    <section className="bookrail" aria-labelledby="bookrail-h">
      <div className="bookrail__head">
        <h3 className="bookrail__title" id="bookrail-h">
          {copied ? 'Copied. Open it in your book' : 'Bet it at'}
          <span className={`bookrail__state${live ? ' is-live' : ''}`}>{!data && !error ? 'Getting odds…' : live ? 'Live odds' : 'No odds yet'}</span>
        </h3>
        {onMore && (
          <button type="button" className="linkish bookrail__more" onClick={onMore}>
            All books
          </button>
        )}
      </div>
      <ul className="bookrail__grid">
        {order.map((k) => {
          const b = byKey.get(k)
          const name = TILE_NAME[k] || b?.name || bookName(k)
          const isBest = best === k
          const href = withState(b?.link || BOOK_HOME[k] || null, state)
          let main = '…'
          let sub = 'Checking'
          const has = b ? b.priced + (b.near || 0) : 0
          // the slip at this book's own numbers (224.5 where the slip says 225.5)
          const alt = Boolean(b && whole && !b.complete && b.covered)
          if (b) {
            if (b.noFeed) {
              main = 'Open'
              sub = 'No odds feed'
            } else if (whole && b.complete) {
              main = odds(b.american)
              sub = b.allOnSlip ? (n > 1 ? `Adds all ${n}` : 'Adds the bet') : n > 1 ? `${n} of ${n} legs` : 'Opens the bet'
            } else if (alt) {
              main = odds(b.altAmerican)
              sub = n === 1 ? `${legs[0].side === 'u' ? 'Under' : 'Over'} ${b.lines[0]}` : 'Its own lines'
            } else if (has) {
              main = `${has}/${n}`
              sub = 'legs posted'
            } else {
              main = '—'
              sub = error ? 'Opens the app' : 'Not posted'
            }
          }
          const label = `Open ${b?.name || name}${b && whole && b.complete ? `, ${n > 1 ? 'parlay' : 'price'} ${odds(b.american)}` : alt ? `, ${odds(b.altAmerican)} at its own ${n > 1 ? 'lines' : 'line'}` : ''}${isBest ? ', best price' : ''}`
          const cls = `booktile${isBest ? ' is-best' : ''}${alt ? ' is-alt' : b && !b.complete && !b.noFeed ? ' is-short' : ''}`
          const inner = (
            <>
              <span className="booktile__top">
                <BookLogo book={k} size={20} />
                <span className={`booktile__price num${main.length > 5 ? ' is-long' : ''}`}>{main}</span>
              </span>
              <span className="booktile__name">{name}</span>
              <span className="booktile__sub">{sub}</span>
            </>
          )
          return (
            <li key={k}>
              {isBest && (
                <span className="booktile__best" aria-hidden="true">
                  Best
                </span>
              )}
              {href ? (
                <a className={cls} href={href} target="_blank" rel="noopener noreferrer" aria-label={label} onClick={() => write('apex_book', k)}>
                  {inner}
                </a>
              ) : (
                <span className={`${cls} is-short`}>{inner}</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function evText(p, american) {
  const d = decimalOf(american)
  if (!(p > 0) || !d) return null
  const ev = p * d - 1
  return { ev, text: `${ev >= 0 ? '+' : '−'}$${Math.abs(ev * 100).toFixed(0)} per $100` }
}

/**
 * The slip at every sportsbook, best price first: one compact row per book (its icon, its price,
 * a button that opens its app with the legs on its bet slip where the book's links allow), so the
 * whole list fits on a phone. "Legs" opens a book's leg-by-leg links and its own lines.
 */
export function SendToBook({ open, onClose, legs, p = null, title = 'Send to sportsbook', copied = false }) {
  const { data, error } = useShop(legs, { enabled: open })
  const anyPrice = data?.books?.some((b) => b.priced)
  const [state, setState] = useState(() => read('apex_state', 'NJ'))
  const [unfolded, setUnfolded] = useState(null)
  const mine = read('apex_book', '')
  const needsState = data?.books?.some((b) => [b.link, ...(b.legLinks || [])].some((u) => u && u.includes('{state}')))
  const go = (book) => write('apex_book', book)
  const n = legs.length

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="shopsheet">
        <p className={copied ? 'shopsheet__copied' : 'shopsheet__intro'}>
          {copied ? 'Copied. Pick a book: the button opens its app.' : `${n === 1 ? 'This bet' : `Your ${n}-leg parlay`} at every sportsbook, best price first.`}
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
              const has = b.priced + (b.near || 0)
              const legList = n > 1 && has > 0 && ((!b.allOnSlip && b.legLinks?.some(Boolean)) || b.near > 0 || !b.complete)
              const isOpen = unfolded === b.book
              let price = null
              let meta = null
              if (b.complete) {
                price = odds(b.american)
                meta = (
                  <>
                    <span className="num">{pct(impliedOf(b.american), 1)}</span>
                    {e && <span className={`shop__ev ${e.ev >= 0 ? 'is-pos' : 'is-neg'}`}>{e.text}</span>}
                  </>
                )
              } else if (b.noFeed) {
                meta = 'No price feed'
              } else if (b.covered) {
                price = odds(b.altAmerican)
                meta = n === 1 ? `${sideWord(legs[0])} ${b.lines[0]}, its line` : `At ${owner(b.name)} lines`
              } else if (has) {
                meta = `Has ${has} of ${n} legs`
              } else {
                meta = 'Not posted yet'
              }
              return (
                <li key={b.book} className={`shop${isBest ? ' is-best' : ''}${b.covered && !b.complete ? ' is-alt' : ''}`}>
                  <BookLogo book={b.book} size={28} />
                  <div className="shop__who">
                    <span className="shop__name">
                      {b.name}
                      {isBest && <span className="shop__tag">Best</span>}
                      {b.book === mine && !isBest && <span className="shop__tag shop__tag--mine">Yours</span>}
                    </span>
                    <span className="shop__meta">
                      {meta}
                      {legList && (
                        <button type="button" className="linkish shop__unfold" aria-expanded={isOpen} onClick={() => setUnfolded(isOpen ? null : b.book)}>
                          {isOpen ? 'Hide legs' : 'Legs'}
                        </button>
                      )}
                    </span>
                  </div>
                  <b className="shop__price num">{price ?? '—'}</b>
                  <a className={`btn btn--s ${isBest ? 'btn--lime' : 'btn--quiet'} shop__go`} href={withState(b.link, state)} target="_blank" rel="noopener noreferrer" aria-label={b.allOnSlip ? `Open ${b.name} with ${n > 1 ? 'all legs' : 'the bet'}` : `Open ${b.name}`} onClick={() => go(b.book)}>
                    {b.allOnSlip ? (n > 1 ? 'Add all' : 'Add bet') : 'Open'}
                  </a>
                  {legList && isOpen && (
                    <div className="shop__legs">
                      {legs.map((leg, i) => {
                        const own = b.lines?.[i] != null
                        const q = b.prices[i] ?? b.linePrices?.[i] ?? null
                        if (q == null) {
                          return (
                            <span key={i} className="shop__leg is-off">
                              Leg {i + 1}: not posted
                            </span>
                          )
                        }
                        const text = (
                          <>
                            Leg {i + 1}
                            {own && <span className="shop__line"> {sideWord(leg)} {b.lines[i]}</span>}
                            <span className="num"> {odds(q)}</span>
                          </>
                        )
                        const u = b.legLinks?.[i]
                        return u && !b.allOnSlip ? (
                          <a key={i} href={withState(u, state)} target="_blank" rel="noopener noreferrer" className={`shop__leg${own ? ' is-alt' : ''}`} aria-label={`Add leg ${i + 1} to your ${b.name} slip`} onClick={() => go(b.book)}>
                            {text}
                          </a>
                        ) : (
                          <span key={i} className={`shop__leg is-plain${own ? ' is-alt' : ''}`}>
                            {text}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
        {data?.books?.some((b) => b.near) && <p className="shopsheet__note">Grey prices are at the book’s own line, like 224.5 where your slip has 225.5.</p>}
        {needsState && (
          <label className="shopsheet__state">
            <span>Your state</span>
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
        <p className="shopsheet__fine">21+. Sports betting is legal only in some states. PropPickz doesn’t take bets and isn’t paid by these books. If gambling stops being fun, call <a href="tel:18006973738">1-800-MY-RESET</a>.</p>
      </div>
    </Dialog>
  )
}

/** One prop at every book, inline on the prop page. */
export function LineShop({ row }) {
  const { data } = useShop([row])
  const leg = data?.legs?.[0]
  const books = (leg?.books || []).slice(0, 8)
  // books on another number: their own line and price, after the ones at this line
  const others = (leg?.other || []).slice(0, Math.max(0, 8 - books.length))
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
      {books.length || others.length ? (
        <ul className="lineshop__list">
          {books.map((b, i) => {
            const e = evText(row.prob, b.price)
            const name = data.books.find((x) => x.book === b.book)?.name || b.book
            return (
              <li key={b.book} className={i === 0 ? 'is-best' : ''}>
                <span className="lineshop__book">
                  <BookLogo book={b.book} size={20} />
                  {name}
                </span>
                <b className="num">{odds(b.price)}</b>
                <span className="num muted">{pct(impliedOf(b.price), 1)}</span>
                {e && <span className={`shop__ev ${e.ev >= 0 ? 'is-pos' : 'is-neg'}`}>{e.text}</span>}
                {i === 0 && <span className="shop__tag">Best</span>}
              </li>
            )
          })}
          {others.map((b) => (
            <li key={b.book} className="is-alt">
              <span className="lineshop__book">
                <BookLogo book={b.book} size={20} />
                {data.books.find((x) => x.book === b.book)?.name || b.book}
              </span>
              <b className="num">{odds(b.price)}</b>
              <span className="num lineshop__line">
                {sideWord(row)} {b.line}, its line
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{data.oddsFeed ? `No book has posted a price on ${row.label} yet.` : 'No sportsbook price on this line yet. You can still open any book from the button above.'}</p>
      )}
      <SendToBook open={open} onClose={() => setOpen(false)} legs={[row]} p={row.prob} title="Bet it at a sportsbook" />
    </section>
  )
}

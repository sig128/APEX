import { useState } from 'react'
import { Link } from 'react-router-dom'

// The latest changes, at the top of the board until a visitor hides them. A new date shows it again.
const EDITION = '2026-11-20'
const KEY = 'apex_news_hidden'

function hidden() {
  try {
    return localStorage.getItem(KEY) === EDITION
  } catch {
    return false
  }
}

export function WhatsNew() {
  const [gone, setGone] = useState(hidden)
  if (gone) return null
  const hide = () => {
    try {
      localStorage.setItem(KEY, EDITION)
    } catch {
      /* blocked: it hides for this visit only */
    }
    setGone(true)
  }
  return (
    <section className="news" aria-labelledby="news-h">
      <header className="news__head">
        <h2 id="news-h" className="news__title">
          What’s new
        </h2>
        <time className="news__date" dateTime={EDITION}>
          November 20
        </time>
        <button type="button" className="news__hide" onClick={hide}>
          Hide
        </button>
      </header>
      <div className="news__grid">
        <article className="news__item news__item--consent">
          <h3>Consent in one tick</h3>
          <p>
            Entering the site is now one tick box: you’re of legal betting age, not under the influence, and you agree to the consent terms, Terms and Privacy Policy. It’s asked on every visit. The full wording is on the <Link to="/consent">Consent page</Link>, linked in the footer.
          </p>
        </article>
        <article className="news__item news__item--board">
          <h3>The members’ leaderboard</h3>
          <ul>
            <li>Paid members only, both to appear on it and to see the whole list.</li>
            <li>The top 3 sit on a podium, with gold, silver and bronze rings around their profile pictures and Instagram and X buttons.</li>
            <li>Everyone else is ranked below by tier, record, hit rate, units, average odds, streak and last-10 form.</li>
            <li>Filter by 30 days, 90 days or all time, any league and any number of legs, and rank by ROI, units, hit rate or CLV.</li>
            <li>Tiers go from Bronze up to Legend, based on the last 90 days.</li>
            <li>
              Free visitors see the podium; the rest unlocks with <Link to="/pricing">Pro</Link>.
            </li>
          </ul>
          <Link to="/picks" className="news__go">
            See the leaderboard
          </Link>
        </article>
        <article className="news__item news__item--leagues">
          <h3>Every league</h3>
          <p>The board, slip, picks, leaderboard, tour and feedback work for every league on PropPickz.</p>
        </article>
      </div>
    </section>
  )
}

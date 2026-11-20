import { useEffect, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { CONSENT_POINTS } from '../ui/ConsentGate.jsx'
import { useTitle } from '../lib/hooks.js'

const UPDATED = 'November 20, 2026'
const UPDATED_ISO = '2026-11-20'

// What PropPickz keeps and why, said the same way on the Consent page and in the Privacy Policy.
const DATA = [
  { what: 'Your account', has: 'Name, email and Google account id, if you sign in', why: 'To keep your picks, pass and settings' },
  { what: 'Picks you post', has: 'The picks, how they did, and your record', why: 'For your page, your record and the members’ leaderboard' },
  { what: 'Payments', has: 'The wallet address and transaction of each pass', why: 'To confirm your pass' },
  { what: 'Your consent', has: 'A random id for your browser, when you agreed, which version of the text, and the app version', why: 'To show you agreed' },
  { what: 'Feedback', has: 'Your message, the page you sent it from and your device type', why: 'To answer it and fix things' },
  { what: 'The tour', has: 'Daily counts of how many people start, finish or skip each step, with no names', why: 'To make getting started easier' },
  { what: 'Server logs', has: 'Addresses and request details, kept briefly', why: 'To block abuse and fix problems' },
]

function DataTable() {
  return (
    <table className="legal-table">
      <thead>
        <tr>
          <th scope="col">What we use</th>
          <th scope="col">What it includes</th>
          <th scope="col">Why</th>
        </tr>
      </thead>
      <tbody>
        {DATA.map((d) => (
          <tr key={d.what}>
            <th scope="row">{d.what}</th>
            <td>{d.has}</td>
            <td>{d.why}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DataCallout() {
  return (
    <div className="legal-callout">
      <p className="legal-callout__title">PropPickz uses your data.</p>
      <p>By entering the site you agree that PropPickz collects and uses the information below to run the site, keep your account and picks, and keep the service safe. We use it only for these reasons. We don’t sell it, and we don’t share it with sportsbooks.</p>
    </div>
  )
}

function Helplines() {
  return (
    <div className="legal-help">
      <a className="legal-help__line" href="tel:+18006973738">
        <span className="legal-help__where">United States</span>
        <span className="legal-help__num">1-800-MY-RESET</span>
        <span className="legal-help__who">National Problem Gambling Helpline</span>
      </a>
      <a className="legal-help__line" href="tel:+18665312600">
        <span className="legal-help__where">Ontario</span>
        <span className="legal-help__num">1-866-531-2600</span>
        <span className="legal-help__who">ConnexOntario</span>
      </a>
    </div>
  )
}

const CONSENT = {
  title: 'Consent',
  lead: 'What you agree to when you tick the box to enter PropPickz, and how PropPickz uses your data.',
  sections: [
    {
      id: 'tick-box',
      title: 'The tick box',
      body: (
        <>
          <div className="legal-tick" aria-label="The tick box shown when you enter">
            <span className="legal-tick__box" aria-hidden="true" />
            <p>I’m of legal betting age where I live, I’m not under the influence, and I agree to the consent terms, Terms and Privacy Policy, including how PropPickz uses my data.</p>
          </div>
          <p>It comes up on every visit, and nothing on PropPickz opens until it’s ticked. Ticking it confirms everything below.</p>
        </>
      ),
    },
    {
      id: 'confirm',
      title: 'What you confirm',
      body: (
        <ul className="legal-points">
          {CONSENT_POINTS.map((p) => (
            <li key={p.title}>
              <span className="legal-points__mark" aria-hidden="true" />
              <div>
                <p className="legal-points__title">{p.title}</p>
                <p className="legal-points__text">{p.text}</p>
              </div>
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: 'your-data',
      title: 'Your data',
      body: (
        <>
          <DataCallout />
          <DataTable />
          <p>Your bet slip, league and display settings stay in your browser, not on our servers. Who else handles your data, and how to have it deleted, is in the <Link to="/privacy">Privacy Policy</Link>.</p>
        </>
      ),
    },
    {
      id: 'help',
      title: 'Getting help',
      body: (
        <>
          <p>If gambling stops being fun, help is free and confidential.</p>
          <Helplines />
          <p>
            In your account you can set limits on your picks, take a break or exclude yourself: <Link to="/me#limits">Limits and breaks</Link>. More help in the US at{' '}
            <a href="https://www.ncpgambling.org/help-treatment/" target="_blank" rel="noopener noreferrer">
              ncpgambling.org
            </a>
            .
          </p>
        </>
      ),
    },
    {
      id: 'kept',
      title: 'How your consent is kept',
      body: (
        <p>
          We keep a record that this browser agreed to this version of the text, when, and the app version. Signed in, it’s kept with your account too. When the text changes, everyone is asked again. The full rules are in the <Link to="/terms">Terms of Service</Link>.
        </p>
      ),
    },
  ],
}

const TERMS = {
  title: 'Terms of Service',
  lead: 'These terms cover your use of PropPickz: the website, its stats and tools, passes and picks pages. By using PropPickz you agree to them.',
  sections: [
    {
      id: 'what',
      title: 'What PropPickz is',
      body: <p>PropPickz publishes sports statistics, probabilities and analysis for research. It is not a sportsbook: it doesn’t take bets, hold money for betting, or settle wagers, and it isn’t paid by the sportsbooks it links to. Links to a sportsbook open that book’s own site or app, under that book’s terms.</p>,
    },
    {
      id: 'confirm',
      title: 'What you confirm when you agree',
      body: (
        <>
          <ul className="legal-points">
            {CONSENT_POINTS.map((p) => (
              <li key={p.title}>
                <span className="legal-points__mark" aria-hidden="true" />
                <div>
                  <p className="legal-points__title">{p.title}</p>
                  <p className="legal-points__text">{p.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <p>You may only use PropPickz where sports betting information is lawful to access, and only bet where betting is legal for you.</p>
        </>
      ),
    },
    {
      id: 'guarantees',
      title: 'No guarantees',
      body: <p>Every pick, probability, projection, price comparison and note on PropPickz is information, not advice and not a promise. Sports results are uncertain, odds change, lineups change, and data can be late or wrong. Our published record shows how past picks did; it doesn’t predict how future ones will.</p>,
    },
    {
      id: 'decisions',
      title: 'Your bets are your decisions',
      body: <p>You decide whether to bet, how much, and where. To the fullest extent the law allows, PropPickz is not liable for any bet you win or lose, or for losses from relying on anything on the site, including stale or incorrect data or a sportsbook changing or voiding a bet.</p>,
    },
    {
      id: 'data',
      title: 'Your data',
      body: (
        <p>
          By using PropPickz you agree that we collect and use your data as described on the <Link to="/consent#your-data">Consent page</Link> and in the <Link to="/privacy">Privacy Policy</Link>. We don’t sell it.
        </p>
      ),
    },
    {
      id: 'passes',
      title: 'Accounts and passes',
      body: (
        <p>
          Paid features need a pass. Passes run 30 days from payment, are paid in USDC with no card and no auto-renew, and the features of each plan are listed on the <Link to="/pricing">Plans</Link> page. Daily limits on model reads and analyses apply as listed there. Keep your sign-in to yourself; you are responsible for what happens under your account.
        </p>
      ),
    },
    {
      id: 'posting',
      title: 'Picks pages and what you post',
      body: <p>Picks you post stay yours. You let PropPickz show them, grade them and include them in records and leaderboards. Picks lock at kickoff and every graded pick counts; we may hide pages or picks that break these terms. Don’t post anything unlawful, abusive or misleading, or present results you didn’t get.</p>,
    },
    {
      id: 'fair-use',
      title: 'Fair use',
      body: <p>Don’t scrape, resell or bulk-copy PropPickz data, get around limits or paywalls, or disrupt the service.</p>,
    },
    {
      id: 'responsible',
      title: 'Responsible play',
      body: (
        <>
          <p>
            You can set limits on your own picks, take a break, or exclude yourself from your account at any time (<Link to="/me#limits">Limits and breaks</Link>). If gambling stops being fun, help is free and confidential:
          </p>
          <Helplines />
        </>
      ),
    },
    {
      id: 'changes',
      title: 'Changes',
      body: <p>We may update these terms. When the consent statements change, you’ll be asked to agree again before using PropPickz.</p>,
    },
    {
      id: 'contact',
      title: 'Contact',
      body: <p>Questions about these terms: use Feedback at the bottom of any page.</p>,
    },
  ],
}

const PRIVACY = {
  title: 'Privacy Policy',
  lead: 'What PropPickz keeps about you, why we use it, and who else sees it.',
  sections: [
    {
      id: 'keep',
      title: 'What we keep and why',
      body: (
        <>
          <DataCallout />
          <DataTable />
        </>
      ),
    },
    {
      id: 'browser',
      title: 'Kept in your browser',
      body: <p>Your bet slip, league, state for sportsbook links, the books you used, the consent record and display preferences are kept in your browser’s storage, not on our servers, until you clear them.</p>,
    },
    {
      id: 'others',
      title: 'Who else sees it',
      body: (
        <>
          <ul className="legal-list">
            <li>Google Firebase (sign-in and database) and Vercel (hosting) run the service for us.</li>
            <li>An email service delivers your feedback to our inbox.</li>
            <li>When you ask for a model read, the prop’s stats go to the model provider (OpenAI or Anthropic). Don’t put personal details in questions.</li>
            <li>Sportsbook logos load from Google’s site-icon service, which sees the request but not the page you’re on.</li>
            <li>A sportsbook you open sees you arrive from PropPickz. We don’t share your data with sportsbooks and aren’t paid by them.</li>
          </ul>
          <p className="legal-strong">We don’t sell your data.</p>
        </>
      ),
    },
    {
      id: 'choices',
      title: 'Your choices',
      body: <p>You can stop posting picks, delete picks before they lock, and ask us to delete your account and data using Feedback at the bottom of any page. PropPickz is not for anyone under the legal betting age.</p>,
    },
    {
      id: 'changes',
      title: 'Changes',
      body: <p>We’ll update this page when what we keep changes, and you’ll be asked to agree again when the consent text changes.</p>,
    },
  ],
}

const DOCS = { consent: CONSENT, terms: TERMS, privacy: PRIVACY }
const ORDER = ['consent', 'terms', 'privacy']
const SHORT = { consent: 'Consent', terms: 'Terms', privacy: 'Privacy' }

/** The section in view, for the contents list. */
function useInView(ids) {
  const [cur, setCur] = useState(ids[0])
  const key = ids.join('|')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined
    const seen = new Map()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting)
        const first = key.split('|').find((id) => seen.get(id))
        if (first) setCur(first)
      },
      { rootMargin: '-20% 0px -65% 0px' },
    )
    for (const id of key.split('|')) {
      const el = document.getElementById(id)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [key])
  return cur
}

export function LegalPage({ doc }) {
  const D = DOCS[doc] || TERMS
  useTitle(D.title)
  const cur = useInView(D.sections.map((s) => s.id))
  // arriving on /consent#your-data: go to that section once it's on the page
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [doc])
  return (
    <div className="container page legal">
      <nav className="legal-docs" aria-label="Policies">
        {ORDER.map((k) => (
          <NavLink key={k} to={`/${k}`} className={({ isActive }) => `legal-docs__link${isActive ? ' is-on' : ''}`}>
            {SHORT[k]}
          </NavLink>
        ))}
      </nav>
      <header className="legal-head">
        <h1 className="legal-head__title">{D.title}</h1>
        <p className="legal-head__lead">{D.lead}</p>
        <p className="legal-head__date">
          Updated <time dateTime={UPDATED_ISO}>{UPDATED}</time>
        </p>
      </header>
      <div className="legal-layout">
        <nav className="legal-toc" aria-label="On this page">
          <p className="legal-toc__h">On this page</p>
          <ul>
            {D.sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} aria-current={cur === s.id ? 'location' : undefined}>
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <article className="legal-body">
          {D.sections.map((s) => (
            <section key={s.id} id={s.id} className="legal-sec" aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>{s.title}</h2>
              {s.body}
            </section>
          ))}
        </article>
      </div>
    </div>
  )
}

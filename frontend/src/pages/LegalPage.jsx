import { Link } from 'react-router-dom'
import { CONSENT_POINTS } from '../ui/ConsentGate.jsx'
import { useTitle } from '../lib/hooks.js'

const UPDATED = 'November 20, 2026'

function Terms() {
  return (
    <>
      <p className="legal__lead">These terms cover your use of PropPickz: the website, its stats and tools, passes and picks pages. By using PropPickz you agree to them.</p>
      <h2>What PropPickz is</h2>
      <p>PropPickz publishes sports statistics, probabilities and analysis for research. It is not a sportsbook: it doesn’t take bets, hold money for betting, or settle wagers, and it isn’t paid by the sportsbooks it links to. Links to a sportsbook open that book’s own site or app, under that book’s terms.</p>
      <h2>What you confirm when you agree</h2>
      <ul>
        {CONSENT_POINTS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p>You may only use PropPickz where sports betting information is lawful to access, and only bet where betting is legal for you.</p>
      <h2>No guarantees</h2>
      <p>Every pick, probability, projection, price comparison and note on PropPickz is information, not advice and not a promise. Sports results are uncertain, odds change, lineups change, and data can be late or wrong. Our published record shows how past picks did; it doesn’t predict how future ones will.</p>
      <h2>Your bets are your decisions</h2>
      <p>You decide whether to bet, how much, and where. To the fullest extent the law allows, PropPickz is not liable for any bet you win or lose, or for losses from relying on anything on the site, including stale or incorrect data or a sportsbook changing or voiding a bet.</p>
      <h2>Accounts and passes</h2>
      <p>Paid features need a pass. Passes run 30 days from payment, are paid in USDC with no card and no auto-renew, and the features of each plan are listed on the <Link to="/pricing">Plans</Link> page. Daily limits on model reads and analyses apply as listed there. Keep your sign-in to yourself; you are responsible for what happens under your account.</p>
      <h2>Picks pages and what you post</h2>
      <p>Picks you post stay yours. You let PropPickz show them, grade them and include them in records and leaderboards. Picks lock at kickoff and every graded pick counts; we may hide pages or picks that break these terms. Don’t post anything unlawful, abusive or misleading, or present results you didn’t get.</p>
      <h2>Fair use</h2>
      <p>Don’t scrape, resell or bulk-copy PropPickz data, get around limits or paywalls, or disrupt the service.</p>
      <h2>Responsible play</h2>
      <p>You can set limits on your own picks, take a break, or exclude yourself from your account at any time (<Link to="/me#limits">Limits and breaks</Link>). If gambling stops being fun, call 1-800-MY-RESET (US) or ConnexOntario at 1-866-531-2600 (Ontario).</p>
      <h2>Changes</h2>
      <p>We may update these terms. When the consent statements change, you’ll be asked to agree again before using PropPickz.</p>
      <h2>Contact</h2>
      <p>Questions about these terms: use Feedback at the bottom of any page.</p>
    </>
  )
}

function Consent() {
  return (
    <>
      <p className="legal__lead">When you enter PropPickz you tick one box. This is what it confirms.</p>
      <h2>By continuing, I confirm that</h2>
      <ul className="legal__checks">
        {CONSENT_POINTS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <h2>Getting help</h2>
      <p>
        If gambling stops being fun, help is free and confidential: 1-800-MY-RESET in the US (<a href="https://www.ncpgambling.org/help-treatment/" target="_blank" rel="noopener noreferrer">ncpgambling.org</a>), ConnexOntario at 1-866-531-2600 in Ontario. In your account you can set limits on your picks, take a break or exclude yourself (<Link to="/me#limits">Limits and breaks</Link>).
      </p>
      <h2>How it’s kept</h2>
      <p>We keep a record that this browser agreed to this version of the text, when, and the app version; signed in, it’s kept with your account too. When the text changes, everyone is asked again. More in the <Link to="/privacy">Privacy Policy</Link> and the <Link to="/terms">Terms of Service</Link>.</p>
    </>
  )
}

function Privacy() {
  return (
    <>
      <p className="legal__lead">What PropPickz keeps about you, why, and who else sees it.</p>
      <h2>What we keep</h2>
      <ul>
        <li>
          <b>Your account</b>, if you sign in: your name, email and Google account id, to keep your picks, pass and settings.
        </li>
        <li>
          <b>Payments</b>: the wallet address and transaction of each pass payment, to confirm it.
        </li>
        <li>
          <b>Picks you post</b>, their results and your record.
        </li>
        <li>
          <b>Your consent</b>: a random id for your browser, when you agreed, which version of the text, and the app version. Signed in, it’s also tied to your account.
        </li>
        <li>
          <b>Feedback you send</b>: your message, the page you sent it from and your device type. Your account details only when you tick the box to include them.
        </li>
        <li>
          <b>Onboarding tour</b>: daily counts of how many people start, finish or skip each step. No names.
        </li>
        <li>
          <b>Server logs</b>: addresses and request details, kept briefly to block abuse and fix problems.
        </li>
      </ul>
      <h2>Kept in your browser</h2>
      <p>Your bet slip, league, state for sportsbook links, the books you used, the consent record and display preferences are kept in your browser’s storage, not on our servers, until you clear them.</p>
      <h2>Who else sees it</h2>
      <ul>
        <li>Google Firebase (sign-in and database) and Vercel (hosting) run the service for us.</li>
        <li>An email service delivers your feedback to our inbox.</li>
        <li>When you ask for an AI read, the prop’s stats go to the AI provider (OpenAI or Anthropic). Don’t put personal details in questions.</li>
        <li>Sportsbook logos load from Google’s site-icon service, which sees the request but not the page you’re on.</li>
        <li>A sportsbook you open sees you arrive from PropPickz. We don’t share your data with sportsbooks and aren’t paid by them.</li>
      </ul>
      <p>We don’t sell your data.</p>
      <h2>Your choices</h2>
      <p>You can stop posting picks, delete picks before they lock, and ask us to delete your account and data using Feedback. PropPickz is not for anyone under the legal betting age.</p>
      <h2>Changes</h2>
      <p>We’ll update this page when what we keep changes.</p>
    </>
  )
}

const DOCS = {
  consent: { title: 'Consent', Body: Consent },
  terms: { title: 'Terms of Service', Body: Terms },
  privacy: { title: 'Privacy Policy', Body: Privacy },
}

export function LegalPage({ doc }) {
  const { title, Body } = DOCS[doc] || DOCS.terms
  useTitle(title)
  return (
    <div className="page legal">
      <header className="page-head">
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">Last updated {UPDATED}</p>
      </header>
      <article className="legal__body">
        <Body />
      </article>
    </div>
  )
}

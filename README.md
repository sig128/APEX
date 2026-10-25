# APEX

Player-prop research, live, for the NFL, NBA, MLB, NHL, college football, college basketball and
the WNBA: every prop on the slate with its hit rates, head to head, matchup, line move and the
APEX probability (shown as a percentage next to every price); game pages; a live tracker; a bet
slip that prices parlays fairly, shops the line across sportsbooks and sends the parlay to the
book's app; the 3-Leg Lock; and a picks showcase where every pick is graded from the box score.
Stats are free. Two passes, paid in USDC on Base:

| | Free | Pro ($29 / 30 days) | Elite ($79 / 30 days) |
|---|---|---|---|
| Props, hit rates, head to head, cheatsheets, matchups, line moves, My games | yes | yes | yes |
| Live tracker, bet slip with fair odds, copy and share | yes | yes | yes |
| Line shopping across books, "Send to sportsbook" | yes | yes | yes |
| Kelly calculator (OddsJam-style) | yes | yes | yes |
| Your picks page at /u/handle with an auto-graded record, tailing picks | yes | yes | yes |
| AI read of any prop (your APEX ruleset), AI game analyzer | | 15 / 8 a day | 30 / 15 a day |
| The 3-Leg Lock and its season ledger (the record is public) | | yes | yes |
| Parlay check: upload a betslip, AI keeps or cuts every leg | | yes | yes |
| Monte Carlo parlay simulator (10k-100k runs, luck vs skill) | | yes | yes |
| Game intel: injury reports and on-the-record reporting, tied to the props | | yes | yes |
| Kelly stake sizing in the slip and the bankroll simulator | | yes | yes |
| X and Instagram links on your page, Elite badge, the picks feed, the leaderboard | | | yes |

A pass runs 30 days. When it ends there are 7 days of grace with everything still on, then the
paid features lock until it's renewed. Renewing early stacks, and renewing during the grace week
starts the new 30 days where the old pass ended; switching plans converts unused days at the
price ratio. APEX never holds money: people send USDC straight to your wallet, and
the API checks the transfer on-chain.

## What's where

```
backend/     the API (Express). app.js builds it; server.js runs it locally.
  src/nfl/        live data engine, analytics, read models, routes (every league runs on it)
  src/sports/     what differs by sport: markets, positions, game logs, clocks (football,
                  basketball, hockey, baseball) and the league list (index.js)
  src/billing/    passes: invoices, on-chain checks, grace and lockout, allowances
  src/picks/      user pages, posting, grading, records, feed, leaderboard
  src/security/   sign-in, admin key, rate limits, stream tickets
  test/           123 tests on recorded ESPN data (NFL Week 7, an NBA day, NHL and MLB shapes)
frontend/    the site (React + Vite)
  src/pages/      Today, Props, Game, Prop, Player, Live, Slip, Picks, /u/:handle, Kelly, Plans, Account, Admin
  src/intro/      the opening animation
  src/apex/       the original multi-sport AI analyzer (at /apex)
functions/   Firebase Cloud Functions: runs backend/ (synced in at deploy) + invite codes
api/         the Vercel function (runs backend/ through backend/vercel.js)
scripts/     sync-functions.mjs (runs before every deploy), IAM fix script
firestore.rules, firestore.indexes.json, firebase.json, vercel.json
```

## Run it on your computer

You need Node 22 (`nvm use` reads `.nvmrc`).

```bash
npm run setup                       # installs root, backend, frontend and functions packages
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# put your ANTHROPIC_API_KEY in backend/.env, and your Firebase web config in frontend/.env
npm run dev                         # API on :8787, site on http://localhost:5173
```

The API pulls the live slate from ESPN as soon as it starts (give it a minute to fill in game
logs the first time). Without a treasury address the paywall is off, and locally the API runs
without Firebase credentials, so AI reads work without signing in. Add `?intro` to the URL to
replay the intro any time (it otherwise plays at most every 6 hours).

Tests:

```bash
npm test                            # backend: 93 tests, under a minute
npm test --prefix frontend          # slip, Kelly and wallet math
```

## Put it online with Vercel

The site and the API both run on Vercel; Firebase only does Google sign-in and the database
(Firebase's free plan is enough for that).

1. **Vercel project.** Import the GitHub repo. Root Directory can be empty (the repo root) or
   `frontend`; `vercel.json` sets the build either way. With `frontend`, keep "Include files
   outside the root directory in the Build Step" on (it's on by default).
2. **Firebase project.** In the Firebase console: Authentication, turn on the Google provider;
   Firestore Database, create a database. Under Authentication > Settings > Authorized domains,
   add your Vercel domain (like `apex-xyz.vercel.app`) and any custom domain.
3. **Environment variables** (Vercel > Settings > Environment Variables):

   | Variable | What it's for |
   |---|---|
   | `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | Google sign-in on the site (Firebase console > Project settings > Your apps > Web app) |
   | `FIREBASE_SERVICE_ACCOUNT` | The database: paste the whole JSON from Project settings > Service accounts > Generate new private key. Without it, stats and live tracking work, but passes, picks pages and codes stay off. |
   | `ANTHROPIC_API_KEY` | AI reads and the analyzer |
   | `APEX_ADMIN_EMAILS` | Your Google account(s): the admin page and every plan |
   | `ADMIN_SPORTS_KEY` | 24+ random characters, for scripts and `/adminn` |
   | `THE_ODDS_API_KEY` | Optional: sportsbook prices |
   | `APEX_TREASURY_ADDRESS`, `APEX_BILLING_NETWORK` | Payments (see below; start with `base-sepolia`) |
   | `VITE_PRIVY_APP_ID` | Optional: "Pay with Privy" |

   `VITE_*` values are built into the site, so redeploy after changing them.
4. **Firestore rules and indexes**, once, from your computer:
   `npx firebase-tools deploy --only firestore --project <your-project-id>` (or paste
   `firestore.rules` into the console's Rules tab; each missing index shows up in the function
   logs with a link that creates it).
5. Open `https://<your-domain>/api/health`: `you` should be your own IP, and `database` turns
   `true` once the service account is in.

On Vercel a function call can last 5 minutes, so live streams quietly reconnect every few
minutes (the browser does it on its own), and the first visit after a quiet spell is a cold
start while the data loads.

## Put it online (Firebase)

1. **Project.** Firebase project on the Blaze plan, with Authentication (Google provider),
   Firestore, and the Secret Manager API enabled. `firebase login`, then `firebase use <project>`
   (the repo points at `apexdashai`; change `.firebaserc` if that's not yours).
2. **Secrets** (never in files):
   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY
   firebase functions:secrets:set ADMIN_SPORTS_KEY     # 24+ random characters (openssl rand -hex 24)
   firebase functions:secrets:set THE_ODDS_API_KEY     # optional, adds sportsbook prices
   ```
3. **Settings.** `cp functions/.env.example functions/.env`, then set at least
   `APEX_ADMIN_EMAILS` (your Google account) and `APEX_PUBLIC_SITE_URL` (your site's address,
   used for the preview cards when people share their picks pages). Leave
   `APEX_TREASURY_ADDRESS` empty for now.
4. **Site config.** `cp frontend/.env.example frontend/.env.production` and fill in the Firebase
   web config, plus `VITE_API_BASE=https://us-central1-<project>.cloudfunctions.net/chat` and
   `VITE_PUBLIC_SITE_URL=https://<project>.web.app`.
5. **Deploy:** `npm run deploy` (builds the site, copies the API into functions/, deploys hosting,
   the function, Firestore rules and indexes). If the first deploy fails with "missing permission
   on the build service account", run `scripts/fix-cloud-functions-build-iam.sh <project>`.
6. In Firebase Authentication > Settings > Authorized domains, add your domain if you use a
   custom one, and add it to `APEX_ALLOWED_ORIGINS` in functions/.env.

New indexes take a few minutes to build after the first deploy; until then the picks feed and
user pages can answer with an error.

Check one thing once it's up: open `https://<project>.web.app/api/health` and
`https://us-central1-<project>.cloudfunctions.net/chat/api/health`. Both should show your own
public IP as `you` (that's what rate limits count). If either shows a Google or Fastly address
instead, add that range to `APEX_TRUSTED_PROXIES` in functions/.env and deploy again.

## Turn on payments

1. Use a wallet you control on Base (a hardware wallet or a fresh one just for APEX). Its address
   is the treasury; APEX only reads the chain and never needs its keys.
2. Try it on the test network first: set `APEX_BILLING_NETWORK=base-sepolia` and
   `APEX_TREASURY_ADDRESS=0x...` (in Vercel's environment variables, or functions/.env on
   Firebase), deploy, buy a pass with test USDC (Circle's faucet gives it out free), and watch it
   unlock. Passes need the database, so on Vercel set `FIREBASE_SERVICE_ACCOUNT` first.
3. Then switch to `APEX_BILLING_NETWORK=base` and deploy. Prices are `APEX_PRICE_PRO_USD` and
   `APEX_PRICE_ELITE_USD`; daily AI allowances are the `APEX_*_PER_DAY` settings.
4. Optional, for people without a crypto wallet: create a Privy app (privy.io), allow your domain
   in its dashboard, enable the Base network, then set `VITE_PRIVY_APP_ID` (Vercel's
   environment variables, or frontend/.env.production for Firebase) and redeploy. "Pay with Privy" signs them in with email or Google
   and gives them a self-custodial wallet; they still have to fund it with USDC (and a little
   ETH for the network fee).

How a payment works: the Account page asks for a payment request, which has an exact amount
like 29.004213 USDC (the last digits make it unique), valid for 24 hours. The person sends
exactly that to the treasury on Base, from a connected wallet or from anywhere, and APEX finds
the transfer (or takes the transaction hash), waits for 3 confirmations, and starts the pass.
A transaction can only ever pay one request.

## Leagues

Every league runs on the same engine, each with its own data, live stream and 3-Leg Lock
ledger. NFL is the site's root (`/`, `/nfl/props`); the others live under their key (`/nba`,
`/mlb/props`, `/nhl/lock`). The chip next to the logo switches league.

- `APEX_SPORTS=nfl,nba,mlb,nhl,ncaaf,ncaab,wnba` picks the leagues (all of them by default).
  A league starts loading on its first visit, so leagues nobody opens cost nothing.
- Weekly leagues (NFL, college football) key their slate by week; daily leagues by the day of
  the next game still to finish.
- Prices: ESPN carries DraftKings' prices for the NBA, MLB, NHL and WNBA lines, so those boards
  have edges and line shopping with no key. With `THE_ODDS_API_KEY`, the leagues in
  `APEX_ODDS_SPORTS` (default `nfl`; `all` for every league) get every book's prices: DraftKings,
  FanDuel, BetMGM, Caesars, Fanatics, BetRivers and theScore Bet. Each league spends its own
  `APEX_ODDS_DAILY_CREDITS`, so add leagues to match your Odds API plan. bet365 has no US feed;
  Caesars and Fanatics need a paid Odds API plan.
- A slip can mix leagues: the simulator, line shopping, the parlay check and picks all take
  legs from several leagues at once (legs from different leagues are independent).

## Running it

- **Admin:** signed in with an `APEX_ADMIN_EMAILS` account, the footer shows Admin: comp a pass
  to someone by email (or for life), revoke one, hide a page, see every payment. `/adminn` still
  turns sports on and off for the analyzer (with the admin key).
- **Codes:** invite codes and plan codes (e.g. 30 days of Elite) are explained in
  `firestore/inviteCodes.template.txt`; create them with `npm run seed-invites` in functions/.
- **Picks:** picks on any league lock when their first game starts and grade themselves from
  the final box score (a player who didn't play is voided after 18 hours). Only lines a sportsbook posted can go on a record,
  graded at the price posted when the pick was made; main lines with no listed price grade at
  -110. Alternate lines and anytime-TD props need a real price, which comes with
  `THE_ODDS_API_KEY`. The leaderboard needs 5 graded picks.
- **Data:** ESPN's public endpoints (scoreboard, summaries, rosters, game logs, prop lines).
  They are unofficial and can change; the API caches everything in Firestore and keeps
  serving the last good copy if ESPN has a bad minute. Prices come from The Odds API when its
  key is set. It spends at most `APEX_ODDS_DAILY_CREDITS` a day per league in `APEX_ODDS_SPORTS` and
  `APEX_ODDS_ANALYZER_DAILY_CREDITS` on the analyzer's odds pages; set them from your plan.
- **Scale:** Cloud Functions scales down to nothing when the site is quiet, so the first visitor
  after a lull waits a few seconds while the data loads; set `APEX_MIN_INSTANCES=1` in
  functions/.env on game days to keep one instance warm. Each open tab holds one live stream
  (billed as server time); background tabs let go of it after 30 seconds.

## Security notes

- The old build committed in this repo had `VITE_ADMIN_DEV_PASSWORD` baked into its JavaScript.
  That client-side admin login is gone, but if that password is used anywhere else, change it.
  Delete `VITE_ADMIN_DEV_PASSWORD` from your env files.
- Who is an admin and what plan someone has is decided by the API from their verified Google
  sign-in. Firestore rules block the browser from every billing, picks and data collection.
- Keep `.env` files and service-account JSON out of git (the .gitignore already does).
- Rate limits key on the caller's address, which only Firebase Hosting's CDN and Google's own
  proxies can vouch for (`APEX_TRUSTED_PROXIES`); a header a client writes itself is ignored.
  AI follow-ups have to continue an analysis the same account ran. Plan codes from
  `npm run seed-invites` carry about 80 random bits and each account gets 8 wrong tries an hour;
  if you type codes by hand in the console, make them just as long.

## Before you rely on it

This build was tested end to end against recorded ESPN data, a simulated live game, a scripted
blockchain and stand-ins for Firebase Auth and the Anthropic API. It has not yet run against
real Google sign-in, a real Base transaction, Privy, or a live Sunday, so do one real pass
purchase on base-sepolia and watch one live game before you announce it.

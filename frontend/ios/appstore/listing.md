# PropPickz on the App Store: what goes where

Everything App Store Connect asks for, ready to paste. Field lengths are checked against Apple's
limits (name and subtitle 30, promotional text 170, keywords 100). The pictures are in
`screenshots-6.3/` (1206 x 2622, the required iPhone size) and `screenshots-6.9/` (1320 x 2868),
in the order to upload them; `node scripts/brand/store.cjs` remakes them from `screens/`.

## App information

| Field | Value |
| --- | --- |
| Name | PropPickz |
| Subtitle | Player props, by the numbers |
| Bundle ID | com.proppickz.app |
| Primary category | Sports |
| Secondary category | Reference |
| Content rights | Uses third-party sports data (scores, rosters, stats); see the review notes |
| Age rating | 18+ (see below) |
| Support URL | https://proppickz.com/support |
| Marketing URL | https://proppickz.com |
| Privacy Policy URL | https://proppickz.com/privacy |
| Copyright | 2026 (the company's legal name) |
| Price | Free, with in-app purchases |
| Availability | United States only (the app links to proppickz.com to buy, which Apple allows on the US storefront) |

## Promotional text (153 of 170)

Build a parlay to your price and play it out before you bet. Every player prop as a chance to hit, for football, basketball, baseball, hockey and soccer.

## Keywords (100 of 100)

player props,parlay builder,prop bets,odds,hit rate,sports stats,picks,parlay,betting tools,football

## Description

PropPickz turns every player prop into a chance to hit, so you can see which lines the numbers back before you bet.

• The board: every prop on today's games with its chance to hit, the fair price and where the sportsbook line sits, for pro and college football and basketball, baseball, hockey and soccer.
• The numbers behind each line: game logs, hit rates over the last 5, 10 and 20 games, matchups, and injury and lineup news.
• Parlay builder: choose safe, balanced or longshot, how many legs and the price you want. It finds legs that fit together and shows how often the parlay cashes.
• Parlay simulator: play your slip out thousands of times, with legs that move together, and see how often it really cashes.
• Smart Check: notes on your slip as you build it, from injuries to legs that work against each other.
• Your record: post picks, track profit and hit rate by league and leg count, and climb the members' leaderboard.
• Alerts: results, injury news on your open picks and line moves, only the ones you turn on.
• Tips & Tricks: forty plain-English entries on props, parlays and the math, each with a worked example.

Pro and Elite passes unlock the parlay builder, the simulator, model reads and the full leaderboard. Passes run 30 days and don't renew on their own.

PropPickz is research, not a sportsbook: it doesn't take bets or hold money. Bet only where it's legal and you're of age. If gambling stops being fun, call 1-800-MY-RESET.

## What's New (version 1.0.0)

The first version of PropPickz for iPhone.

## In-app purchases

Set these up under Monetization in App Store Connect, each with a display name, a description and
a review screenshot (the purchase sheet from TestFlight). Prices are a suggestion near the
website's; Apple keeps 15% under the Small Business Program (apply for it before the first sale).

| Product ID | Type | Display name | Suggested price |
| --- | --- | --- | --- |
| com.proppickz.app.pro30 | Non-Renewing Subscription | Pro, 30 days | $29.99 |
| com.proppickz.app.elite30 | Non-Renewing Subscription | Elite, 30 days | $79.99 |
| com.proppickz.app.credits50 | Consumable | 50 credits | $14.99 |
| com.proppickz.app.credits150 | Consumable | 150 credits | $41.99 |
| com.proppickz.app.credits500 | Consumable | 500 credits | $134.99 |

Under App Information, set the App Store Server Notifications URL (version 2) to
`https://proppickz.com/api/billing/apple/notifications` for both production and sandbox, so
refunds take back what they bought.

The first purchases are reviewed together with the app: on the 1.0.0 version page, under In-App
Purchases and Subscriptions, add all five before pressing Submit. They can be bought in TestFlight
(sandbox, nothing charged) once the Paid Applications agreement is active.

## Age rating answers

- Gambling (real money): No. The app takes no bets and holds no money; sportsbook links open in Safari.
- Simulated gambling: Frequent. People post picks with stakes in units and are ranked on a leaderboard.
- Contests: None in the app.
- Unrestricted web access: No. Other sites open in Safari, outside the app.
- User-generated content: Yes. Picks pages, pick notes and group names; filtered, reportable, and people can be blocked.
- Everything else (violence, mature themes, medical, and so on): None.

Expect 18+.

## App Privacy answers

No data is used to track anyone, and none is sold. The same answers are in the app's privacy
manifest (`App/App/PrivacyInfo.xcprivacy`); change both together.

| Data type | What it is | Linked to the person | Purpose |
| --- | --- | --- | --- |
| Contact info: name, email address | From Sign in with Apple or Google (Apple can give a relay address) | Yes | App Functionality |
| Identifiers: user ID | The account id | Yes | App Functionality |
| Purchases: purchase history | Passes and credit packs, and Apple's purchase record | Yes | App Functionality |
| User content: other user content | Picks, notes, the picks page, group names | Yes | App Functionality |
| User content: customer support | Feedback and its screenshot, when sent | Yes | App Functionality |
| Usage data: product interaction | "Was this helpful?" taps and how far people get in the first-visit tour, counted by day | No | Analytics |
| Other data | A scrambled network fingerprint for fair-play checks, kept 30 days | Yes | App Functionality |

## Review notes

PropPickz is sports research: player prop statistics, probabilities and parlay tools. It does not take bets, hold money or pay out winnings. Links to sportsbooks open in Safari.

Sign in with Apple works with any Apple ID. Members' features (parlay builder, simulator, full leaderboard) need a pass: buy one in the app (sandbox), or open Account, tap "Have a code?" and enter APPREVIEW-PROPPICKZ for a 30-day Elite pass. Passes are non-renewing subscriptions and credit packs are consumables. On the US storefront the app also links to proppickz.com to buy (Guideline 3.1.1(a)).

User content: picks pages, pick notes and group names pass a word filter; any pick or page can be reported (Report, which reaches the team's feedback queue), and people can be blocked from their page (Block). The team can hide a page.

Account deletion: Account, then Delete account.

The app is for adults of legal betting age and shows problem-gambling help (1-800-MY-RESET).

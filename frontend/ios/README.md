# PropPickz for iPhone

The App Store app is the website's own screens in a native iOS shell (Capacitor 8), packaged
inside the app, plus what only an app does: Sign in with Apple and Google's native sheet, alerts
through Apple's push service, and links that open proppickz.com pages straight in the app. It
calls the same API as the website, so everything on proppickz.com is in it.

What's different inside the app, because of Apple's rules:

- **Passes and credit packs are bought with Apple** (in-app purchase: Apple's sheet, Face ID or a
  double-click, on as soon as Apple confirms). The server checks each purchase as Apple signed it,
  up to Apple's root certificate, grants it once and takes it back if Apple refunds it
  (`backend/src/billing/apple.js`). US users also get a link to buy on proppickz.com
  (Guideline 3.1.1(a)); crypto never unlocks anything inside the app (3.1.1).
- **No prize contests** in the first version (Apple has rejected free prediction contests with
  prizes as gambling).
- **Delete account** is on the Account page (Guideline 5.1.1(v)); the website has it too.
- **Sign in with Apple** sits next to Google (Guideline 4.8).
- **What people post is moderated** (Guideline 1.2): a word filter on pick notes, page names,
  bios and group names; Report on any pick or page; Block on any page; the admin can hide a page.

## Building

`npm run ios:sync` (in `frontend/`) builds the screens for the app and copies them into this
project. GitHub builds it on its Macs (`.github/workflows/ios.yml`): every change here compiles
for the simulator; run the workflow by hand with **Sign and upload to TestFlight** ticked to send a
build to TestFlight. Nobody needs to own a Mac. With one, `npx cap open ios` opens it in Xcode 26.

The icon and launch screen come from the brand shapes: `node scripts/brand/ios.cjs`.

## What the owner sets up, in order

Only the owner can do these: they're the company's accounts, and the keys are private.

1. **Apple Developer Program, as a company** ($99 a year). Apple wants apps in regulated areas
   like gambling from a legal entity, and a company needs a free D-U-N-S number, a work email on
   its own domain and a working website. Enroll at developer.apple.com/programs/enroll.
2. **The app's ID.** In Certificates, Identifiers & Profiles, add an App ID `com.proppickz.app` with
   Push Notifications, Sign in with Apple and Associated Domains turned on.
3. **The app in App Store Connect.** Apps, then New App: name PropPickz, bundle ID
   `com.proppickz.app`, iOS. In Business, sign the Paid Applications agreement and add the bank
   and tax details (purchases can't go on sale without them), and apply for the Small Business
   Program (15% instead of 30%). Then create the five in-app purchases and the refund
   notifications URL listed in `appstore/listing.md`.
4. **Two keys from Apple** (each downloads once as a `.p8` file; keep them safe):
   - Users and Access, Integrations, App Store Connect API: a **Team key with the Admin role**.
     Note its Key ID and the Issuer ID.
   - Certificates, Identifiers & Profiles, Keys: a key with **Apple Push Notifications service**.
     Note its Key ID, and the Team ID at the top right of the page.
5. **Firebase** (the same project as the website): Project settings, Add app, iOS, bundle ID
   `com.proppickz.app`, then download `GoogleService-Info.plist`. In Authentication, Sign-in
   method, turn on **Apple**. If the Firebase browser key has website restrictions in Google Cloud,
   add `capacitor://localhost` to them.
6. **GitHub** (this repo, Settings, Secrets and variables, Actions):
   - Secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the text of the App Store Connect
     `.p8`), `GOOGLE_SERVICE_INFO_PLIST` (the plist in base64: `base64 -i GoogleService-Info.plist`).
   - Variables: `APPLE_TEAM_ID`, and the six `VITE_FIREBASE_*` values from Vercel.
7. **Vercel** (apex, Settings, Environment Variables), then redeploy:
   `APNS_KEY` (the text of the push `.p8`), `APNS_KEY_ID`, `APNS_TEAM_ID`. With the team set,
   proppickz.com also serves the file that lets links open in the app.
8. **TestFlight.** GitHub, Actions, iPhone app, Run workflow, tick the upload box. About 20 minutes
   later the build is in App Store Connect; add yourself as a tester and install it with the
   TestFlight app.
9. **A pass code for Apple's reviewers.** In Firebase, Firestore, collection `inviteCodes`, add a
   document with the id `APPREVIEW-PROPPICKZ` and the fields `plan` = `elite`, `days` = 30 and
   `usesRemaining` = 20 (the review notes give the reviewer this code).
10. **App Review.** Everything App Store Connect asks for is in `appstore/listing.md`: name,
   subtitle, description, keywords, URLs, the age and privacy answers and the review notes; the
   pictures are in `appstore/screenshots-6.3/` and `appstore/screenshots-6.9/`. Then pick the
   TestFlight build and submit.

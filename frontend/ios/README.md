# PropPickz for iPhone

The App Store app is the website's own screens in a native iOS shell (Capacitor 8), packaged
inside the app, plus what only an app does: Sign in with Apple and Google's native sheet, alerts
through Apple's push service, and links that open proppickz.com pages straight in the app. It
calls the same API as the website, so everything on proppickz.com is in it.

What's different inside the app, because of Apple's rules:

- **Buying a pass or credits opens proppickz.com in Safari.** Apps can't sell digital content any
  other way than Apple's in-app purchase, and can't unlock anything with crypto; US apps may link
  to their own website's checkout (App Review Guideline 3.1.1(a)). A pass bought there shows up in
  the app as soon as it's paid. Guideline 3.1.3(b) also says passes bought elsewhere should be on
  sale in the app too, so App Review may ask for in-app purchases as well (Apple keeps 15% under
  the Small Business Program); that's the open decision in the dev meeting sheet.
- **No prize contests** in the first version (Apple has rejected free prediction contests with
  prizes as gambling).
- **Delete account** is on the Account page (Guideline 5.1.1(v)); the website has it too.
- **Sign in with Apple** sits next to Google (Guideline 4.8).

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
   `com.proppickz.app`, iOS. Sign the Paid Applications agreement too if passes will ever be sold
   in the app.
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
9. **App Review.** In App Store Connect: screenshots (6.9-inch iPhone), description, support URL,
   privacy policy `https://proppickz.com/privacy`, the age questions answered as they are (betting
   content rates 18+), App Privacy (email, name, user ID, picks you post, feedback you send),
   availability United States, and in the review notes a demo account plus: "PropPickz is sports
   research: stats, probabilities and picks. It takes no bets and holds no money. Passes are sold
   on proppickz.com (US storefront link, 3.1.1(a))."

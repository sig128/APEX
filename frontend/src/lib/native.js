// The iPhone app: these same screens inside a native iOS shell (Capacitor). Inside the app,
// sign-in, alerts and links to other sites go through iOS, and buying a pass opens
// proppickz.com in Safari (Apple's rules for apps: see ios/README.md). The app's build also sets
// VITE_NATIVE=1, which points the API at proppickz.com.
const env = import.meta.env || {}
export const NATIVE_BUILD = env.VITE_NATIVE === '1'
export const SITE = (env.VITE_PUBLIC_SITE_URL || 'https://proppickz.com').replace(/\/+$/, '')

export function isNative() {
  if (typeof window === 'undefined') return false
  return NATIVE_BUILD || Boolean(window.Capacitor?.isNativePlatform?.())
}

/** A page outside the app: Safari, or the sportsbook's own app when it claims the link. */
export function openOutside(url) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** proppickz.com in Safari, at this path (passes and credit packs are bought there). */
export const openSite = (path = '/') => openOutside(`${SITE}${path.startsWith('/') ? path : `/${path}`}`)

/**
 * Start-up inside the app: the status bar over the dark header, the splash screen off once the
 * first screen is up, proppickz.com links that open the app land on the same page in it, and a
 * tap on an alert opens what it's about.
 */
export async function startNative(navigate) {
  if (!isNative()) return
  document.documentElement.classList.add('is-native')
  const [{ StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([import('@capacitor/status-bar'), import('@capacitor/splash-screen'), import('@capacitor/app')])
  // each call guarded: a plugin missing from a build (or a browser preview) mustn't stop the rest
  const quiet = (fn) => {
    try {
      Promise.resolve(fn()).catch(() => {})
    } catch {
      /* not in this build */
    }
  }
  quiet(() => StatusBar.setStyle({ style: Style.Dark }))
  quiet(() => SplashScreen.hide())
  quiet(() =>
    App.addListener('appUrlOpen', ({ url }) => {
      const to = inAppPath(url)
      if (to) navigate(to)
    }),
  )
  const { PushNotifications } = await import('@capacitor/push-notifications')
  quiet(() =>
    PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      const to = inAppPath(a?.notification?.data?.url || '/')
      if (to) navigate(to)
    }),
  )
}

/** "https://proppickz.com/nba/prop/x" or "/me" -> "/nba/prop/x", "/me"; null for other sites. */
export function inAppPath(url) {
  try {
    const u = new URL(url, SITE)
    if (u.origin !== new URL(SITE).origin && u.protocol !== 'capacitor:') return null
    const path = `${u.pathname}${u.search}${u.hash}`
    return /^\/(?![/\\])/.test(path) && !path.startsWith('/api/') ? path : null
  } catch {
    return null
  }
}

// ---- sign-in inside the app: iOS's own Google and Apple sheets ------------------------------
// Google doesn't allow its sign-in inside an app's web view, and Apple asks for Sign in with
// Apple next to it. The native sheet hands back a credential; Firebase signs in with it here.
export async function nativeCredential(provider) {
  const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication')
  if (provider === 'apple') {
    const r = await FirebaseAuthentication.signInWithApple({ skipNativeAuth: true })
    return { provider: 'apple', idToken: r.credential?.idToken, rawNonce: r.credential?.nonce }
  }
  const r = await FirebaseAuthentication.signInWithGoogle({ skipNativeAuth: true })
  return { provider: 'google', idToken: r.credential?.idToken, accessToken: r.credential?.accessToken }
}

export async function nativeSignOut() {
  if (!isNative()) return
  const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication')
  await FirebaseAuthentication.signOut().catch(() => {})
}

// ---- alerts inside the app: Apple's push service --------------------------------------------
/** Asks iOS (its own question, after our button), then hands the device token to the server. */
export async function enableNativePush({ prefs, register }) {
  const { PushNotifications } = await import('@capacitor/push-notifications')
  let perm = await PushNotifications.checkPermissions()
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions()
  if (perm.receive !== 'granted') return { ok: false, permission: perm.receive === 'denied' ? 'denied' : 'default' }
  const token = await new Promise((resolve, reject) => {
    const subs = []
    const done = (fn) => (x) => {
      for (const s of subs) s.then((h) => h.remove()).catch(() => {})
      fn(x)
    }
    subs.push(PushNotifications.addListener('registration', done((t) => resolve(t.value))))
    subs.push(PushNotifications.addListener('registrationError', done((e) => reject(new Error(e?.error || 'iOS didn’t give this device an alerts token.')))))
    PushNotifications.register().catch(done(reject))
    setTimeout(done(() => reject(new Error('iOS didn’t answer. Try again.'))), 15_000)
  })
  try {
    localStorage.setItem('apex_native_push', token)
  } catch {
    /* storage blocked */
  }
  const status = await register(token, prefs)
  return { ok: true, permission: 'granted', status }
}

export async function nativePushState() {
  if (!isNative()) return { permission: 'unsupported', token: null }
  const { PushNotifications } = await import('@capacitor/push-notifications')
  const perm = await PushNotifications.checkPermissions().catch(() => ({ receive: 'prompt' }))
  let token = null
  try {
    token = localStorage.getItem('apex_native_push')
  } catch {
    token = null
  }
  return { permission: perm.receive === 'granted' ? 'granted' : perm.receive === 'denied' ? 'denied' : 'default', token: perm.receive === 'granted' ? token : null }
}

export async function forgetNativePush() {
  try {
    localStorage.removeItem('apex_native_push')
  } catch {
    /* storage blocked */
  }
  const { PushNotifications } = await import('@capacitor/push-notifications')
  await PushNotifications.unregister().catch(() => {})
}

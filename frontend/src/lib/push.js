// Alerts on this device (web push). The browser asks the person; we only ever ask after a tap on
// our own "Turn on alerts" button, never on page load. iPhone and iPad only allow it from the app
// or a site added to the Home Screen.
import { api } from './api.js'

export function pushEnv() {
  if (typeof window === 'undefined') return { supported: false, permission: 'unsupported' }
  const ua = navigator.userAgent || ''
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = Boolean(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true)
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const mac = /Macintosh/.test(ua) && !ios
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'your browser'
  return { supported, ios, standalone, mac, browser, permission: supported ? Notification.permission : 'unsupported' }
}

const deviceLabel = () => {
  const e = pushEnv()
  return `${e.ios ? 'iPhone or iPad' : e.mac ? 'Mac' : /Android/.test(navigator.userAgent) ? 'Android' : /Windows/.test(navigator.userAgent) ? 'Windows' : 'Computer'}, ${e.browser}`
}

function keyBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  return reg ? reg.pushManager.getSubscription() : null
}

/** Call straight from the button's click: the browser's own question comes first. */
export async function enablePush({ publicKey, prefs }) {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, permission }
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }))
  const status = await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs, device: deviceLabel() } })
  return { ok: true, permission, status }
}

export async function disablePush() {
  const sub = await currentSubscription()
  if (!sub) return
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {})
  await sub.unsubscribe().catch(() => {})
}

// "Not now": ask again in a week
const SNOOZE = 'apex_push_snooze'
export function snoozed() {
  try {
    return Number(localStorage.getItem(SNOOZE)) > Date.now()
  } catch {
    return false
  }
}
export function snooze(days = 7) {
  try {
    localStorage.setItem(SNOOZE, String(Date.now() + days * 86_400_000))
  } catch {
    /* blocked */
  }
}

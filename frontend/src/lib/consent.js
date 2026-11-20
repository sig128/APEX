// The consent screen: whether this browser has accepted the current text, and recording it.
// The version matches backend/src/members/service.js CONSENT_VERSION; changing the text means
// bumping both, and everyone is asked again.
import { api } from './api.js'

export const CONSENT_VERSION = '2026-11-20'
/* global __APP_VERSION__ */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
const KEY = 'apex_consent'
const DEVICE = 'apex_device'

const store = () => {
  try {
    localStorage.setItem('apex_probe', '1')
    localStorage.removeItem('apex_probe')
    return localStorage
  } catch {
    try {
      return sessionStorage
    } catch {
      return null
    }
  }
}

/** A random id for this browser, so a consent can be shown to belong to it. No personal data. */
export function deviceId() {
  const s = store()
  let id = s?.getItem(DEVICE)
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    id = `d_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
    try {
      s?.setItem(DEVICE, id)
    } catch {
      /* blocked */
    }
  }
  return id
}

export function hasConsented() {
  try {
    const v = JSON.parse(store()?.getItem(KEY) || 'null')
    return v?.version === CONSENT_VERSION
  } catch {
    return false
  }
}

/** Record the acceptance here at once and on the server (signed in, with the account too). */
export async function giveConsent() {
  try {
    store()?.setItem(KEY, JSON.stringify({ version: CONSENT_VERSION, at: Date.now() }))
  } catch {
    /* blocked: asked again next visit */
  }
  return sendConsent()
}

export function sendConsent() {
  return api('/api/members/consent', { method: 'POST', body: { agree: true, device: deviceId(), version: CONSENT_VERSION, app: APP_VERSION } }).catch(() => null)
}

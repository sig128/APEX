// The consent screen: whether this browser has accepted the current text, and recording it.
// The version matches backend/src/members/service.js CONSENT_VERSION; changing the text means
// bumping both, and everyone is asked again.
import { api } from './api.js'

export const CONSENT_VERSION = '2026-11-21'
/* global __APP_VERSION__ */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
const KEY = 'apex_consent'
// agreed during this visit (the popup comes back on the next one)
const VISIT = 'apex_consent_visit'
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

/** Asked on every visit: agreed in this browser session to the current text. */
export function hasConsented() {
  try {
    return sessionStorage.getItem(VISIT) === CONSENT_VERSION
  } catch {
    return false
  }
}

/** Whether this browser's acceptance of the current text is already on the server. */
function recorded() {
  try {
    return JSON.parse(store()?.getItem(KEY) || 'null')?.version === CONSENT_VERSION
  } catch {
    return false
  }
}

/** Agree for this visit; the first time on this browser (per text version) it's recorded on the server too. */
export async function giveConsent() {
  try {
    sessionStorage.setItem(VISIT, CONSENT_VERSION)
  } catch {
    /* blocked: asked again next time */
  }
  if (recorded()) return null
  try {
    store()?.setItem(KEY, JSON.stringify({ version: CONSENT_VERSION, at: Date.now() }))
  } catch {
    /* blocked */
  }
  return sendConsent()
}

export function sendConsent() {
  return api('/api/members/consent', { method: 'POST', body: { agree: true, device: deviceId(), version: CONSENT_VERSION, app: APP_VERSION } }).catch(() => null)
}

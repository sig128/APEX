// A member's setup: the leagues they follow (the first is where PropPickz opens), how odds read,
// where they bet, and their sportsbooks. Kept in this browser so it applies at once, and with the
// account (/api/members/prefs) so the website and the iPhone app agree.
import { useEffect, useState } from 'react'
import { api } from './api.js'
import { setOddsFormat } from './format.js'
import { bookState } from './regions.js'
import { isSport, sp } from './leagues.js'

const KEY = 'apex_prefs'
const EVENT = 'apex:prefs'
const EMPTY = { leagues: [], odds: 'american', region: null, books: [], onboarded: null }

export function readPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || '{}') || {}
    return { ...EMPTY, ...p, leagues: (p.leagues || []).filter(isSport) }
  } catch {
    return { ...EMPTY }
  }
}

function keep(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
    // the slip's sportsbook links open in the member's state
    const st = bookState(p.region)
    if (st) localStorage.setItem('apex_state', st)
  } catch {
    /* private mode: it applies for this visit */
  }
  setOddsFormat(p.odds)
  window.dispatchEvent(new Event(EVENT))
}

/** Save some answers: at once in this browser, then with the account. `done` finishes the setup. */
export async function savePrefs(part, { done = false } = {}) {
  const next = { ...readPrefs(), ...part }
  keep(next)
  const out = await api('/api/members/prefs', { method: 'POST', body: { ...part, ...(done ? { done: true } : {}) } }).catch(() => null)
  if (out) keep({ ...next, ...out })
  return out
}

/** The account's setup, into this browser (signing in on another device or the app). */
export async function loadPrefs() {
  const out = await api('/api/members/prefs').catch(() => null)
  if (out) keep({ ...readPrefs(), ...out })
  return out
}

/** The setup, kept current when it changes anywhere in the app. */
export function usePrefs() {
  const [p, setP] = useState(readPrefs)
  useEffect(() => {
    const on = () => setP(readPrefs())
    window.addEventListener(EVENT, on)
    window.addEventListener('storage', on)
    return () => {
      window.removeEventListener(EVENT, on)
      window.removeEventListener('storage', on)
    }
  }, [])
  return p
}

/**
 * Where signing in lands: where they were headed, else the home page of their first league (never
 * Account). Someone who hasn't been through the setup (a new account) gets it first, over that
 * page, unless they're on their way to buy a pass.
 */
export function landingAfterSignIn(p, next = null) {
  const first = (p?.leagues || []).find(isSport)
  const to = next || sp(first || 'nfl')
  return p && !p.onboarded && !/[?&]buy=/.test(to) ? withSetup(to) : to
}

// a signed-in member's setup is about to open (the first-visit tour waits for another visit)
let pending = false
export const setupPending = () => pending
export const markSetupPending = (v) => {
  pending = Boolean(v)
}

// where the setup never opens by itself: signing in (it follows that), the admin and legal pages
const NO_SETUP = /^\/(login|admin|adminn|consent|terms|privacy)(\/|$)/

/** Whether a signed-in member who hasn't been through the setup gets it here, on its own. */
export function setupDue(p, { pathname = '/', search = '' } = {}) {
  return Boolean(p && !p.onboarded) && !NO_SETUP.test(pathname) && !/[?&](welcome|buy)=/.test(search)
}

/** A path with the setup opened over it ("/nba?welcome=1"). */
export function withSetup(path) {
  const [base, hash = ''] = String(path || '/').split('#')
  const url = new URL(base, 'https://x.invalid')
  url.searchParams.set('welcome', '1')
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ''}`
}

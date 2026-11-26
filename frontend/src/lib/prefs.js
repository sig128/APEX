// A member's setup: the leagues they follow (the first is where PropPickz opens), how odds read,
// where they bet, and their sportsbooks. Kept in this browser so it applies at once, and with the
// account (/api/members/prefs) so the website and the iPhone app agree.
import { useEffect, useState } from 'react'
import { api } from './api.js'
import { setOddsFormat } from './format.js'
import { bookState } from './regions.js'
import { isSport } from './leagues.js'

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

/** A path with the setup opened over it ("/nba?welcome=1"). */
export function withSetup(path) {
  const [base, hash = ''] = String(path || '/').split('#')
  const url = new URL(base, 'https://x.invalid')
  url.searchParams.set('welcome', '1')
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ''}`
}

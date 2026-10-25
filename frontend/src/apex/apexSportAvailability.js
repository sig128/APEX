/** Odds API sport_key values — order matches analyzer select. */
export const APEX_SPORT_KEYS_ORDER = [
  'baseball_mlb',
  'icehockey_nhl',
  'basketball_nba',
  'americanfootball_nfl',
]

/** League filter on schedule search → sport_key */
const ODDS_OPT_TO_KEY = {
  all: null,
  nfl: 'americanfootball_nfl',
  nba: 'basketball_nba',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
}

/**
 * @param {HTMLElement} root
 * @param {string[]} disabledSportKeys
 */
export function applySportAvailabilityToRoot(root, disabledSportKeys) {
  const dis = new Set(Array.isArray(disabledSportKeys) ? disabledSportKeys : [])
  const firstEnabled =
    APEX_SPORT_KEYS_ORDER.find((k) => !dis.has(k)) || 'baseball_mlb'

  const analyzeSel = root.querySelector('#apex-analyze-sport')
  if (analyzeSel instanceof HTMLSelectElement) {
    analyzeSel.querySelectorAll('option').forEach((opt) => {
      const v = opt.value
      const off = dis.has(v)
      opt.disabled = off
      opt.hidden = off
    })
    if (dis.has(analyzeSel.value)) {
      analyzeSel.value = firstEnabled
      analyzeSel.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  const oddsSel = root.querySelector('#apex-odds-sport')
  if (oddsSel instanceof HTMLSelectElement) {
    oddsSel.querySelectorAll('option').forEach((opt) => {
      const val = opt.value
      let off = false
      if (val === 'all') {
        off = APEX_SPORT_KEYS_ORDER.every((k) => dis.has(k))
      } else {
        const sk = ODDS_OPT_TO_KEY[val]
        off = Boolean(sk && dis.has(sk))
      }
      opt.disabled = off
      opt.hidden = off
    })
    const cur = oddsSel.selectedOptions[0]
    if (cur?.disabled) {
      const first = oddsSel.querySelector('option:not([disabled])')
      if (first instanceof HTMLOptionElement) {
        oddsSel.value = first.value
        oddsSel.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
  }
}

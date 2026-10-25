/**
 * System-wide sport availability (Odds API sport_key values).
 * - Production: Firestore doc `apexConfig/sports` field `disabledSportKeys` (string[]).
 * - Local override: `APEX_DISABLED_SPORTS` in backend/.env (comma-separated keys). If set, Firestore is not read.
 */

export const APEX_SPORT_KEYS = ['baseball_mlb', 'icehockey_nhl', 'basketball_nba', 'americanfootball_nfl']

export const APEX_SPORT_LABELS = {
  baseball_mlb: 'MLB',
  icehockey_nhl: 'NHL',
  basketball_nba: 'NBA',
  americanfootball_nfl: 'NFL',
}

/** @returns {string[] | null} null = env not set, use Firestore */
function parseEnvDisabled() {
  if (!Object.prototype.hasOwnProperty.call(process.env, 'APEX_DISABLED_SPORTS')) return null
  const raw = process.env.APEX_DISABLED_SPORTS
  if (raw == null || String(raw).trim() === '') return null
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((k) => APEX_SPORT_KEYS.includes(k))
}

/**
 * @param {string[]} keys
 * @param {string[]} disabled
 */
export function filterEnabledSportKeys(keys, disabled) {
  const d = new Set(disabled)
  return keys.filter((k) => !d.has(k))
}

async function readDisabledFromFirestore() {
  try {
    const { default: admin } = await import('firebase-admin')
    if (!admin.apps.length) {
      admin.initializeApp()
    }
    const snap = await admin.firestore().collection('apexConfig').doc('sports').get()
    const arr = snap.data()?.disabledSportKeys
    if (!Array.isArray(arr)) return []
    return arr.filter((k) => typeof k === 'string' && APEX_SPORT_KEYS.includes(k))
  } catch (e) {
    console.warn('[sportsConfig] Firestore read failed:', e?.message || e)
    return []
  }
}

/**
 * @returns {Promise<string[]>} disabled sport keys (empty = all enabled)
 */
export async function getDisabledSportKeys() {
  const fromEnv = parseEnvDisabled()
  if (fromEnv !== null) return fromEnv
  return readDisabledFromFirestore()
}

/**
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string[]} disabledSportKeys
 */
export async function writeDisabledSportKeysToFirestore(db, disabledSportKeys) {
  const valid = Array.isArray(disabledSportKeys)
    ? disabledSportKeys.filter((k) => typeof k === 'string' && APEX_SPORT_KEYS.includes(k))
    : []
  await db.collection('apexConfig').doc('sports').set(
    {
      disabledSportKeys: valid,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  )
}

import { getDisabledSportKeys, writeDisabledSportKeysToFirestore, APEX_SPORT_KEYS, APEX_SPORT_LABELS } from './sportsConfig.js'
import { checkAdminKey } from './src/security/adminKey.js'

/**
 * @param {import('express').Application} app
 * @param {{ getAdminKey: () => string | undefined, getFirestore?: () => import('firebase-admin').firestore.Firestore | null }} opts
 */
export function registerAdminSportsRoutes(app, opts) {
  const { getAdminKey, getFirestore } = opts

  app.get('/api/config/sports', async (_req, res) => {
    try {
      const disabledSportKeys = await getDisabledSportKeys()
      res.set('Cache-Control', 'no-store')
      res.json({
        disabledSportKeys,
        sportKeys: APEX_SPORT_KEYS,
        labels: APEX_SPORT_LABELS,
      })
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  })

  app.post('/api/admin/sports', async (req, res) => {
    const expected = typeof getAdminKey === 'function' ? getAdminKey() : ''
    // constant-time compare, and an address that keeps guessing is locked out for a while
    const key = checkAdminKey(req, expected)
    if (key === 'blocked') {
      res.status(429).set('Retry-After', '900').json({ error: 'Too many wrong admin keys from this address. Try again later.' })
      return
    }
    if (key !== 'ok') {
      res.status(401).json({ error: 'Invalid or missing X-Apex-Admin-Key.' })
      return
    }
    const raw = req.body?.disabledSportKeys
    if (!Array.isArray(raw)) {
      res.status(400).json({ error: 'Body must include disabledSportKeys: string[]' })
      return
    }
    const db = typeof getFirestore === 'function' ? getFirestore() : null
    if (!db) {
      res.status(503).json({
        error:
          'Firestore is not available on this server. Use deployed Cloud Functions with ADMIN_SPORTS_KEY, or run backend with Firebase Admin credentials.',
      })
      return
    }
    try {
      await writeDisabledSportKeysToFirestore(db, raw)
      const disabledSportKeys = await getDisabledSportKeys()
      res.json({ ok: true, disabledSportKeys })
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) })
    }
  })
}

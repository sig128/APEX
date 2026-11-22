// /api/admin/model-test: our formulas against the language model on props already graded
// (src/modeltest/service.js), behind the admin password like the rest of /api/admin.
import express from 'express'
import { ApiError } from '../lib/router.js'
import { log, errText } from '../lib/log.js'

export function modelTestRoutes({ lock, test }) {
  const r = express.Router()
  const wrap = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      lock.require(req)
      const out = await fn(req, res)
      if (!res.headersSent) res.json(out ?? { ok: true })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ error: e.message, code: e.code })
      log.error('model test route failed', { path: req.path, err: errText(e) })
      res.status(500).json({ error: 'The test hit a server error. Try again in a minute.', code: 'internal' })
    }
  }
  r.get('/', wrap(() => test.status()))
  r.post('/start', wrap((req) => test.start({ size: Number(req.body?.size) || undefined, restart: req.body?.restart === true })))
  // each step asks about a few batches (well inside one request's time limit); the page repeats it
  r.post('/step', wrap(() => test.step()))
  r.post('/stop', wrap(() => test.stop()))
  return r
}

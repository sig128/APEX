// Adaptive task loop. Each task decides its own next interval (fast when games are live,
// slow overnight) and backs off on errors.
import { log, errText } from './log.js'

export function createScheduler({ tasks = [] } = {}) {
  const state = new Map()
  let running = false

  function plan(t) {
    const s = state.get(t.name)
    if (!running || s.timer) return
    const base = s.backoff || Math.max(1000, Number(t.every()) || 60_000)
    const jitter = base * (t.jitter ?? 0.1) * (Math.random() * 2 - 1)
    s.next = Date.now() + base + jitter
    s.timer = setTimeout(() => run(t), base + jitter)
    if (typeof s.timer.unref === 'function') s.timer.unref()
  }

  async function run(t) {
    const s = state.get(t.name)
    s.timer = null
    if (!running) return
    if (s.busy) return plan(t)
    s.busy = true
    const started = Date.now()
    try {
      await t.run()
      s.backoff = 0
      s.ok++
      s.lastMs = Date.now() - started
    } catch (e) {
      s.fail++
      s.lastError = errText(e)
      s.backoff = Math.min(300_000, (s.backoff || 5000) * 2)
      log.warn('task failed', { task: t.name, err: s.lastError, retryInMs: s.backoff })
    } finally {
      s.busy = false
      s.lastRun = Date.now()
      plan(t)
    }
  }

  for (const t of tasks) state.set(t.name, { ok: 0, fail: 0, backoff: 0, timer: null, busy: false })

  return {
    start() {
      if (running) return
      running = true
      for (const t of tasks) {
        if (t.runAtStart === false) plan(t)
        else run(t)
      }
    },
    stop() {
      running = false
      for (const s of state.values()) {
        if (s.timer) clearTimeout(s.timer)
        s.timer = null
      }
    },
    /** Run a task now (e.g. when a request finds data missing). */
    poke(name) {
      const t = tasks.find((x) => x.name === name)
      const s = t && state.get(name)
      if (!t || !running || s.busy) return
      if (s.timer) clearTimeout(s.timer)
      s.timer = null
      run(t)
    },
    status: () =>
      Object.fromEntries(
        [...state].map(([k, s]) => [k, { ok: s.ok, fail: s.fail, lastRun: s.lastRun || null, next: s.next || null, lastError: s.lastError || null, lastMs: s.lastMs ?? null }]),
      ),
  }
}

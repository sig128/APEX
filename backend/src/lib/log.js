// One-line JSON logs (Cloud Logging parses them); readable in a terminal too.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
const threshold = () => LEVELS[String(process.env.APEX_LOG_LEVEL || '').toLowerCase()] ?? (process.env.NODE_ENV === 'test' ? 40 : 20)

function emit(level, msg, extra) {
  if (LEVELS[level] < threshold()) return
  const line = { severity: level.toUpperCase(), msg, ...(extra && typeof extra === 'object' ? extra : {}) }
  const out = level === 'error' || level === 'warn' ? console.error : console.log
  try {
    out(JSON.stringify(line))
  } catch {
    out(`${level}: ${msg}`)
  }
}

export const log = {
  debug: (msg, extra) => emit('debug', msg, extra),
  info: (msg, extra) => emit('info', msg, extra),
  warn: (msg, extra) => emit('warn', msg, extra),
  error: (msg, extra) => emit('error', msg, extra),
}

export function errText(e) {
  return e?.message || String(e)
}

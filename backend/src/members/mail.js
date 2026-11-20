// Feedback to the team's inbox through a mail service, picked by which key is set:
// RESEND_API_KEY, SENDGRID_API_KEY or POSTMARK_SERVER_TOKEN. FEEDBACK_TO is the inbox,
// FEEDBACK_FROM a sender the service has verified. Nothing is sent from the visitor's device,
// and the inbox address never reaches the app.
import { log } from '../lib/log.js'

const KIND = { bug: 'Bug', feature: 'Feature request', pick: 'Pick quality', general: 'General' }

export function mailConfig(env = process.env) {
  const to = String(env.FEEDBACK_TO || '').trim()
  const from = String(env.FEEDBACK_FROM || 'PropPickz <feedback@proppickz.com>').trim()
  const provider = env.RESEND_API_KEY ? 'resend' : env.SENDGRID_API_KEY ? 'sendgrid' : env.POSTMARK_SERVER_TOKEN ? 'postmark' : null
  return { to, from, provider, ready: Boolean(to && provider) }
}

export function feedbackEmail(item) {
  const stars = item.rating ? ` (${item.rating}/5)` : ''
  const subject = `[PropPickz feedback] ${KIND[item.kind] || 'General'}${stars}: ${item.message.slice(0, 60).replace(/\s+/g, ' ')}`
  const lines = [
    item.message,
    '',
    '---',
    `Kind: ${KIND[item.kind] || item.kind}`,
    item.rating ? `Rating: ${item.rating}/5` : null,
    item.about ? `About: ${item.about}` : null,
    item.page ? `Page: ${item.page}` : null,
    item.app ? `App version: ${item.app}` : null,
    item.device ? `Device: ${item.device}` : null,
    item.user ? `Account: ${item.user.name || ''} ${item.user.email || ''} (${item.user.uid})`.trim() : 'Account: not shared',
    `Received: ${new Date(item.at).toISOString()}`,
    `Id: ${item.id}`,
  ].filter((x) => x !== null)
  return { subject, text: lines.join('\n'), replyTo: item.user?.email || null }
}

/** A mail(item) function for createMembers, or null when no service is set up. */
export function createMailer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = mailConfig(env)
  if (!cfg.ready) return null
  return async function mail(item) {
    const { subject, text, replyTo } = feedbackEmail(item)
    let res
    if (cfg.provider === 'resend') {
      res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      })
    } else if (cfg.provider === 'sendgrid') {
      const m = /<([^>]+)>/.exec(cfg.from)
      res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: cfg.to }] }],
          from: { email: m ? m[1] : cfg.from },
          subject,
          content: [{ type: 'text/plain', value: text }],
          ...(replyTo ? { reply_to: { email: replyTo } } : {}),
        }),
      })
    } else {
      res = await fetchImpl('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ From: cfg.from, To: cfg.to, Subject: subject, TextBody: text, ...(replyTo ? { ReplyTo: replyTo } : {}), MessageStream: 'outbound' }),
      })
    }
    if (!res.ok) {
      log.warn('feedback mail refused', { provider: cfg.provider, status: res.status })
      return false
    }
    return true
  }
}

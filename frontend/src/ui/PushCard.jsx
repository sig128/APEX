import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useApi } from '../lib/useApi.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { pushEnv, enablePush, disablePush, currentSubscription, snoozed, snooze } from '../lib/push.js'
import { isNative, enableNativePush, nativePushState, forgetNativePush } from '../lib/native.js'

// Alerts on this device: our own short ask first ("Get alerts when your picks move?"), and only a
// tap on "Turn on alerts" brings up the browser's question. Blocked, unsupported and iPhone each
// get plain directions instead of a button that can't work. In the iPhone app the question is
// iOS's own and alerts come through Apple's push service.

const LEVELS = [
  ['big', 'Big moves'],
  ['all', 'Every change'],
  ['risk', 'Only picks at risk'],
  ['off', 'Off'],
]

function Blocked({ env }) {
  const how =
    env.browser === 'Safari'
      ? 'In Safari, open Settings, then Websites, then Notifications, and set PropPickz to Allow.'
      : env.browser === 'Firefox'
        ? 'Click the icon to the left of the address bar, clear the blocked notifications permission, then reload.'
        : `Click the icon to the left of the address bar in ${env.browser}, set Notifications to Allow, then reload.`
  return (
    <div className="push-help">
      <p>
        <b>Alerts are blocked for this site.</b> {how}
      </p>
      {env.mac && <p>On a Mac, also check System Settings, then Notifications, then {env.browser}: notifications must be allowed there too.</p>}
    </div>
  )
}

export function PushCard() {
  const { user } = useAuth()
  const { member } = useBilling()
  const cfg = useApi('/api/push/config', { maxAgeMs: 10 * 60_000 }).data
  const [env, setEnv] = useState(pushEnv)
  const [status, setStatus] = useState(null)
  const [here, setHere] = useState(false) // this browser is subscribed
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [later, setLater] = useState(snoozed)
  const native = isNative()
  const [nativeState, setNativeState] = useState({ permission: 'default', token: null })

  useEffect(() => {
    if (!user) return
    api('/api/push/status').then(setStatus, () => {})
    if (native)
      nativePushState().then((st) => {
        setNativeState(st)
        setHere(Boolean(st.token))
      }, () => {})
    else currentSubscription().then((s) => setHere(Boolean(s)), () => {})
  }, [user, native])

  if (!user) return null
  const prefs = status?.prefs || { results: true, injuries: true, ticker: 'big' }
  const save = async (next) => {
    setStatus((s) => ({ ...(s || {}), prefs: { ...prefs, ...next } }))
    const out = await api('/api/push/prefs', { method: 'POST', body: { prefs: { ...prefs, ...next } } }).catch(() => null)
    if (out) setStatus(out)
  }
  const turnOn = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const out = native
        ? await enableNativePush({ prefs, register: (token, p) => api('/api/push/native/subscribe', { method: 'POST', body: { token, prefs: p, device: 'iPhone app' } }) })
        : await enablePush({ publicKey: cfg.publicKey, prefs })
      if (native) setNativeState(await nativePushState())
      else setEnv(pushEnv())
      if (out.ok) {
        setStatus(out.status)
        setHere(true)
        setMsg('Alerts are on for this device.')
      } else if (out.permission === 'denied') setMsg(null)
      else setMsg('No problem. You can turn alerts on here any time.')
    } catch (e) {
      setMsg(e?.message || 'That didn’t work. Try again.')
    }
    setBusy(false)
  }
  const turnOff = async () => {
    setBusy(true)
    if (native) {
      if (nativeState.token) await api('/api/push/native/unsubscribe', { method: 'POST', body: { token: nativeState.token } }).catch(() => null)
      await forgetNativePush()
      setNativeState(await nativePushState())
    } else await disablePush()
    setHere(false)
    setBusy(false)
    setMsg('Alerts are off for this device.')
    api('/api/push/status').then(setStatus, () => {})
  }

  let body
  if (native) {
    if (cfg && !cfg.native) body = <p className="muted small">Alerts in the app aren’t switched on for PropPickz yet.</p>
    else if (nativeState.permission === 'denied')
      body = (
        <div className="push-help">
          <p>
            <b>Alerts are off for PropPickz in iOS.</b> Open Settings, then Notifications, then PropPickz, and turn on Allow Notifications.
          </p>
        </div>
      )
  } else if (cfg && !cfg.enabled) body = <p className="muted small">Alerts on phones and browsers aren’t switched on for PropPickz yet.</p>
  else if (env.ios && !env.standalone) body = <p className="small">On iPhone and iPad, alerts come through the PropPickz app. In Safari they only work after adding the site to your Home Screen (Share, then Add to Home Screen, iOS 16.4 or later).</p>
  else if (!env.supported) body = <p className="muted small">This browser can’t show alerts. Chrome, Edge, Firefox and Safari can.</p>
  else if (env.permission === 'denied') body = <Blocked env={env} />
  if (body === undefined && !here)
    body = later ? (
      <button type="button" className="btn btn--quiet btn--s" onClick={() => setLater(false)}>
        Set up alerts on this device
      </button>
    ) : (
      <div className="push-ask">
        <p className="push-ask__q">Get alerts when your picks move?</p>
        <ul>
          <li>When your picks are graded, won or lost</li>
          <li>Injury news on players in your open picks</li>
          {member && <li>Line moves on PropPickz picks, past the level you choose</li>}
        </ul>
        <p className="muted small">{native ? 'iPhone will ask you to allow notifications next. You can turn them off here, or in Settings, any time.' : 'Your browser will ask you to allow notifications next. You can turn them off here, or in the browser, any time.'}</p>
        <div className="row">
          <button type="button" className="btn btn--lime" onClick={turnOn} disabled={busy || (native ? !cfg?.native : !cfg?.publicKey)}>
            {busy ? 'One moment' : 'Turn on alerts'}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              snooze(7)
              setLater(true)
            }}
          >
            Not now
          </button>
        </div>
      </div>
    )
  else if (body === undefined)
    body = (
      <div className="push-on">
        <label className="check">
          <input type="checkbox" checked={prefs.results} onChange={(e) => save({ results: e.target.checked })} />
          Results of my picks
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.injuries} onChange={(e) => save({ injuries: e.target.checked })} />
          Injury news on my open picks
        </label>
        {member ? (
          <label className="field field--inline">
            <span>Line moves on PropPickz picks</span>
            <select value={prefs.ticker} onChange={(e) => save({ ticker: e.target.value })}>
              {LEVELS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="muted small">
            Line-move alerts come with the live ticker in <Link to="/pricing">Pro</Link>.
          </p>
        )}
        <div className="row">
          <button
            type="button"
            className="btn btn--quiet btn--s"
            onClick={async () => {
              const r = await api('/api/push/test', { method: 'POST' }).catch(() => null)
              setMsg(r?.sent ? 'Sent. It should show up in a moment.' : 'Nothing was sent. Check that this device still allows alerts.')
            }}
          >
            Send a test
          </button>
          <button type="button" className="btn btn--quiet btn--s" onClick={turnOff} disabled={busy}>
            Turn off on this device
          </button>
        </div>
        {env.mac && <p className="muted small">Not seeing them? On a Mac, System Settings, then Notifications, then {env.browser} must allow notifications too.</p>}
        {status?.devices > 1 && <p className="muted small">Alerts are on for {status.devices} of your devices.</p>}
      </div>
    )
  return (
    <section className="push" id="alerts" aria-labelledby="push-h">
      <h2 id="push-h" className="acct-plan__k">
        Alerts on this device
      </h2>
      {body}
      {msg && (
        <p className="push-msg" role="status">
          {msg}
        </p>
      )}
    </section>
  )
}

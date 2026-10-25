import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { PRIVY_APP_ID } from '../lib/config.js'
import { injected, accounts, payUsdc, walletError } from '../lib/wallet.js'
import { useCopy } from '../lib/hooks.js'
import { useBilling } from '../context/BillingContext.jsx'

const PrivyPay = PRIVY_APP_ID ? lazy(() => import('./PrivyPay.jsx')) : null
const POLL_MS = 4000
const POLL_MAX = 75 // five minutes

/**
 * Buy or renew a pass: get a payment request with an exact USDC amount, pay it (Privy, a
 * browser wallet, or by hand from anywhere), then APEX checks the chain until it's confirmed.
 */
export function PayFlow({ plan, onDone }) {
  const { refresh, config } = useBilling()
  const [inv, setInv] = useState(null)
  const [step, setStep] = useState('creating') // creating | pay | checking | paid | error
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)
  const [hash, setHash] = useState('')
  const polls = useRef(0)
  const alive = useRef(true)
  useEffect(() => () => (alive.current = false), [])

  useEffect(() => {
    setStep('creating')
    api('/api/billing/invoice', { method: 'POST', body: { plan } })
      .then((x) => {
        if (!alive.current) return
        setInv(x)
        setStep('pay')
      })
      .catch((e) => {
        if (!alive.current) return
        setErr(e)
        setStep('error')
      })
  }, [plan])

  const finish = useCallback(async () => {
    setStep('paid')
    await refresh()
  }, [refresh])

  const check = useCallback(
    async (txHash) => {
      setErr(null)
      setStep('checking')
      polls.current = 0
      const once = async () => {
        if (!alive.current) return
        polls.current++
        try {
          const r = txHash ? await api(`/api/billing/invoice/${inv.id}/confirm`, { method: 'POST', body: { txHash } }) : await api(`/api/billing/invoice/${inv.id}/scan`, { method: 'POST' })
          if (r.status === 'paid') return finish()
          if (r.status === 'used') {
            setErr(new Error('That transaction already paid another request.'))
            return setStep('pay')
          }
          setNote(r.status === 'confirming' ? `Seen on-chain: ${r.confirmations} of ${r.needed} confirmations.` : r.status === 'not_found' ? 'Not on-chain yet. Payments usually show up within a minute.' : 'Waiting for the transaction to be mined.')
        } catch (e) {
          if (e.code === 'slow_down') {
            /* keep polling */
          } else if (e.status >= 400 && e.status < 500) {
            setErr(e)
            return setStep('pay')
          }
        }
        if (polls.current >= POLL_MAX) {
          setNote('Still not confirmed. If you sent it, paste the transaction hash below, or check again in a few minutes.')
          return setStep('pay')
        }
        setTimeout(once, txHash ? POLL_MS : POLL_MS * 4)
      }
      once()
    },
    [inv, finish],
  )

  const payInjected = async () => {
    const w = injected()
    if (!w) return
    setErr(null)
    try {
      const [from] = await accounts(w)
      const tx = await payUsdc(w, { from, token: inv.token, to: inv.treasury, units: inv.units, chainId: inv.chainId })
      setHash(tx)
      check(tx)
    } catch (e) {
      setErr(new Error(walletError(e)))
    }
  }

  if (step === 'creating') return <p className="muted">Making your payment request…</p>
  if (step === 'error')
    return (
      <p className="form-err" role="alert">
        {err?.message}
      </p>
    )
  if (step === 'paid')
    return (
      <div className="stack pay-done">
        <p className="pay-done__title">You're in. {inv.planName} is on.</p>
        <p className="muted">Your pass runs 30 days from today (added to any time you had left).</p>
        <button type="button" className="btn btn--gold" onClick={onDone}>
          Done
        </button>
      </div>
    )
  return (
    <div className="pay stack">
      <div className="pay__amount">
        <p className="pay__k">Send exactly</p>
        <p className="pay__v">
          <span className="num">{inv.amount}</span> USDC
        </p>
        <p className="muted small">
          On {inv.networkName}. The last digits make the payment yours, so send this exact amount. Request valid until {new Date(inv.expiresAt).toLocaleString()}.
        </p>
      </div>
      {config?.testnet && <p className="notice">Test network: use test USDC from a faucet, not real money.</p>}

      {step === 'checking' ? (
        <div className="pay__checking" role="status">
          <span className="spinner" aria-hidden="true" />
          <p>{note || 'Checking the chain…'}</p>
        </div>
      ) : (
        <>
          {PrivyPay && (
            <Suspense fallback={<p className="muted">Loading wallet sign-in…</p>}>
              <PrivyPay appId={PRIVY_APP_ID} invoice={inv} onHash={(tx) => (setHash(tx), check(tx))} onError={(e) => setErr(new Error(walletError(e)))} />
            </Suspense>
          )}
          {injected() && (
            <button type="button" className={`btn btn--block ${PrivyPay ? 'btn--quiet' : 'btn--gold'}`} onClick={payInjected}>
              Pay with my browser wallet
            </button>
          )}
          <ManualPay inv={inv} />
          <div className="pay__after">
            <button type="button" className="btn btn--quiet" onClick={() => check(null)}>
              I've sent it, find my payment
            </button>
            <form
              className="pay__hash"
              onSubmit={(e) => {
                e.preventDefault()
                if (/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) check(hash.trim())
                else setErr(new Error('A transaction hash is 0x followed by 64 characters.'))
              }}
            >
              <label className="field">
                <span>Or paste the transaction hash</span>
                <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" autoCapitalize="none" spellCheck="false" />
              </label>
              <button type="submit" className="btn btn--quiet">
                Check
              </button>
            </form>
          </div>
          {note && <p className="muted small">{note}</p>}
        </>
      )}
      {err && (
        <p className="form-err" role="alert">
          {err.message}
        </p>
      )}
    </div>
  )
}

function ManualPay({ inv }) {
  const [copyAmt, amtCopied] = useCopy()
  const [copyAddr, addrCopied] = useCopy()
  return (
    <details className="manual" open={!injected() && !PRIVY_APP_ID}>
      <summary>Send it from any wallet or exchange</summary>
      <dl className="manual__facts">
        <div>
          <dt>Amount</dt>
          <dd>
            <code>{inv.amount}</code> USDC
            <button type="button" className="linkish" onClick={() => copyAmt(inv.amount)}>
              {amtCopied ? 'Copied' : 'Copy'}
            </button>
          </dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>
            <code className="manual__addr">{inv.treasury}</code>
            <button type="button" className="linkish" onClick={() => copyAddr(inv.treasury)}>
              {addrCopied ? 'Copied' : 'Copy'}
            </button>
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{inv.networkName} only. USDC sent on another network can't be matched.</dd>
        </div>
      </dl>
      <a className="btn btn--quiet btn--block" href={inv.payUri}>
        Open in a wallet app
      </a>
    </details>
  )
}

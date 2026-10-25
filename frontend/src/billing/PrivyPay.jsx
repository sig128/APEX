// Loaded only when VITE_PRIVY_APP_ID is set. Privy signs people in (email, Google or an
// existing wallet) and gives anyone without a wallet a self-custodial one; the payment is then
// the same USDC transfer as any other wallet, approved by the user in Privy's window.
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth'
import { useState } from 'react'
import { payUsdc } from '../lib/wallet.js'

const CHAINS = {
  8453: { id: 8453, name: 'Base', network: 'base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://mainnet.base.org'] }, public: { http: ['https://mainnet.base.org'] } }, blockExplorers: { default: { name: 'Basescan', url: 'https://basescan.org' } } },
  84532: { id: 84532, name: 'Base Sepolia', network: 'base-sepolia', testnet: true, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://sepolia.base.org'] }, public: { http: ['https://sepolia.base.org'] } }, blockExplorers: { default: { name: 'Basescan', url: 'https://sepolia.basescan.org' } } },
}

export default function PrivyPay({ appId, invoice, onHash, onError }) {
  const chain = CHAINS[invoice.chainId] || CHAINS[8453]
  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: { theme: 'dark', accentColor: '#fcd800', showWalletLoginFirst: false },
        loginMethods: ['email', 'google', 'wallet'],
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      <Inner invoice={invoice} onHash={onHash} onError={onError} />
    </PrivyProvider>
  )
}

function Inner({ invoice, onHash, onError }) {
  const { ready, authenticated, login, logout } = usePrivy()
  const { wallets, ready: walletsReady } = useWallets()
  const [busy, setBusy] = useState(false)
  const w = wallets?.[0]
  if (!ready) return <p className="muted">Loading wallet sign-in…</p>
  if (!authenticated)
    return (
      <button type="button" className="btn btn--gold btn--block" onClick={() => login()}>
        Pay with Privy (email, Google or wallet)
      </button>
    )
  if (!walletsReady || !w) return <p className="muted">Setting up your wallet…</p>
  const pay = async () => {
    setBusy(true)
    try {
      if (typeof w.switchChain === 'function') await w.switchChain(invoice.chainId)
      const provider = await w.getEthereumProvider()
      const tx = await payUsdc(provider, { from: w.address, token: invoice.token, to: invoice.treasury, units: invoice.units, chainId: invoice.chainId })
      onHash(tx)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="privy stack">
      <button type="button" className="btn btn--gold btn--block" onClick={pay} disabled={busy}>
        {busy ? 'Approve in your wallet' : `Pay ${invoice.amount} USDC`}
      </button>
      <p className="muted small">
        From {w.walletClientType === 'privy' ? 'your Privy wallet' : 'your wallet'} <code>{w.address.slice(0, 6)}…{w.address.slice(-4)}</code>
        {w.walletClientType === 'privy' ? `. It needs ${invoice.amount} USDC on ${invoice.networkName} plus a little ETH for the network fee; send them to this address first.` : '.'}{' '}
        <button type="button" className="linkish" onClick={() => logout()}>
          Use another
        </button>
      </p>
    </div>
  )
}

// Paying with a wallet: a plain USDC transfer on Base to the Propify wallet, for the exact amount
// on the payment request. Works with any EIP-1193 provider (a browser wallet, or the wallet
// Privy gives the user). Propify never signs anything; the wallet asks the user.
export const BASE_CHAINS = {
  8453: { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  84532: { chainId: '0x14a34', chainName: 'Base Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'] },
}

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')

/** ERC-20 transfer(to, amount) calldata. */
export function transferData(to, units) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('Bad recipient address.')
  const amount = BigInt(units)
  if (amount <= 0n) throw new Error('Bad amount.')
  return `0xa9059cbb${pad(to)}${pad(amount.toString(16))}`
}

export function injected() {
  return typeof window !== 'undefined' && window.ethereum && typeof window.ethereum.request === 'function' ? window.ethereum : null
}

export async function accounts(provider) {
  const list = await provider.request({ method: 'eth_requestAccounts' })
  if (!list?.length) throw new Error('No account was shared by the wallet.')
  return list
}

/** Ask the wallet to switch to Base (adding it if the wallet doesn't know it). */
export async function ensureChain(provider, chainId) {
  const hex = `0x${Number(chainId).toString(16)}`
  const cur = await provider.request({ method: 'eth_chainId' }).catch(() => null)
  if (cur && Number.parseInt(cur, 16) === Number(chainId)) return
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (e) {
    if (e?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || '')) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [BASE_CHAINS[chainId]] })
    } else throw e
  }
}

/** Send the exact USDC amount; resolves with the transaction hash once the wallet submits it. */
export async function payUsdc(provider, { from, token, to, units, chainId }) {
  await ensureChain(provider, chainId)
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to: token, data: transferData(to, units), value: '0x0' }] })
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('The wallet did not return a transaction hash.')
  return hash
}

/** Wallet errors in words people understand. */
export function walletError(e) {
  if (e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || '')) return 'You cancelled in your wallet. Nothing was sent.'
  if (/insufficient/i.test(e?.message || '')) return 'Not enough USDC (or ETH for the network fee) in that wallet on Base.'
  return e?.message || 'The wallet could not send the payment.'
}

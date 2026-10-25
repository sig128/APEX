// Read-only JSON-RPC checks against Base: did this exact USDC transfer land, to us, and is it
// buried deep enough? No keys, no signing, nothing that can move funds.
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const padAddress = (a) => `0x${'0'.repeat(24)}${String(a).toLowerCase().replace(/^0x/, '')}`
const topicAddress = (t) => `0x${String(t).slice(-40).toLowerCase()}`
const hexBig = (h) => {
  try {
    return BigInt(h || '0x0')
  } catch {
    return -1n
  }
}

export function createChain({ rpcUrl, chainId, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  let id = 0
  let chainChecked = false

  async function rpc(method, params = []) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctrl.signal,
      })
      if (!res.ok) throw Object.assign(new Error(`RPC HTTP ${res.status}`), { code: 'rpc' })
      const j = await res.json()
      if (j.error) throw Object.assign(new Error(j.error.message || 'RPC error'), { code: 'rpc' })
      return j.result
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error('RPC timed out'), { code: 'rpc_timeout' })
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  async function ensureChain() {
    if (chainChecked) return
    const c = Number(hexBig(await rpc('eth_chainId')))
    if (c !== Number(chainId)) throw Object.assign(new Error(`RPC is on chain ${c}, expected ${chainId}`), { code: 'wrong_chain' })
    chainChecked = true
  }

  async function blockNumber() {
    return Number(hexBig(await rpc('eth_blockNumber')))
  }

  /**
   * status: ok | pending (no receipt yet) | confirming | failed (reverted) | mismatch (no matching
   * Transfer of exactly `amount` to `to` from `token` in this transaction).
   */
  async function verifyTransfer({ txHash, token, to, amount, minConfirmations = 3 }) {
    await ensureChain()
    const receipt = await rpc('eth_getTransactionReceipt', [txHash])
    if (!receipt) return { status: 'pending' }
    if (receipt.status !== '0x1') return { status: 'failed' }
    const want = BigInt(amount)
    const match = (receipt.logs || []).find(
      (l) =>
        !l.removed &&
        String(l.address).toLowerCase() === String(token).toLowerCase() &&
        Array.isArray(l.topics) &&
        l.topics.length === 3 &&
        String(l.topics[0]).toLowerCase() === TRANSFER_TOPIC &&
        topicAddress(l.topics[2]) === String(to).toLowerCase() &&
        hexBig(l.data) === want,
    )
    if (!match) return { status: 'mismatch' }
    const block = Number(hexBig(receipt.blockNumber))
    const head = await blockNumber()
    const confirmations = head - block + 1
    if (confirmations < minConfirmations) return { status: 'confirming', confirmations, needed: minConfirmations }
    const b = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false])
    return { status: 'ok', from: topicAddress(match.topics[1]), blockNumber: block, confirmations, timestamp: Number(hexBig(b?.timestamp)) * 1000, txHash }
  }

  /** Look for a Transfer of exactly `amount` to `to`, scanning forward in 2,000-block chunks. */
  async function findTransfer({ token, to, amount, fromBlock, toBlock, maxChunks = 25 }) {
    await ensureChain()
    const want = BigInt(amount)
    const end = toBlock ?? (await blockNumber())
    let start = Math.max(0, fromBlock ?? end - 2000)
    for (let i = 0; i < maxChunks && start <= end; i++) {
      const stop = Math.min(end, start + 1999)
      const logs = await rpc('eth_getLogs', [{ address: token, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${stop.toString(16)}`, topics: [TRANSFER_TOPIC, null, padAddress(to)] }])
      const hit = (logs || []).find((l) => !l.removed && hexBig(l.data) === want)
      if (hit) return { txHash: hit.transactionHash, blockNumber: Number(hexBig(hit.blockNumber)), scannedTo: stop }
      start = stop + 1
    }
    return { txHash: null, scannedTo: Math.min(end, start - 1) }
  }

  return { rpc, blockNumber, verifyTransfer, findTransfer, ensureChain }
}

// Passes are paid in USDC on Base, straight to the owner's wallet. Nothing here holds funds.
import { envNum, envInt } from '../lib/util.js'

export const NETWORKS = {
  base: { id: 'base', chainId: 8453, name: 'Base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', testnet: false },
  'base-sepolia': { id: 'base-sepolia', chainId: 84532, name: 'Base Sepolia (test)', usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', testnet: true },
}

export const PLAN_RANK = { free: 0, pro: 1, elite: 2 }
export const DAY_MS = 86_400_000
export const USDC_DECIMALS = 6

export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)

/** Dollars to micro-USDC (integer string). */
export function usdToUnits(usd) {
  return String(Math.round(Number(usd) * 10 ** USDC_DECIMALS))
}

/** Micro-USDC to a plain decimal string: "29000123" -> "29.000123". */
export function formatUnits(units) {
  const s = String(units).replace(/^0+(?=\d)/, '')
  const pad = s.padStart(USDC_DECIMALS + 1, '0')
  const whole = pad.slice(0, -USDC_DECIMALS)
  const frac = pad.slice(-USDC_DECIMALS)
  return `${whole}.${frac}`
}

const FEATURES = {
  pro: ['AI picks on every prop (your APEX ruleset)', 'AI game analyzer', 'Kelly stake sizing on every pick', 'Bankroll simulator'],
  elite: ['Everything in Pro', 'Public picks page with your X and Instagram', 'Verified, auto-graded record', 'Elite badge and a spot in the picks feed', 'Leaderboard'],
}

/** Read on every call so env changes (and tests) take effect without a restart. */
export function billingConfig() {
  const network = NETWORKS[process.env.APEX_BILLING_NETWORK] ? process.env.APEX_BILLING_NETWORK : 'base'
  const net = NETWORKS[network]
  const raw = String(process.env.APEX_TREASURY_ADDRESS || '').trim().toLowerCase()
  const treasury = isAddress(raw) && raw !== net.usdc ? raw : null
  const mode = String(process.env.APEX_PAYWALL || 'auto').trim().toLowerCase()
  // Passes need somewhere durable to live: with no database (a Vercel deploy without a
  // service account) the paywall stays off even with a treasury set.
  const durable = process.env.APEX_EPHEMERAL !== '1'
  const paywall = mode === 'off' || !durable ? false : Boolean(treasury)
  const pro = envNum('APEX_PRICE_PRO_USD', 29, { min: 1, max: 10_000 })
  const elite = envNum('APEX_PRICE_ELITE_USD', 79, { min: 1, max: 10_000 })
  return {
    paywall,
    paywallMode: mode,
    network,
    chainId: net.chainId,
    networkName: net.name,
    testnet: net.testnet,
    token: net.usdc,
    explorer: net.explorer,
    rpcUrl: process.env.APEX_BASE_RPC_URL || net.rpc,
    treasury,
    confirmations: envInt('APEX_BILLING_CONFIRMATIONS', 3, { min: 1, max: 64 }),
    periodDays: 30,
    graceDays: 7,
    invoiceTtlMs: 24 * 3600_000,
    usageTz: process.env.APEX_USAGE_TZ || 'America/New_York',
    plans: {
      pro: {
        id: 'pro',
        name: 'Pro',
        priceUsd: pro,
        showcase: false,
        limits: { analyses: envInt('APEX_PRO_ANALYSES_PER_DAY', 8, { min: 0, max: 1000 }), aiReads: envInt('APEX_PRO_AI_READS_PER_DAY', 15, { min: 0, max: 5000 }) },
        features: FEATURES.pro,
      },
      elite: {
        id: 'elite',
        name: 'Elite',
        priceUsd: elite,
        showcase: true,
        limits: { analyses: envInt('APEX_ELITE_ANALYSES_PER_DAY', 15, { min: 0, max: 1000 }), aiReads: envInt('APEX_ELITE_AI_READS_PER_DAY', 30, { min: 0, max: 5000 }) },
        features: FEATURES.elite,
      },
    },
  }
}

/** What the browser may see. */
export function publicBillingConfig(cfg = billingConfig()) {
  return {
    paywall: cfg.paywall,
    network: cfg.network,
    networkName: cfg.networkName,
    chainId: cfg.chainId,
    testnet: cfg.testnet,
    token: cfg.token,
    explorer: cfg.explorer,
    treasury: cfg.treasury,
    confirmations: cfg.confirmations,
    periodDays: cfg.periodDays,
    graceDays: cfg.graceDays,
    plans: Object.values(cfg.plans).map((p) => ({ id: p.id, name: p.name, priceUsd: p.priceUsd, showcase: p.showcase, limits: p.limits, features: p.features })),
  }
}

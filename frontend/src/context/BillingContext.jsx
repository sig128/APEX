import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext.jsx'
import { api } from '../lib/api.js'
import { isNative } from '../lib/native.js'
import { appleInfo, watchApplePurchases } from '../lib/iap.js'

const BillingContext = createContext(null)
const RANK = { free: 0, pro: 1, elite: 2 }

// What the signed-in person can use: their plan (free, pro, elite), its status (active, grace,
// expired), today's AI allowance, and the public price list. The API enforces all of it; this
// only decides what to show.
export function BillingProvider({ children }) {
  const { user, loading: authLoading } = useAuth()
  const [config, setConfig] = useState(null)
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(true)
  // the iPhone app sells passes and credit packs through Apple when the server takes them
  const [apple, setApple] = useState(false)

  useEffect(() => {
    if (isNative()) appleInfo().then((i) => setApple(Boolean(i.enabled)), () => {})
    api('/api/billing/config', { auth: false })
      .then(setConfig)
      .catch(() => setConfig({ paywall: false, plans: [] }))
  }, [])

  const refresh = useCallback(async () => {
    if (!user) {
      setMe(null)
      setLoading(false)
      return null
    }
    try {
      const m = await api('/api/billing/me')
      setMe(m)
      return m
    } catch {
      setMe(null)
      return null
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (authLoading) return
    setLoading(true)
    refresh()
  }, [authLoading, refresh])

  // in the app, once signed in: purchases Apple took that never reached the server go through now
  useEffect(() => {
    if (!user || !isNative()) return
    watchApplePurchases(() => refresh()).catch(() => {})
  }, [user, refresh])

  const value = useMemo(() => {
    // in the app with Apple selling, the pass actually held is what shows (the website may not be selling yet)
    const viaApple = apple && isNative()
    const paywall = Boolean(config?.paywall) || viaApple
    const ent = (viaApple && me?.held) || me?.entitlement || (paywall ? { plan: 'free', status: user ? 'none' : 'anonymous' } : { plan: 'elite', status: 'open' })
    return {
      config,
      paywall,
      apple: viaApple,
      me,
      ent,
      plan: ent.plan,
      isAdmin: Boolean(me?.user?.admin),
      // the AI costs money per use: a real Pro or Elite pass (or the admin), passes on sale or not
      canAI: Boolean(config?.aiOpen) || Boolean(me?.ai?.allowed),
      // members-only features (the simulator, the live ticker, the full leaderboard): a real pass, on sale or not
      member: Boolean(config?.aiOpen) || Boolean(me?.ai?.allowed),
      usage: me?.usage || null,
      loading: loading || authLoading || !config,
      has: (need) => (RANK[ent.plan] ?? 0) >= (RANK[need] ?? 0),
      refresh,
    }
  }, [config, me, loading, authLoading, user, refresh, apple])
  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>
}

export function useBilling() {
  const ctx = useContext(BillingContext)
  if (!ctx) throw new Error('useBilling must be used within BillingProvider')
  return ctx
}

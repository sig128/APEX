import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext.jsx'
import { api } from '../lib/api.js'

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

  useEffect(() => {
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

  const value = useMemo(() => {
    const paywall = Boolean(config?.paywall)
    const ent = me?.entitlement || (paywall ? { plan: 'free', status: user ? 'none' : 'anonymous' } : { plan: 'elite', status: 'open' })
    return {
      config,
      paywall,
      me,
      ent,
      plan: ent.plan,
      isAdmin: Boolean(me?.user?.admin),
      // the AI costs money per use: a real Pro or Elite pass (or the admin), passes on sale or not
      canAI: Boolean(config?.aiOpen) || Boolean(me?.ai?.allowed),
      usage: me?.usage || null,
      loading: loading || authLoading || !config,
      has: (need) => (RANK[ent.plan] ?? 0) >= (RANK[need] ?? 0),
      refresh,
    }
  }, [config, me, loading, authLoading, user, refresh])
  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>
}

export function useBilling() {
  const ctx = useContext(BillingContext)
  if (!ctx) throw new Error('useBilling must be used within BillingProvider')
  return ctx
}

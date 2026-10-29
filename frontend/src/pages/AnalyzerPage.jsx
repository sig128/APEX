import { lazy, Suspense } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { Locked } from '../ui/Locked.jsx'
import { Skeleton } from '../ui/Bits.jsx'
import { SportsConfigProvider } from '../context/SportsConfigContext.jsx'

const ApexApp = lazy(() => import('../apex/ApexApp.jsx').then((m) => ({ default: m.ApexApp })))

/** The original multi-sport AI game analyzer: members with a Pro or Elite pass (the AI costs money per use). */
export function AnalyzerPage() {
  const { user, loading } = useAuth()
  const { loading: bLoading, config } = useBilling()
  if (loading || bLoading) return <div className="container page"><Skeleton rows={4} /></div>
  if (!user && !config?.aiOpen) return <Navigate to="/login?next=/apex" replace />
  // The analyzer's stylesheet is scoped to .apex-analyzer so it can't restyle the rest of the site.
  return (
    <Locked need="pro" ai title="The AI game analyzer">
      <SportsConfigProvider>
        <Suspense fallback={<div className="container page"><Skeleton rows={6} /></div>}>
          <div className="apex-analyzer">
            <ApexApp />
          </div>
        </Suspense>
      </SportsConfigProvider>
    </Locked>
  )
}

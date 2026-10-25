import { lazy, Suspense } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useBilling } from '../context/BillingContext.jsx'
import { Locked } from '../ui/Locked.jsx'
import { Skeleton } from '../ui/Bits.jsx'
import { SportsConfigProvider } from '../context/SportsConfigContext.jsx'

const ApexApp = lazy(() => import('../apex/ApexApp.jsx').then((m) => ({ default: m.ApexApp })))

/** The original multi-sport AI game analyzer: Pro with the paywall on, invite code while it's off. */
export function AnalyzerPage() {
  const { user, loading, inviteLoading, hasInviteAccess } = useAuth()
  const { paywall, loading: bLoading } = useBilling()
  if (loading || bLoading || inviteLoading) return <div className="container page"><Skeleton rows={4} /></div>
  if (!user) return <Navigate to="/login?next=/apex" replace />
  // The analyzer's stylesheet is scoped to .apex-analyzer so it can't restyle the rest of the site.
  const app = (
    <SportsConfigProvider>
      <Suspense fallback={<div className="container page"><Skeleton rows={6} /></div>}>
        <div className="apex-analyzer">
          <ApexApp />
        </div>
      </Suspense>
    </SportsConfigProvider>
  )
  if (paywall) {
    return (
      <Locked need="pro" title="The AI game analyzer">
        {app}
      </Locked>
    )
  }
  if (!hasInviteAccess) {
    return (
      <div className="container page narrow">
        <div className="locked">
          <p className="locked__title">The analyzer needs an invite code</p>
          <p className="locked__body">Enter yours on the account page to unlock AI analyses.</p>
          <Link to="/account" className="btn btn--gold">
            Enter a code
          </Link>
        </div>
      </div>
    )
  }
  return app
}

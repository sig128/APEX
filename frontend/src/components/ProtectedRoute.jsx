import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

export function ProtectedRoute({ children }) {
  const {
    user,
    loading,
    firebaseConfigured,
    inviteLoading,
    hasInviteAccess,
    adminDevSession,
  } = useAuth()

  if (adminDevSession) {
    return children
  }

  if (!firebaseConfigured) {
    return <Navigate to="/login" replace />
  }

  if (loading || (user && inviteLoading)) {
    return (
      <div className="auth-loading">
        <span className="auth-loading-inner">Loading…</span>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (!hasInviteAccess) {
    return <Navigate to="/login" replace />
  }

  return children
}

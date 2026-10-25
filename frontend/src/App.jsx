import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext.jsx'
import { SportsConfigProvider } from './context/SportsConfigContext.jsx'
import { LoginPage } from './components/LoginPage.jsx'
import { ProtectedRoute } from './components/ProtectedRoute.jsx'
import { ApexApp } from './apex/ApexApp.jsx'
import { AdminSportsPage } from './pages/AdminSportsPage.jsx'

export function App() {
  return (
    <AuthProvider>
      <SportsConfigProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/apex"
            element={
              <ProtectedRoute>
                <ApexApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/adminn"
            element={
              <ProtectedRoute>
                <AdminSportsPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </SportsConfigProvider>
    </AuthProvider>
  )
}

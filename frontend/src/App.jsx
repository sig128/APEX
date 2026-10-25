import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext.jsx'
import { BillingProvider } from './context/BillingContext.jsx'
import { SportsConfigProvider } from './context/SportsConfigContext.jsx'
import { Shell } from './ui/Shell.jsx'
import { Skeleton } from './ui/Bits.jsx'
import { HomePage } from './pages/HomePage.jsx'
import { PropsPage } from './pages/PropsPage.jsx'
import { GamePage } from './pages/GamePage.jsx'
import { PropPage } from './pages/PropPage.jsx'
import { PlayerPage } from './pages/PlayerPage.jsx'
import { LivePage } from './pages/LivePage.jsx'
import { SlipPage } from './pages/SlipPage.jsx'
import { PicksPage } from './pages/PicksPage.jsx'
import { UserPage } from './pages/UserPage.jsx'
import { LoginPage } from './pages/LoginPage.jsx'
import { NotFound } from './pages/NotFound.jsx'

// Less-visited pages load on demand.
const page = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })))
const MePage = page(() => import('./pages/MePage.jsx'), 'MePage')
const KellyPage = page(() => import('./pages/KellyPage.jsx'), 'KellyPage')
const ToolsPage = page(() => import('./pages/ToolsPage.jsx'), 'ToolsPage')
const SimPage = page(() => import('./pages/SimPage.jsx'), 'SimPage')
const CheckPage = page(() => import('./pages/CheckPage.jsx'), 'CheckPage')
const PricingPage = page(() => import('./pages/PricingPage.jsx'), 'PricingPage')
const AccountPage = page(() => import('./pages/AccountPage.jsx'), 'AccountPage')
const AdminPage = page(() => import('./pages/AdminPage.jsx'), 'AdminPage')
const DvpPage = page(() => import('./pages/DvpPage.jsx'), 'DvpPage')
const AnalyzerPage = page(() => import('./pages/AnalyzerPage.jsx'), 'AnalyzerPage')
const AdminSportsPage = page(() => import('./pages/AdminSportsPage.jsx'), 'AdminSportsPage')

const wait = (
  <div className="container page">
    <Skeleton rows={6} />
  </div>
)

export function App() {
  return (
    <AuthProvider>
      <BillingProvider>
        <Shell>
          <Suspense fallback={wait}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/nfl" element={<Navigate to="/" replace />} />
              <Route path="/nfl/props" element={<PropsPage />} />
              <Route path="/nfl/game/:id" element={<GamePage />} />
              <Route path="/nfl/prop/:id" element={<PropPage />} />
              <Route path="/nfl/player/:id" element={<PlayerPage />} />
              <Route path="/nfl/live" element={<LivePage />} />
              <Route path="/nfl/slip" element={<SlipPage />} />
              <Route path="/nfl/dvp" element={<DvpPage />} />
              <Route path="/picks" element={<PicksPage />} />
              <Route path="/u/:handle" element={<UserPage />} />
              <Route path="/me" element={<MePage />} />
              <Route path="/kelly" element={<KellyPage />} />
              <Route path="/tools" element={<ToolsPage />} />
              <Route path="/tools/sim" element={<SimPage />} />
              <Route path="/tools/check" element={<CheckPage />} />
              <Route path="/pricing" element={<PricingPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/apex" element={<AnalyzerPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route
                path="/adminn"
                element={
                  <SportsConfigProvider>
                    <AdminSportsPage />
                  </SportsConfigProvider>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </Shell>
      </BillingProvider>
    </AuthProvider>
  )
}

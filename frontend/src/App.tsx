import React, { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from './i18n'
import { WalletProvider } from './context/WalletContext'
import { ToastProvider } from './context/ToastContext'
import { NotificationProvider } from './context/NotificationContext'
import { ThemeProvider } from './context/ThemeContext'
import { NotFoundPage } from './pages/NotFoundPage'
import AppShell from './components/layout/AppShell'
import LandingPage from './pages/LandingPage'
import ErrorBoundary from './components/common/ErrorBoundary'
import { ProtectedRoute } from './components/common/ProtectedRoute'
import { CommandPalette } from './components/common/CommandPalette'
import { useCommandPalette } from './hooks/useCommandPalette'
import { ProtectedRoute as AuthProtectedRoute } from './components/auth/ProtectedRoute'
import { Skeleton, SkeletonCard, SkeletonTable } from './components/common/Skeleton'
import './components/common/Toast.css'

// Lazy-loaded pages
const DashboardPage = lazy(() => import('./pages/dashboard'))
const AgentsPage = lazy(() => import('./pages/AgentsPage'))
const WalletPage = lazy(() => import('./pages/WalletPage'))
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'))
const NewTaskPage = lazy(() => import('./pages/tasks/NewTaskPage'))
const TaskHistoryPage = lazy(() => import('./pages/tasks/TaskHistoryPage'))
const RendererDemoPage = lazy(() => import('./pages/RendererDemoPage'))

const RouteLoadingFallback: React.FC = () => (
  <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
    {Array.from({ length: 3 }).map((_, i) => (
      <SkeletonCard key={i} style={{ height: '100px' }} />
    ))}
  </div>
)

/**
 * Everything that needs router context lives here, so `<Router>` (mounted by
 * `App` below) is already in place before `useCommandPalette` calls
 * `useNavigate`.
 */
const AppContent: React.FC = () => {
  return (
    <Router>
      <AppShell>
        <Routes>
          <Route path="/" element={<LandingPage />} />
        </Routes>
      </AppShell>
      <NotificationProvider>
        <RoutedContent />
      </NotificationProvider>
    </Router>
  )
}

const RoutedContent: React.FC = () => {
  const { isOpen, closePalette, search, recentSearches } = useCommandPalette()

  return (
    <>
      <Routes>
        <Route path="/*" element={
          <AppShell>
            <Suspense fallback={<RouteLoadingFallback />}>
              <Routes>
                <Route path="/dashboard" element={
                  <ProtectedRoute><DashboardPage /></ProtectedRoute>
                } />
                <Route path="/wallet" element={
                  <ProtectedRoute><WalletPage /></ProtectedRoute>
                } />
                <Route path="/agents" element={
                  <ProtectedRoute><AgentsPage /></ProtectedRoute>
                } />
                <Route path="/tasks/new" element={
                  <ProtectedRoute><NewTaskPage /></ProtectedRoute>
                } />
                <Route path="/tasks/history" element={
                  <ProtectedRoute><TaskHistoryPage /></ProtectedRoute>
                } />
                <Route path="/tasks/:id" element={
                  <ProtectedRoute><TaskDetailPage /></ProtectedRoute>
                } />
                {import.meta.env.DEV && (
                  <Route path="/renderer-demo" element={<RendererDemoPage />} />
                )}
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </AppShell>
        } />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <CommandPalette
        isOpen={isOpen}
        onClose={closePalette}
        onSearch={search}
        recentSearches={recentSearches}
        onRecentSearchClick={(query) => {
          search(query)
        }}
      />
    </>
  )
}

const App: React.FC = () => {
  return (
    <I18nextProvider i18n={i18n}>
      <ErrorBoundary>
        <ThemeProvider>
          <WalletProvider>
            <ToastProvider>
              <Router>
                <AppContent />
              </Router>
            </ToastProvider>
          </WalletProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </I18nextProvider>
  )
}

export default App

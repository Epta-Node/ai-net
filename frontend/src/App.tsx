import React, { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from './i18n'
import { WalletProvider } from './context/WalletContext'
import { ToastProvider } from './context/ToastContext'
import { NotificationProvider } from './context/NotificationContext'
import { RouteProgressProvider } from './context/RouteProgressContext'
import RouteProgressBar from './components/layout/RouteProgressBar'
import { ThemeProvider } from './context/ThemeContext'
import { NotFoundPage } from './pages/NotFoundPage'
import AppShell from './components/layout/AppShell'
import LandingPage from './pages/LandingPage'
import ErrorBoundary from './components/common/ErrorBoundary'
import RouteLoader from './components/common/RouteLoader'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { CommandPalette } from './components/common/CommandPalette'
import { MotionProvider } from './components/common/MotionProvider'
import { useCommandPalette } from './hooks/useCommandPalette'
import './components/common/Toast.css'

// Route-level code splitting: every page except LandingPage (kept eager so
// the first paint on `/` is not delayed) is fetched on demand. Heavy
// route-only libraries (reactflow, recharts, jspdf, react-syntax-highlighter)
// therefore stay out of the initial bundle.
const DashboardPage = lazy(() => import('./pages/dashboard'))
const WalletPage = lazy(() => import('./pages/WalletPage'))
const AgentsPage = lazy(() => import('./pages/AgentsPage'))
const NewTaskPage = lazy(() => import('./pages/tasks/NewTaskPage'))
const TaskHistoryPage = lazy(() => import('./pages/tasks/TaskHistoryPage'))
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'))
const RendererDemoPage = lazy(() => import('./pages/RendererDemoPage'))

// Lives INSIDE <Router> and the theme/wallet providers: useCommandPalette()
// calls useNavigate(), useTheme() and useWallet(), which all require their
// context providers to be mounted above this component.
const RoutedContent: React.FC = () => {
  const { isOpen, closePalette, commands } = useCommandPalette()

  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/*"
          element={
            <AppShell>
              <Suspense fallback={<RouteLoader />}>
                <Routes>
                  <Route
                    path="/dashboard"
                    element={
                      <ProtectedRoute>
                        <DashboardPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/wallet"
                    element={
                      <ProtectedRoute>
                        <WalletPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/agents"
                    element={
                      <ProtectedRoute>
                        <AgentsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/tasks/new"
                    element={
                      <ProtectedRoute>
                        <NewTaskPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/tasks/history"
                    element={
                      <ProtectedRoute>
                        <TaskHistoryPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/tasks/:id"
                    element={
                      <ProtectedRoute>
                        <TaskDetailPage />
                      </ProtectedRoute>
                    }
                  />
                  {import.meta.env.DEV && (
                    <Route path="/renderer-demo" element={<RendererDemoPage />} />
                  )}
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
            </AppShell>
          }
        />
      </Routes>

      <CommandPalette
        isOpen={isOpen}
        onClose={closePalette}
        commands={commands}
      />
    </>
  )
}

const App: React.FC = () => {
  return (
    <I18nextProvider i18n={i18n}>
      <ErrorBoundary>
        <MotionProvider>
          <ThemeProvider>
            <WalletProvider>
              <ToastProvider>
                <NotificationProvider>
                  <RouteProgressProvider>
                    <Router>
                      <RouteProgressBar />
                      <RoutedContent />
                    </Router>
                  </RouteProgressProvider>
                </NotificationProvider>
              </ToastProvider>
            </WalletProvider>
          </ThemeProvider>
        </MotionProvider>
      </ErrorBoundary>
    </I18nextProvider>
  )
}

export default App

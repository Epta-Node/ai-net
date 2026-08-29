import React from 'react'
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { I18nextProvider } from 'react-i18next'
import i18n from './i18n'
import { WalletProvider } from './context/WalletContext'
import { ToastProvider } from './context/ToastContext'
import { NotificationProvider } from './context/NotificationContext'
import { ThemeProvider } from './context/ThemeContext'
import { NotFoundPage } from './pages/NotFoundPage'
import AppShell from './components/layout/AppShell'
import LandingPage from './pages/LandingPage'
import AgentsPage from './pages/AgentsPage'
import NewTaskPage from './pages/tasks/NewTaskPage'
import TaskHistoryPage from './pages/tasks/TaskHistoryPage'
import TaskDetailPage from './pages/TaskDetailPage'
import RendererDemoPage from './pages/RendererDemoPage'
import WalletPage from './pages/WalletPage'
import DashboardPage from './pages/dashboard'
import ErrorBoundary from './components/common/ErrorBoundary'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { CommandPalette } from './components/common/CommandPalette'
import { useCommandPalette } from './hooks/useCommandPalette'
import './components/common/Toast.css'

const HEAVY_ROUTE_PREFIXES = ['/renderer-demo']

function isHeavyRoute(pathname: string): boolean {
  return HEAVY_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

const PageTransition: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation()
  const prefersReducedMotion = useReducedMotion()
  const disabled = prefersReducedMotion || isHeavyRoute(location.pathname)

  if (disabled) {
    return (
      <div key={location.pathname} style={{ width: '100%' }}>
        {children}
      </div>
    )
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        style={{ width: '100%' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}

const ShellRoutes: React.FC = () => {
  const location = useLocation()

  return (
    <AppShell>
      <PageTransition>
        <Routes location={location}>
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
      </PageTransition>
    </AppShell>
  )
}

const RoutedContent: React.FC = () => {
  const location = useLocation()
  const { isOpen, closePalette, search, recentSearches } = useCommandPalette()

  return (
    <>
      {location.pathname === '/' ? (
        <PageTransition>
          <LandingPage />
        </PageTransition>
      ) : (
        <ShellRoutes />
      )}
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
              <NotificationProvider>
                <Router>
                  <RoutedContent />
                </Router>
              </NotificationProvider>
            </ToastProvider>
          </WalletProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </I18nextProvider>
  )
}

export default App

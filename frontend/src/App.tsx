import React from 'react'
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

/**
 * Everything below the router.
 *
 * `/` is the public landing page and renders bare. **Every other route** —
 * including 404 — renders inside a single `<AppShell>`, so the top nav,
 * sidebar, drawer, and breadcrumb are assembled once rather than per route.
 *
 * The command palette is mounted here, once, outside the route tree: it is
 * reachable with Ctrl/Cmd+K from any page and must not remount on navigation.
 * `useCommandPalette` calls `useNavigate`, so this component has to sit inside
 * `<Router>` rather than beside it.
 */
const RoutedContent: React.FC = () => {
  const { isOpen, closePalette, search, recentSearches, runRecentSearch } = useCommandPalette()

  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/*"
          element={
            <AppShell>
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
            </AppShell>
          }
        />
      </Routes>

      <CommandPalette
        isOpen={isOpen}
        onClose={closePalette}
        onSearch={search}
        recentSearches={recentSearches}
        onRecentSearchClick={runRecentSearch}
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

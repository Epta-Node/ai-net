import React, { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from './i18n'
import { WalletProvider } from './context/WalletContext'
import { ToastProvider } from './context/ToastContext'
import { NotificationProvider } from './context/NotificationContext'
import { ThemeProvider } from './context/ThemeContext'
import AppShell from './components/layout/AppShell'
import { NotFoundPage } from './pages/NotFoundPage'
import RouteLoader from './components/common/RouteLoader'

// Lazy-loaded pages (route-based code-splitting)
const LandingPage = lazy(() => import('./pages/LandingPage'))
const AgentsPage = lazy(() => import('./pages/AgentsPage'))
const NewTaskPage = lazy(() => import('./pages/tasks/NewTaskPage'))
const TaskHistoryPage = lazy(() => import('./pages/tasks/TaskHistoryPage'))
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'))
const RendererDemoPage = lazy(() => import('./pages/RendererDemoPage'))
const WalletPage = lazy(() => import('./pages/WalletPage'))
const DashboardPage = lazy(() => import('./pages/dashboard'))
import ErrorBoundary from './components/common/ErrorBoundary'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { CommandPalette } from './components/common/CommandPalette'
import { useCommandPalette } from './hooks/useCommandPalette'
import './components/common/Toast.css'

/**
 * Everything that needs router context lives here, so `<Router>` (mounted by
 * `App` below) is already in place before `useCommandPalette` calls
 * `useNavigate`.
 */
const AppContent: React.FC = () => {
  // Prefetch mapping: path -> dynamic import used to fetch chunk on hover
  useEffect(() => {
    const prefetchers: Record<string, () => Promise<any>> = {
      '/': () => import('./pages/LandingPage'),
      '/dashboard': () => import('./pages/dashboard'),
      '/wallet': () => import('./pages/WalletPage'),
      '/agents': () => import('./pages/AgentsPage'),
      '/tasks/new': () => import('./pages/tasks/NewTaskPage'),
      '/tasks/history': () => import('./pages/tasks/TaskHistoryPage'),
      '/renderer-demo': () => import('./pages/RendererDemoPage'),
    }

    const onHover = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      const anchor = target.closest('a') as HTMLAnchorElement | null
      if (!anchor || !anchor.href) return
      try {
        const url = new URL(anchor.href)
        const path = url.pathname

        // Prefetch exact matches
        const pre = prefetchers[path]
        if (pre) pre()

        // Prefetch task details page for /tasks/:id pattern
        if (path.startsWith('/tasks/') && !path.endsWith('/new') && path.split('/').length === 3) {
          import('./pages/TaskDetailPage')
        }
      } catch (_) {
        // ignore cross-origin or malformed hrefs
      }
    }

    document.addEventListener('mouseover', onHover)
    return () => document.removeEventListener('mouseover', onHover)
  }, [])

  return (
    <Router>
      <AppShell>
        <Routes>
          <Route path="/" element={
            <Suspense fallback={<RouteLoader />}>
              <LandingPage />
            </Suspense>
          } />
          <Route path="/dashboard" element={
            <Suspense fallback={<RouteLoader />}>
              <ProtectedRoute><DashboardPage /></ProtectedRoute>
            </Suspense>
          } />
          <Route path="/wallet" element={
            <Suspense fallback={<RouteLoader />}>
              <WalletPage />
            </Suspense>
          } />
          <Route path="/agents" element={
            <Suspense fallback={<RouteLoader />}>
              <AgentsPage />
            </Suspense>
          } />
          <Route path="/tasks/new" element={
            <Suspense fallback={<RouteLoader />}>
              <ProtectedRoute><NewTaskPage /></ProtectedRoute>
            </Suspense>
          } />
          <Route path="/tasks/:id" element={
            <Suspense fallback={<RouteLoader />}>
              <ProtectedRoute><TaskDetailPage /></ProtectedRoute>
            </Suspense>
          } />
          <Route path="/renderer-demo" element={
            <Suspense fallback={<RouteLoader />}>
              <RendererDemoPage />
            </Suspense>
          } />
        </Routes>
      </AppShell>
    <NotificationProvider>
      <RoutedContent />
    </NotificationProvider>
  )
}

// Lives INSIDE <Router>: useCommandPalette() calls useNavigate(), which
// throws the "may be used only in the context of a <Router>" invariant when
// rendered above it.
const RoutedContent: React.FC = () => {
  const { isOpen, closePalette, search, recentSearches } = useCommandPalette()

  return (
    <>
      <Routes>
        <Route path="/" element={
          <Suspense fallback={<RouteLoader />}>
            <LandingPage />
          </Suspense>
        } />
        <Route path="/*" element={
          <AppShell>
            <Routes>
              <Route path="/dashboard" element={
                <Suspense fallback={<RouteLoader />}>
                  <ProtectedRoute><DashboardPage /></ProtectedRoute>
                </Suspense>
              } />
              <Route path="/wallet" element={
                <Suspense fallback={<RouteLoader />}>
                  <ProtectedRoute><WalletPage /></ProtectedRoute>
                </Suspense>
              } />
              <Route path="/agents" element={
                <Suspense fallback={<RouteLoader />}>
                  <ProtectedRoute><AgentsPage /></ProtectedRoute>
                </Suspense>
              } />
              <Route path="/tasks/new" element={
                <Suspense fallback={<RouteLoader />}>
                  <ProtectedRoute><NewTaskPage /></ProtectedRoute>
                </Suspense>
              } />
              <Route path="/tasks/history" element={
                <Suspense fallback={<RouteLoader />}>
                  <ProtectedRoute><TaskHistoryPage /></ProtectedRoute>
                </Suspense>
              } />
              <Route path="/tasks/:id" element={
                <Suspense fallback={<RouteLoader />}>
                  <ProtectedRoute><TaskDetailPage /></ProtectedRoute>
                </Suspense>
              } />
              {import.meta.env.DEV && (
                <Route path="/renderer-demo" element={
                  <Suspense fallback={<RouteLoader />}>
                    <RendererDemoPage />
                  </Suspense>
                } />
              )}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
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
          // Trigger search with the recent query
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

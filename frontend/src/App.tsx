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
import { ProtectedRoute } from './components/common/ProtectedRoute'
import { CommandPalette } from './components/common/CommandPalette'
import { useCommandPalette } from './hooks/useCommandPalette'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import './components/common/Toast.css'

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
          <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/tasks/new" element={<ProtectedRoute><NewTaskPage /></ProtectedRoute>} />
          <Route path="/tasks/:id" element={<ProtectedRoute><TaskDetailPage /></ProtectedRoute>} />
          <Route path="/renderer-demo" element={<RendererDemoPage />} />
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
        <Route path="/" element={<LandingPage />} />
        <Route path="/*" element={
          <AppShell>
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

import React from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from './i18n'
import { WalletProvider } from './context/WalletContext'
import { ToastProvider } from './context/ToastContext'
import { NotFoundPage } from './pages/NotFoundPage';
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
import { CommandPalette } from './components/common/CommandPalette'
import { useCommandPalette } from './hooks/useCommandPalette'
import './components/common/Toast.css'

/**
 * Everything that needs router context lives here, so `<Router>` (mounted by
 * `App` below) is already in place before `useCommandPalette` calls
 * `useNavigate`.
 */
const AppContent: React.FC = () => {
  return (
    <Router>
      <RoutedContent />
    </Router>
  );
};

// Lives INSIDE <Router>: useCommandPalette() calls useNavigate(), which
// throws the "may be used only in the context of a <Router>" invariant when
// rendered above it.
const RoutedContent: React.FC = () => {
  const { isOpen, closePalette, search, recentSearches } = useCommandPalette();

  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/*" element={
          <AppShell>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/wallet" element={<WalletPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/tasks/new" element={<NewTaskPage />} />
              <Route path="/tasks/history" element={<TaskHistoryPage />} />
              <Route path="/tasks/:id" element={<TaskDetailPage />} />
              <Route path="/renderer-demo" element={<RendererDemoPage />} />
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
          search(query);
        }}
      />
    </>
  );
};

const App: React.FC = () => {
  return (
    <I18nextProvider i18n={i18n}>
      <ErrorBoundary>
        <WalletProvider>
          <ToastProvider>
            <Router>
              <AppContent />
            </Router>
          </ToastProvider>
        </WalletProvider>
      </ErrorBoundary>
    </I18nextProvider>
  )
}

export default App

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AnimatePresence } from 'framer-motion'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useWallet } from '../../context/WalletContext'
import Sidebar from './Sidebar'
import TopNav from './TopNav'
import MobileDrawer from './MobileDrawer'
import Breadcrumb from './Breadcrumb'
import RouteProgressBar from './RouteProgressBar'
import { useRouteProgress } from '../../hooks/useRouteProgress'
import './AppShell.css'

interface AppShellProps {
  children: React.ReactNode
}

/**
 * Below this width the sidebar gives way to the slide-over drawer. 1024px is
 * where the sidebar rail plus a readable content column stops fitting.
 */
export const MOBILE_BREAKPOINT_QUERY = '(max-width: 1023px)'

const SIDEBAR_STATE_KEY = 'sidebar_collapsed'

/**
 * Storage key for the sidebar's collapsed state, scoped to the connected
 * wallet.
 *
 * Two people sharing a browser profile each keep their own preference, and a
 * signed-out visitor gets the unscoped key — which is also the key the app used
 * before scoping existed, so nobody's existing preference is silently dropped.
 */
function sidebarStateKey(publicKey: string | null): string {
  return publicKey ? `${SIDEBAR_STATE_KEY}:${publicKey}` : SIDEBAR_STATE_KEY
}

function readSidebarState(publicKey: string | null): boolean {
  try {
    return localStorage.getItem(sidebarStateKey(publicKey)) === 'true'
  } catch {
    // Private-mode browsers can throw on access; an expanded sidebar is the
    // safe default.
    return false
  }
}

/**
 * The single application shell.
 *
 * Every in-app route renders inside this component, so the top nav, sidebar,
 * drawer, and breadcrumb behave identically on every page rather than being
 * assembled differently per route.
 */
const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const { t } = useTranslation()
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT_QUERY)
  const { publicKey } = useWallet()
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarState(publicKey))
  const location = useLocation()
  const navigate = useNavigate()
  const drawerRef = useRef<HTMLDivElement>(null)

  // Re-read when the identity changes, so connecting a wallet adopts that
  // wallet's saved preference instead of carrying over the anonymous one.
  useEffect(() => {
    setSidebarCollapsed(readSidebarState(publicKey))
  }, [publicKey])

  useEffect(() => {
    if (!isMobile) {
      setIsDrawerOpen(false)
    }
  }, [isMobile])

  useEffect(() => {
    try {
      localStorage.setItem(sidebarStateKey(publicKey), String(sidebarCollapsed))
    } catch {
      // Persistence is a convenience; losing it must not break the shell.
    }
  }, [sidebarCollapsed, publicKey])

  useEffect(() => {
    setIsDrawerOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!isDrawerOpen) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDrawerOpen(false)
      }
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setIsDrawerOpen(false)
      }
    }

    document.addEventListener('keydown', handleEscape)
    document.addEventListener('mousedown', handleClickOutside)

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isDrawerOpen])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev)
  }, [])

  const toggleDrawer = useCallback(() => {
    setIsDrawerOpen((prev) => !prev)
  }, [])

  const handleNavigate = useCallback(
    (path: string) => {
      navigate(path)
      setIsDrawerOpen(false)
    },
    [navigate],
  )

  return (
    <div className={`app-shell ${isMobile ? 'is-mobile' : ''}`}>
      <a href="#main-content" className="skip-to-content">
        {t('a11y.skipToContent')}
      </a>

      <TopNav
        onMenuClick={toggleDrawer}
        onToggleSidebar={toggleSidebar}
        sidebarCollapsed={sidebarCollapsed}
        isMobile={isMobile}
        isDrawerOpen={isDrawerOpen}
      />

      {!isMobile && (
        <Sidebar
          collapsed={sidebarCollapsed}
          currentPath={location.pathname}
          onNavigate={handleNavigate}
        />
      )}

      <AnimatePresence>
        {isMobile && isDrawerOpen && (
          <MobileDrawer
            ref={drawerRef}
            onClose={() => setIsDrawerOpen(false)}
            currentPath={location.pathname}
            onNavigate={handleNavigate}
          />
        )}
      </AnimatePresence>

      <main
        id="main-content"
        className={`main-content ${!isMobile && sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        tabIndex={-1}
      >
        <Breadcrumb />
        {children}
      </main>
    </div>
  )
}

export default AppShell

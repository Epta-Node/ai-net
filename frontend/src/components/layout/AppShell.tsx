import React, { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useScrollRestoration } from '../../hooks/useScrollRestoration'
import Sidebar from './Sidebar'
import TopNav from './TopNav'
import MobileDrawer from './MobileDrawer'
import Breadcrumb from './Breadcrumb'
import './AppShell.css'

interface AppShellProps {
  children: React.ReactNode
}

const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    localStorage.getItem('sidebar_collapsed') === 'true'
  )
  const location = useLocation()
  const navigate = useNavigate()
  const drawerRef = useRef<HTMLDivElement>(null)

  useScrollRestoration()

  useEffect(() => {
    if (isMobile === false) {
      setIsDrawerOpen(false)
    }
  }, [isMobile])

  useEffect(() => {
    localStorage.setItem('sidebar_collapsed', sidebarCollapsed.toString())
  }, [sidebarCollapsed])

  useEffect(() => {
    setIsDrawerOpen(false)
  }, [location.pathname])

  useEffect(() => {
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

    if (isDrawerOpen) {
      document.addEventListener('keydown', handleEscape)
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isDrawerOpen])

  const toggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed)
  }

  const toggleDrawer = () => {
    setIsDrawerOpen(!isDrawerOpen)
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-to-content">
        Skip to content
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
          onNavigate={navigate}
        />
      )}

      <AnimatePresence>
        {isMobile && isDrawerOpen && (
          <MobileDrawer
            ref={drawerRef}
            onClose={() => setIsDrawerOpen(false)}
            currentPath={location.pathname}
            onNavigate={(path) => {
              navigate(path)
              setIsDrawerOpen(false)
            }}
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

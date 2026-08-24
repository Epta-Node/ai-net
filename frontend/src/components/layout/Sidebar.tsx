import React from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, PlusCircle, Bot, Wallet, History } from 'lucide-react'
import './Sidebar.css'

interface SidebarProps {
  collapsed: boolean
  currentPath: string
  onNavigate: (path: string) => void
}

const Sidebar: React.FC<SidebarProps> = ({ 
  collapsed, 
  currentPath, 
  onNavigate 
}) => {
  const { t } = useTranslation()

  const navItems = [
    { path: '/', icon: <LayoutDashboard size={18} />, label: t('nav.dashboard') },
    { path: '/tasks/new', icon: <PlusCircle size={18} />, label: t('nav.newTask') },
    { path: '/tasks/history', icon: <History size={18} />, label: t('nav.taskHistory') },
    { path: '/agents', icon: <Bot size={18} />, label: t('nav.agents') },
    { path: '/wallet', icon: <Wallet size={18} />, label: t('nav.wallet') },
  ]

  const handleKeyDown = (e: React.KeyboardEvent, path: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onNavigate(path)
    }
  }

  return (
    <aside 
      className={`sidebar ${collapsed ? 'collapsed' : ''}`}
    >
      <nav className="sidebar-nav" role="navigation" aria-label={t('a11y.mainNavigation')}>
        <ul>
          {navItems.map((item) => {
            const isActive = currentPath === item.path
            return (
              <li key={item.path}>
                <button
                  className={`nav-item ${isActive ? 'active' : ''}`}
                  onClick={() => onNavigate(item.path)}
                  onKeyDown={(e) => handleKeyDown(e, item.path)}
                  aria-current={isActive ? 'page' : undefined}
                  title={collapsed ? item.label : undefined}
                >
                  <span className="nav-icon">{item.icon}</span>
                  {!collapsed && <span className="nav-label">{item.label}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}

export default Sidebar

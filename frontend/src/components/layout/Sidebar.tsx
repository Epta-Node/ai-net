import React from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { NAV_GROUPS, isNavItemActive } from './navigation'
import './Sidebar.css'

interface SidebarProps {
  collapsed: boolean
  currentPath: string
  onNavigate: (path: string) => void
}

const Sidebar: React.FC<SidebarProps> = ({ collapsed, currentPath, onNavigate }) => {
  const { t } = useTranslation()

  const handleKeyDown = (e: React.KeyboardEvent, path: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onNavigate(path)
    }
  }

  return (
    <aside
      className={`sidebar ${collapsed ? 'collapsed' : ''}`}
      aria-label={t('a11y.sidebar')}
    >
      <nav className="sidebar-nav" role="navigation" aria-label={t('a11y.mainNavigation')}>
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.id}>
            {/*
              The heading is hidden from sight when collapsed but kept in the
              accessibility tree, so screen-reader users keep the grouping that
              sighted users lose to the narrow rail.
            */}
            <h2
              className={`nav-group-label ${collapsed ? 'visually-hidden' : ''}`}
              id={`nav-group-${group.id}`}
            >
              {t(group.labelKey)}
            </h2>
            <ul aria-labelledby={`nav-group-${group.id}`}>
              {group.items.map((item) => {
                const isActive = isNavItemActive(currentPath, item.path)
                const label = t(item.labelKey)
                const Icon = item.icon
                return (
                  <li key={item.path}>
                    <button
                      className={`nav-item ${isActive ? 'active' : ''}`}
                      onClick={() => onNavigate(item.path)}
                      onKeyDown={(e) => handleKeyDown(e, item.path)}
                      aria-current={isActive ? 'page' : undefined}
                      title={collapsed ? label : undefined}
                    >
                      {/*
                        `layoutId` makes the active pill slide between items
                        instead of blinking out and back in. It is shared across
                        every button, so framer-motion animates the one element
                        from its old position to its new one.
                      */}
                      {isActive && (
                        <motion.span
                          className="nav-item-indicator"
                          layoutId="sidebar-active-indicator"
                          transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="nav-icon">
                        <Icon size={18} />
                      </span>
                      <span className={`nav-label ${collapsed ? 'visually-hidden' : ''}`}>
                        {label}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}

export default Sidebar

import React, { useState, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Bell } from 'lucide-react'
import { useWallet } from '../../context/WalletContext'
import { useNotifications } from '../../hooks/useNotifications'
import { NotificationCenter } from '../notifications/NotificationCenter'
import { SUPPORTED_LANGUAGES } from '../../i18n/options'
import { NAV_ITEMS } from './navigation'
import type { SupportedLanguage } from '../../i18n/options'
import './TopNav.css'
import useTheme from '../../hooks/useTheme'
import { Sun, Moon, Monitor } from 'lucide-react'

interface TopNavProps {
  onMenuClick: () => void
  onToggleSidebar: () => void
  sidebarCollapsed: boolean
  isMobile: boolean
  isDrawerOpen?: boolean
}

/**
 * Presentation for each language in the switcher.
 *
 * Language names stay in their own language by convention, so they are not
 * translated. Typing this as a `Record<SupportedLanguage, ...>` makes the build
 * fail if a language is added to `SUPPORTED_LANGUAGES` without an entry here.
 */
const LANGUAGE_OPTIONS: Record<
  SupportedLanguage,
  { flag: string; nativeName: string; shortLabel: string }
> = {
  en: { flag: '🇬🇧', nativeName: 'English', shortLabel: 'EN' },
  zh: { flag: '🇨🇳', nativeName: '中文', shortLabel: '中文' },
}

const TopNav: React.FC<TopNavProps> = ({ 
  onMenuClick, 
  onToggleSidebar, 
  sidebarCollapsed, 
  isMobile,
  isDrawerOpen = false,
}) => {
  const { publicKey, connected, ready, connectionMethod, disconnect } = useWallet()
  const { unreadCount } = useNotifications()
  const [isNotificationOpen, setIsNotificationOpen] = useState(false)
  const bellButtonRef = useRef<HTMLButtonElement>(null)
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const { mode, setMode } = useTheme()

  const activeLanguage = (i18n.resolvedLanguage ?? 'en') as SupportedLanguage

  // The title mirrors the sidebar's labels via the shared nav config, so the
  // page heading and the highlighted nav entry can never disagree.
  const getTitle = () => {
    const path = location.pathname
    // The registry page gets a fuller heading than its terse nav label.
    if (path === '/agents') return t('nav.agentRegistry')

    const navItem = NAV_ITEMS.find((item) => item.path === path)
    if (navItem) return t(navItem.labelKey)

    if (path.startsWith('/tasks/')) return t('nav.taskMonitoring')
    return t('nav.dashboard')
  }

  const truncateKey = (key: string) => {
    if (key.length <= 8) return key
    return `${key.slice(0, 4)}...${key.slice(-3)}`
  }

  return (
    <header className="top-nav" role="banner">
      <div className="nav-left">
        {isMobile ? (
          <button 
            className="hamburger"
            onClick={onMenuClick}
            aria-label={t('a11y.openNavigationMenu')}
            aria-expanded={isDrawerOpen}
          >
            <span></span>
            <span></span>
            <span></span>
          </button>
        ) : (
          <button 
            className="sidebar-toggle"
            onClick={onToggleSidebar}
            aria-label={sidebarCollapsed ? t('a11y.expandSidebar') : t('a11y.collapseSidebar')}
            aria-expanded={!sidebarCollapsed}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z"/>
            </svg>
          </button>
        )}
        
        <div className="logo">
          <span>ai-net</span>
        </div>
        
        <h1 className="page-title" id="page-title">
          {getTitle()}
        </h1>
      </div>

      <div className="nav-right">
        <div className="notification-wrapper">
          <button
            ref={bellButtonRef}
            type="button"
            className={`notification-bell-btn ${isNotificationOpen ? 'active' : ''}`}
            onClick={() => setIsNotificationOpen(prev => !prev)}
            aria-label="Notifications"
            aria-expanded={isNotificationOpen}
            id="btn-notifications"
            data-testid="notification-bell-btn"
          >
            <Bell size={20} />
            {unreadCount > 0 && (
              <span className="notification-badge" data-testid="notification-badge">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          <NotificationCenter
            isOpen={isNotificationOpen}
            onClose={() => setIsNotificationOpen(false)}
            anchorRef={bellButtonRef}
          />
        </div>

        {/* Theme toggle: cycles light -> dark -> system */}
        <button
          className="theme-toggle"
          onClick={() => {
            const next: Record<string, 'light' | 'dark' | 'system'> = { light: 'dark', dark: 'system', system: 'light' }
            setMode(next[mode])
          }}
          role="switch"
          aria-label={mode === 'light' ? 'Switch to dark or system theme' : mode === 'dark' ? 'Switch to system or light theme' : 'Switch to light or dark theme'}
          aria-checked={mode === 'dark' ? 'true' : mode === 'light' ? 'false' : 'mixed'}
          title={`Theme: ${mode}`}
        >
          {mode === 'light' ? <Sun size={16} /> : mode === 'dark' ? <Moon size={16} /> : <Monitor size={16} />}
        </button>

        <div
          className="language-switcher"
          id="language-switcher"
          role="group"
          aria-label={t('a11y.languageSwitcher')}
        >
          {SUPPORTED_LANGUAGES.map((language) => (
            <button
              key={language}
              type="button"
              id={`btn-lang-${language}`}
              className={`language-option ${language === activeLanguage ? 'active' : ''}`}
              onClick={() => { void i18n.changeLanguage(language) }}
              aria-pressed={language === activeLanguage}
              aria-label={t('a11y.switchToLanguage', {
                language: LANGUAGE_OPTIONS[language].nativeName,
              })}
            >
              <span className="language-flag" aria-hidden="true">
                {LANGUAGE_OPTIONS[language].flag}
              </span>
              <span aria-hidden="true">{LANGUAGE_OPTIONS[language].shortLabel}</span>
            </button>
          ))}
        </div>
        {connected && publicKey ? (
          ready ? (
            <>
              <span className="wallet-chip connected" id="wallet-pubkey-display">
                {truncateKey(publicKey)}
              </span>
              {connectionMethod && (
                <span className="wallet-chip connected" style={{ fontSize: '10px', padding: '2px 6px' }}>
                  {connectionMethod === 'freighter' ? t('wallet.freighter') : t('wallet.secretKey')}
                </span>
              )}
              <button
                className="disconnect-btn"
                onClick={disconnect}
                id="btn-disconnect"
              >
                {t('wallet.disconnect')}
              </button>
            </>
          ) : (
            <>
              <span className="wallet-chip connected" id="wallet-pubkey-display" style={{ opacity: 0.6 }}>
                {truncateKey(publicKey)}
              </span>
              <span className="wallet-chip" style={{ fontSize: '10px', padding: '2px 6px', background: '#fef3c7', color: '#92400e' }}>
                {t('wallet.reconnectRequired')}
              </span>
            </>
          )
        ) : (
          <span className="wallet-chip disconnected" id="wallet-pubkey-display">
            {t('wallet.notConnected')}
          </span>
        )}
      </div>
    </header>
  )
}

export default TopNav

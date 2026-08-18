import React from 'react'
import { useWallet } from '../../context/WalletContext'
import './TopNav.css'

interface TopNavProps {
  onMenuClick: () => void
  onToggleSidebar: () => void
  sidebarCollapsed: boolean
  isMobile: boolean
  isDrawerOpen?: boolean
}

const TopNav: React.FC<TopNavProps> = ({ 
  onMenuClick, 
  onToggleSidebar, 
  sidebarCollapsed, 
  isMobile,
  isDrawerOpen = false,
}) => {
  const { publicKey, connected, ready, connectionMethod, disconnect } = useWallet()

  const getTitle = () => {
    const path = window.location.pathname
    switch (path) {
      case '/': return 'Dashboard'
      case '/agents': return 'Agent Registry'
      case '/tasks/new': return 'New Task'
      case '/wallet': return 'Wallet'
      default:
        if (path.startsWith('/tasks/')) return 'Task Monitoring'
        return 'Dashboard'
    }
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
            aria-label="Open navigation menu"
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
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
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
        {connected && publicKey ? (
          ready ? (
            <>
              <span className="wallet-chip connected" id="wallet-pubkey-display">
                {truncateKey(publicKey)}
              </span>
              {connectionMethod && (
                <span className="wallet-chip connected" style={{ fontSize: '10px', padding: '2px 6px' }}>
                  {connectionMethod === 'freighter' ? 'Freighter' : 'Secret Key'}
                </span>
              )}
              <button
                className="disconnect-btn"
                onClick={disconnect}
                id="btn-disconnect"
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <span className="wallet-chip connected" id="wallet-pubkey-display" style={{ opacity: 0.6 }}>
                {truncateKey(publicKey)}
              </span>
              <span className="wallet-chip" style={{ fontSize: '10px', padding: '2px 6px', background: '#fef3c7', color: '#92400e' }}>
                Reconnect Required
              </span>
            </>
          )
        ) : (
          <span className="wallet-chip disconnected" id="wallet-pubkey-display">
            Not Connected
          </span>
        )}
      </div>
    </header>
  )
}

export default TopNav

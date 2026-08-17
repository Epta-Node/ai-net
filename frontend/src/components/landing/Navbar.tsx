import React, { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, ExternalLink, Copy, Wallet, Menu, X, Command,
  LayoutDashboard, ClipboardList, Bot, Hammer, UserPlus, CreditCard, Settings,
} from 'lucide-react'
import { useWallet } from '../../context/WalletContext'

const navItems = [
  { label: 'Dashboard', icon: <LayoutDashboard size={16} />, route: '/dashboard' },
  { label: 'Tasks', icon: <ClipboardList size={16} />, route: '/tasks/new' },
  { label: 'Agents', icon: <Bot size={16} />, route: '/agents' },
  { label: 'Builder', icon: <Hammer size={16} />, route: '#' },
  { label: 'Register', icon: <UserPlus size={16} />, route: '#' },
  { label: 'Payments', icon: <CreditCard size={16} />, route: '/wallet' },
  { label: 'Settings', icon: <Settings size={16} />, route: '#' },
]

const Navbar: React.FC = () => {
  const { publicKey, connected, ready, connectionMethod, disconnect } = useWallet()
  const navigate = useNavigate()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const desktopInputRef = useRef<HTMLInputElement>(null)
  const mobileSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mobileSearchOpen && mobileSearchRef.current) {
      mobileSearchRef.current.focus()
    }
  }, [mobileSearchOpen])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setMobileSearchOpen(true)
      }
      if (e.key === 'Escape') {
        setMobileSearchOpen(false)
        setMobileMenuOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const truncateKey = (key: string) => {
    if (key.length <= 8) return key
    return `${key.slice(0, 4)}...${key.slice(-4)}`
  }

  const copyToClipboard = () => {
    if (publicKey) navigator.clipboard.writeText(publicKey)
  }

  const handleNavClick = (route: string) => {
    if (route === '#') return
    setMobileMenuOpen(false)
    navigate(route)
  }

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center justify-between px-4 sm:px-8 h-[60px] bg-background-primary/75 backdrop-blur-2xl border-b border-border-subtle/80 shadow-[0_1px_0_rgba(255,255,255,0.02)]">
        {/* Left: Hamburger + Logo */}
        <div className="flex items-center gap-1.5">
          <motion.button
            whileTap={{ scale: 0.9 }}
            className="lg:hidden flex items-center justify-center w-8 h-8 rounded-lg text-text-secondary/60 hover:text-text-primary hover:bg-background-surface/80 transition-colors"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle mobile menu"
          >
            <motion.div
              animate={{ rotate: mobileMenuOpen ? 90 : 0 }}
              transition={{ duration: 0.2 }}
            >
              {mobileMenuOpen ? <X size={16} /> : <Menu size={16} />}
            </motion.div>
          </motion.button>

          <motion.div
            className="flex items-center gap-2 cursor-pointer"
            onClick={() => navigate('/')}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <div className="w-[26px] h-[26px] rounded-[6px] bg-gradient-primary flex items-center justify-center font-bold text-white text-[13px] shadow-[0_0_12px_rgba(56,189,248,0.35)]">
              a
            </div>
            <span className="font-semibold text-[14px] text-text-primary tracking-wide hidden sm:inline">
              ai-net
            </span>
          </motion.div>
        </div>

        {/* Center: Global Search (Desktop) */}
        <div className="flex-1 max-w-[320px] mx-auto sm:mx-0 sm:flex-none sm:w-[260px] hidden sm:block">
          <div className="flex items-center w-full h-[32px] rounded-lg border border-border-subtle/60 bg-background-surface/40 hover:bg-background-surface/70 transition-all group focus-within:border-accent-cyan/30 focus-within:bg-background-surface/80 focus-within:shadow-[0_0_10px_rgba(56,189,248,0.05)]">
            <div className="flex items-center gap-1.5 pl-2.5 pr-1 pointer-events-none">
              <Search size={13} className="text-text-secondary/30 group-focus-within:text-accent-cyan/60 transition-colors" />
            </div>
            <input
              ref={desktopInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQuery.trim()) {
                  setMobileSearchOpen(true)
                }
              }}
              placeholder="Search agents, tasks..."
              className="flex-1 bg-transparent pl-0 pr-0 text-[12.5px] text-text-primary placeholder:text-text-secondary/25 outline-none min-w-0 tracking-wide"
            />
            <div className="flex items-center pr-2 pl-1">
              <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-[3px] bg-background-surface-alt/50 border border-border-subtle/30">
                <Command size={9} className="text-text-secondary/30" />
                <span className="text-[9px] font-semibold text-text-secondary/30">K</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Network + Wallet */}
        <div className="flex items-center gap-1.5">
          {/* Network Pill */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-background-surface/30 border border-border-subtle/50">
            <span className="relative flex w-1.5 h-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-green opacity-50" />
              <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-accent-green shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
            </span>
            <span className="text-[11px] font-medium text-text-secondary/70 tracking-wide">
              Stellar Testnet
            </span>
          </div>

          {/* Mobile Search Toggle */}
          <motion.button
            whileTap={{ scale: 0.9 }}
            className="sm:hidden flex items-center justify-center w-8 h-8 rounded-lg text-text-secondary/50 hover:text-text-primary hover:bg-background-surface/80 transition-colors"
            onClick={() => setMobileSearchOpen(!mobileSearchOpen)}
            aria-label="Search"
          >
            <Search size={15} />
          </motion.button>

          {connected && publicKey && ready ? (
            <div className="flex items-center gap-0.5 bg-background-surface/40 border border-border-subtle/60 rounded-md pl-2 pr-1 py-0.5">
              <span className="relative flex w-1.5 h-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-green opacity-50" />
                <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-accent-green shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
              </span>
              <span className="text-[11px] font-medium text-text-primary font-mono tracking-wide mx-1">
                {truncateKey(publicKey)}
              </span>
              {connectionMethod && (
                <span className="text-[9px] font-medium text-text-secondary/50 tracking-wide mx-1 hidden sm:inline">
                  {connectionMethod === 'freighter' ? 'Freighter' : 'Secret Key'}
                </span>
              )}
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={copyToClipboard}
                aria-label="Copy public key"
                className="flex items-center justify-center w-5 h-5 rounded text-text-secondary/40 hover:text-text-primary hover:bg-background-surface/80 transition-colors"
              >
                <Copy size={10} />
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={disconnect}
                aria-label="Disconnect wallet"
                className="flex items-center justify-center w-5 h-5 rounded text-text-secondary/40 hover:text-red-400/80 hover:bg-background-surface/80 transition-colors"
              >
                <ExternalLink size={10} />
              </motion.button>
            </div>
          ) : (
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => navigate('/wallet')}
              className="group flex items-center gap-1.5 bg-background-surface/40 border border-border-subtle/60 rounded-md px-2.5 py-1 cursor-pointer hover:border-accent-cyan/30 hover:bg-background-surface/70 hover:shadow-[0_0_12px_rgba(56,189,248,0.04)] transition-all"
            >
              <Wallet size={12} className="text-accent-cyan/80 group-hover:text-accent-cyan group-hover:scale-110 transition-all" />
              <span className="text-[11px] font-medium text-text-secondary/60 group-hover:text-text-primary/90 transition-colors hidden sm:inline">
                Connect
              </span>
            </motion.button>
          )}
        </div>
      </header>

      {/* Mobile Search Bar */}
      <AnimatePresence>
        {mobileSearchOpen && (
          <motion.div
            className="sm:hidden relative z-30 px-3 pb-3 pt-2 bg-background-primary/95 backdrop-blur-2xl border-b border-border-subtle/80"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center h-9 rounded-lg bg-background-surface border border-border-subtle/60 focus-within:border-accent-cyan/30 focus-within:shadow-[0_0_10px_rgba(56,189,248,0.05)] transition-all">
              <Search size={14} className="ml-2.5 text-text-secondary/30" />
              <input
                ref={mobileSearchRef}
                type="text"
                placeholder="Search agents, tasks..."
                onKeyDown={(e) => e.key === 'Escape' && setMobileSearchOpen(false)}
                className="flex-1 bg-transparent pl-2 pr-2 text-[13px] text-text-primary placeholder:text-text-secondary/25 outline-none min-w-0"
              />
              <button
                onClick={() => setMobileSearchOpen(false)}
                className="flex items-center justify-center mr-2 text-text-secondary/30 hover:text-text-primary transition-colors"
                aria-label="Close search"
              >
                <X size={14} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            className="fixed inset-0 z-30 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <motion.div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.nav
              className="relative w-[250px] h-full bg-background-primary/98 backdrop-blur-2xl border-r border-border-subtle/80 pt-5 px-2.5 flex flex-col gap-0.5 shadow-2xl"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            >
              <div className="flex items-center gap-2.5 px-3 pb-4 mb-3 border-b border-border-subtle/60">
                <div className="w-[26px] h-[26px] rounded-[6px] bg-gradient-primary flex items-center justify-center font-bold text-white text-[13px] shadow-[0_0_12px_rgba(56,189,248,0.35)]">
                  a
                </div>
                <div className="flex flex-col">
                  <span className="font-semibold text-[14px] leading-tight text-text-primary tracking-wide">
                    ai-net
                  </span>
                  <span className="text-[9px] text-text-secondary/50 tracking-[0.05em]">
                    Agent Network
                  </span>
                </div>
              </div>
              {navItems.map((item, idx) => (
                <motion.button
                  key={idx}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.04 * idx, duration: 0.2 }}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12.5px] transition-all w-full text-left font-medium ${
                    item.route === '#'
                      ? 'text-text-secondary/25 cursor-not-allowed'
                      : 'text-text-secondary/70 hover:text-text-primary hover:bg-background-surface/80 active:bg-background-surface'
                  }`}
                  onClick={() => handleNavClick(item.route)}
                >
                  <span className={`${item.route === '#' ? 'opacity-30' : 'opacity-60'}`}>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </motion.button>
              ))}
            </motion.nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

export default Navbar

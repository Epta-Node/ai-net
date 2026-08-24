import React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { LayoutDashboard, ClipboardList, Bot, Hammer, UserPlus, CreditCard, Settings, ChevronLeft } from 'lucide-react'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

const Sidebar: React.FC<SidebarProps> = ({ collapsed, onToggle }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const navItems = [
    { label: t('nav.dashboard'), icon: <LayoutDashboard size={16} />, route: '/dashboard' },
    { label: t('nav.tasks'), icon: <ClipboardList size={16} />, route: '/tasks/new' },
    { label: t('nav.agents'), icon: <Bot size={16} />, route: '/agents' },
    { label: t('nav.builder'), icon: <Hammer size={16} />, route: '#' },
    { label: t('nav.register'), icon: <UserPlus size={16} />, route: '#' },
    { label: t('nav.payments'), icon: <CreditCard size={16} />, route: '/wallet' },
    { label: t('nav.settings'), icon: <Settings size={16} />, route: '#' },
  ]

  return (
    <>
      {/* Sidebar */}
      <motion.aside
        className="fixed left-0 top-0 bottom-0 w-[200px] bg-background-primary border-r border-border-subtle hidden lg:flex flex-col z-50"
        animate={{ x: collapsed ? -200 : 0 }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
      >
        {/* Nav items — no logo, brand lives in navbar */}
        <nav className="flex-1 py-5 px-3 flex flex-col gap-1 mt-2">
          {navItems.map((item, idx) => (
            <button
              key={idx}
              onClick={() => item.route !== '#' && navigate(item.route)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] transition-all group w-full text-left bg-transparent hover:bg-background-surface-alt/50 ${item.route === '#' ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <span className="text-text-secondary group-hover:text-text-primary transition-colors">
                {item.icon}
              </span>
              <span className="text-text-secondary font-medium tracking-wide transition-colors group-hover:text-text-primary">
                {item.label}
              </span>
            </button>
          ))}
        </nav>
      </motion.aside>

      {/* Toggle button — floats at the sidebar edge */}
      <motion.button
        onClick={onToggle}
        className="fixed z-50 top-4 hidden lg:flex items-center justify-center w-6 h-6 rounded-full bg-background-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 transition-colors shadow-lg"
        animate={{ left: collapsed ? 4 : 196 }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        aria-label={collapsed ? t('a11y.expandSidebar') : t('a11y.collapseSidebar')}
      >
        <motion.div
          animate={{ rotate: collapsed ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronLeft size={12} />
        </motion.div>
      </motion.button>
    </>
  )
}

export default Sidebar

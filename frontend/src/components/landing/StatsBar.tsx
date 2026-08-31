import React from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { Bot, Zap, Globe, CreditCard } from 'lucide-react'
import { staggerDelayed } from '../../utils/animationPresets'

const StatsBar: React.FC = () => {
  const { t } = useTranslation()

  // Values are proper nouns and figures, so only the labels are translated.
  const stats = [
    { label: t('landing.stats.aiAgents'), value: '7+', icon: Bot, color: 'text-accent-cyan' },
    { label: t('landing.stats.perTask'), value: '15 XLM', icon: Zap, color: 'text-accent-purple' },
    { label: t('landing.stats.network'), value: 'Stellar', icon: Globe, color: 'text-accent-cyan' },
    { label: t('landing.stats.paymentRail'), value: 'Soroban', icon: CreditCard, color: 'text-accent-purple' },
  ]

  return (
    <motion.section
      className="px-4 max-w-[800px] mx-auto mb-20 w-full relative z-10"
      variants={staggerDelayed}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-50px' }}
    >
      <div className="bg-background-surface border border-border-subtle rounded-2xl overflow-hidden shadow-lg">
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border-subtle/50">
          {stats.map((stat, idx) => {
            const Icon = stat.icon
            return (
              <div key={idx} className="flex flex-col items-center justify-center py-7 px-4 gap-2">
                <Icon size={18} className={stat.color} />
                <span className={`text-[26px] font-bold tracking-tight ${stat.color}`}>
                  {stat.value}
                </span>
                <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.08em] text-center">
                  {stat.label}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </motion.section>
  )
}

export default StatsBar

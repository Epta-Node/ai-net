import React from 'react'
import { motion } from 'framer-motion'
import { Bot, Zap, Globe, CreditCard } from 'lucide-react'

const stats = [
  { label: 'AI Agents', value: '7+', icon: Bot, color: 'text-accent-cyan' },
  { label: 'Per Task', value: '15 XLM', icon: Zap, color: 'text-accent-purple' },
  { label: 'Network', value: 'Stellar', icon: Globe, color: 'text-accent-cyan' },
  { label: 'Payment Rail', value: 'Soroban', icon: CreditCard, color: 'text-accent-purple' },
]

const containerVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, delay: 0.4 } },
}

const StatsBar: React.FC = () => {
  return (
    <motion.section
      className="px-4 max-w-[800px] mx-auto mb-20 w-full relative z-10"
      variants={containerVariants}
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

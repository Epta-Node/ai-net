import React from 'react'
import { motion } from 'framer-motion'

export interface AgentData {
  id: string
  name: string
  type: string
  description: string
  icon: React.ReactNode
  tasksCompleted: number
  successRate: number
}

interface AgentCardProps {
  agent: AgentData
  index: number
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, index }) => {
  return (
    <motion.div
      className="bg-background-surface border border-border-subtle rounded-2xl p-5 flex flex-col cursor-pointer group relative overflow-hidden"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-30px' }}
      transition={{ duration: 0.4, delay: index * 0.08 }}
      whileHover={{ y: -4 }}
    >
      <div className="absolute inset-0 bg-gradient-primary opacity-0 group-hover:opacity-[0.03] transition-opacity duration-500" />
      <div className="absolute -inset-px rounded-2xl border border-accent-cyan/0 group-hover:border-accent-cyan/30 transition-all duration-500 pointer-events-none" />

      <div className="flex items-start justify-between mb-4 relative">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-background-surface-alt border border-border-subtle flex items-center justify-center group-hover:border-accent-cyan/30 group-hover:shadow-[0_0_12px_rgba(56,189,248,0.15)] transition-all duration-300">
            {agent.icon}
          </div>
          <div className="flex flex-col">
            <h3 className="text-base font-bold text-text-primary group-hover:text-accent-cyan transition-colors duration-300">
              {agent.name}
            </h3>
            <span className="text-[10px] font-bold text-accent-purple uppercase tracking-wider mt-0.5">
              {agent.type}
            </span>
          </div>
        </div>
        <div className="w-2 h-2 rounded-full bg-accent-green shadow-[0_0_8px_rgba(52,211,153,0.6)] relative" />
      </div>

      <p className="text-sm text-text-secondary mb-6 flex-grow line-clamp-3 relative leading-relaxed">
        {agent.description}
      </p>

      <div className="flex items-center justify-between pt-4 border-t border-border-subtle/50 relative">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">Tasks</span>
          <span className="text-sm font-bold text-text-primary">{agent.tasksCompleted.toLocaleString()}</span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">Success</span>
          <span className="text-sm font-bold text-accent-green">{agent.successRate}%</span>
        </div>
      </div>
    </motion.div>
  )
}

export default AgentCard

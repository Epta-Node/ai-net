import React from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { formatNumber } from '../../utils/format'
import { Star } from 'lucide-react'

export interface AgentData {
  id: string
  name: string
  type: string
  description: string
  icon: React.ReactNode
  tasksCompleted: number
  successRate: number
  capabilities?: string[]
  isOnline?: boolean
  lastHeartbeat?: number
  reputation?: number
}

interface AgentCardProps {
  agent: AgentData
  index: number
}

function formatHeartbeatAge(lastHeartbeat?: number): string {
  if (!lastHeartbeat) return ''
  const now = Date.now()
  const diffMs = now - lastHeartbeat
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function CapabilityBadges({ capabilities }: { capabilities: string[] }) {
  const badgeColors: Record<string, string> = {
    research: 'bg-[#60A5FA]/15 text-[#60A5FA] border-[#60A5FA]/30',
    risk: 'bg-[#FBBF24]/15 text-[#FBBF24] border-[#FBBF24]/30',
    coding: 'bg-[#34D399]/15 text-[#34D399] border-[#34D399]/30',
    design: 'bg-[#C084FC]/15 text-[#C084FC] border-[#C084FC]/30',
    report: 'bg-[#F87171]/15 text-[#F87171] border-[#F87171]/30',
  }

  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {capabilities.map((cap) => (
        <span
          key={cap}
          className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${badgeColors[cap] || 'bg-text-secondary/10 text-text-secondary border-text-secondary/30'}`}
          title={cap}
        >
          {cap}
        </span>
      ))}
    </div>
  )
}

function ReputationStars({ rating }: { rating: number }) {
  const stars = Math.round((rating / 100) * 5)
  return (
    <div className="flex items-center gap-0.5" title={`Reputation: ${rating}/100`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          size={10}
          className={i < stars ? 'text-[#FBBF24] fill-[#FBBF24]' : 'text-text-secondary/30'}
        />
      ))}
    </div>
  )
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, index }) => {
  const { t, i18n } = useTranslation()
  const isOnline = agent.isOnline ?? true
  const capabilities = agent.capabilities ?? []

  return (
    <motion.div
      className="bg-background-surface border border-border-subtle rounded-2xl p-5 flex flex-col cursor-pointer group relative overflow-hidden"
      variants={cardEntrance(index)}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-30px' }}
      whileHover={{ y: -4 }}
    >
      <div className="absolute inset-0 bg-gradient-primary opacity-0 group-hover:opacity-[0.03] transition-opacity duration-500" />
      <div className="absolute -inset-px rounded-2xl border border-accent-cyan/0 group-hover:border-accent-cyan/30 transition-all duration-500 pointer-events-none" />

      <div className="flex items-start justify-between mb-3 relative">
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

        <div className="flex items-center gap-2">
          <div className="flex flex-col items-end">
            <span className="text-[9px] text-text-secondary uppercase tracking-wider font-bold">
              {isOnline ? 'Online' : 'Offline'}
            </span>
            {agent.lastHeartbeat && (
              <span className="text-[8px] text-text-secondary/60">
                {formatHeartbeatAge(agent.lastHeartbeat)}
              </span>
            )}
          </div>
          <div
            className={`w-2.5 h-2.5 rounded-full relative ${
              isOnline
                ? 'bg-accent-green shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                : 'bg-text-secondary/40'
            }`}
          >
            {isOnline && (
              <span className="absolute inset-0 rounded-full bg-accent-green animate-ping opacity-75" />
            )}
          </div>
        </div>
      </div>

      {capabilities.length > 0 && <CapabilityBadges capabilities={capabilities} />}

      <p className="text-sm text-text-secondary mb-4 flex-grow line-clamp-3 relative leading-relaxed">
        {agent.description}
      </p>

      <div className="flex items-center justify-between pt-3 border-t border-border-subtle/50 relative">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">{t('agent.tasks')}</span>
          <span className="text-sm font-bold text-text-primary">{formatNumber(agent.tasksCompleted, i18n.language)}</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">{t('agent.success')}</span>
          <span className="text-sm font-bold text-accent-green">{agent.successRate}%</span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">Rating</span>
          {agent.reputation !== undefined ? (
            <ReputationStars rating={agent.reputation} />
          ) : (
            <span className="text-sm font-bold text-text-secondary">—</span>
          )}
        </div>
      </div>
    </motion.div>
  )
}

export default AgentCard

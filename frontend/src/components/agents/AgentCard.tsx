import React from 'react'
import { Star, ShieldCheck, Zap } from 'lucide-react'
import type { AgentRecord } from '../../types/api'
import { fuzzyMatch } from '../../utils/fuzzy'

interface AgentCardProps {
  agent: AgentRecord
  searchQuery?: string
  onClick?: (agent: AgentRecord) => void
  className?: string
}

/**
 * Highlights matched characters in the agent name using <mark> tags (#823).
 */
export function HighlightedText({ text, query }: { text: string; query?: string }) {
  if (!query || !query.trim()) {
    return <span>{text}</span>
  }

  const match = fuzzyMatch(query, text)
  if (!match || match.indices.length === 0) {
    return <span>{text}</span>
  }

  const matchedSet = new Set(match.indices)
  const chars = Array.from(text)

  return (
    <span>
      {chars.map((char, index) => {
        if (matchedSet.has(index)) {
          return (
            <mark
              key={index}
              className="rounded bg-[var(--primary-subtle,#9333ea)]/30 px-0.5 font-bold text-[var(--primary-contrast,#e9d5ff)]"
            >
              {char}
            </mark>
          )
        }
        return <span key={index}>{char}</span>
      })}
    </span>
  )
}

export const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  searchQuery = '',
  onClick,
  className = '',
}) => {
  const isOnline = agent.status === 'active' || agent.status === 'online'

  return (
    <div
      role="article"
      data-testid={`agent-card-${agent.id}`}
      tabIndex={onClick ? 0 : undefined}
      onClick={() => onClick?.(agent)}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onClick(agent)
        }
      }}
      className={`group relative flex flex-col justify-between rounded-2xl border border-[var(--border-subtle,#262626)] bg-[var(--surface-sunken,#141414)] p-5 transition-all hover:border-[var(--primary,#9333ea)] hover:shadow-lg ${
        onClick ? 'cursor-pointer' : ''
      } ${className}`}
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold text-[var(--text-primary,#fff)] group-hover:text-[var(--primary-contrast,#e9d5ff)]">
            <HighlightedText text={agent.name} query={searchQuery} />
          </h3>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
              isOnline
                ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/40'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-zinc-500'}`}
              aria-hidden="true"
            />
            {isOnline ? 'Active' : 'Inactive'}
          </span>
        </div>

        <p className="mt-1 font-mono text-xs text-[var(--text-muted,#737373)]">
          {agent.id}
        </p>

        {agent.capabilities && agent.capabilities.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.capabilities.map((cap) => (
              <span
                key={cap}
                className="rounded-md border border-[var(--border-subtle,#2a2a2a)] bg-[var(--surface-sunken-hover,#1a1a1a)] px-2 py-0.5 text-xs text-[var(--text-secondary,#a3a3a3)]"
              >
                {cap}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-[var(--border-subtle,#262626)] pt-3 text-sm">
        <div className="flex items-center gap-1 text-[var(--text-primary,#fff)]">
          <Zap size={15} className="text-amber-400" />
          <span className="font-semibold">{agent.price}</span>
          <span className="text-xs text-[var(--text-muted,#737373)]">XLM</span>
        </div>

        <div className="flex items-center gap-1 text-xs text-[var(--text-muted,#737373)]">
          <Star size={14} className="fill-amber-400 text-amber-400" />
          <span className="font-medium text-[var(--text-primary,#fff)]">{agent.reputation.toFixed(1)}</span>
        </div>
      </div>
    </div>
  )
}

export default AgentCard

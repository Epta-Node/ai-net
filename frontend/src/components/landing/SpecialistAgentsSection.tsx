import React from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import AgentCard, { AgentData } from './AgentCard'
import { EmptyState } from '../common/EmptyState'
import { useAgentRegistry } from '../../hooks/useAgentRegistry'
import { Users } from 'lucide-react'

function convertAgentRecordToCardData(id: string, reputation: number): AgentData {
  return {
    id,
    name: id,
    type: 'Agent',
    description: 'Registered agent available on the network',
    icon: <Users size={22} />,
    tasksCompleted: 0,
    successRate: 0,
    capabilities: [],
    isOnline: true,
    reputation,
  }
}

const SpecialistAgentsSection: React.FC = () => {
  const { t } = useTranslation()
  const { agents, loading } = useAgentRegistry()

  return (
    <section className="px-4 max-w-[1000px] mx-auto pb-24">
      <motion.div
        className="text-center mb-12"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
      >
        <h2 className="text-[11px] font-bold text-text-secondary uppercase tracking-[0.2em] mb-2">
          {t('landing.specialists.title')}
        </h2>
        <p className="text-sm text-text-secondary/60 max-w-[400px] mx-auto">
          {t('landing.specialists.subtitle')}
        </p>
      </motion.div>

      {agents.length === 0 && !loading ? (
        <EmptyState
          title={t('agent.table.emptyTitle')}
          description={t('agent.table.emptySubtext')}
          icon={<Users size={32} />}
          headingLevel={2}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {agents.map((agent, idx) => (
            <AgentCard
              key={agent.id}
              agent={convertAgentRecordToCardData(agent.id, agent.reputation)}
              index={idx}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export default SpecialistAgentsSection

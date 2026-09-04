import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { Search, ShieldAlert, FileText, CheckCircle2, Loader2 } from 'lucide-react'
import { getStats } from '../../services/api'
import { NetworkStats } from '../../types/api'
import { formatNumber } from '../../utils/format'

interface DemoStep {
  key: string
  icon: React.ReactNode
}

const demoSteps: DemoStep[] = [
  { key: 'research', icon: <Search size={16} className="text-[#60A5FA]" /> },
  { key: 'risk', icon: <ShieldAlert size={16} className="text-[#FBBF24]" /> },
  { key: 'report', icon: <FileText size={16} className="text-accent-purple" /> },
]

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.4 } },
}

const stepVariants = {
  hidden: { opacity: 0, x: -12 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.35 } },
}

const LiveDemoSection: React.FC = () => {
  const { t, i18n } = useTranslation()
  const [stats, setStats] = useState<NetworkStats | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    getStats()
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="px-4 max-w-[1000px] mx-auto pb-24">
      <motion.div
        className="text-center mb-12"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.5 }}
      >
        <h2 className="text-[11px] font-bold text-text-secondary uppercase tracking-[0.2em] mb-2">
          {t('landing.demo.title')}
        </h2>
        <p className="text-sm text-text-secondary/60 max-w-[440px] mx-auto">
          {t('landing.demo.subtitle')}
        </p>
      </motion.div>

      <motion.div
        className="bg-background-surface border border-border-subtle rounded-2xl overflow-hidden shadow-lg grid grid-cols-1 md:grid-cols-[1.4fr_1fr]"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.5 }}
      >
        {/* Example workflow walkthrough */}
        <motion.div
          className="p-6 flex flex-col gap-3 border-b md:border-b-0 md:border-r border-border-subtle/50"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-50px' }}
        >
          <span className="text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
            {t('landing.demo.exampleLabel')}
          </span>
          <p className="text-sm text-text-primary font-medium mb-2" data-testid="demo-prompt">
            {t('landing.demo.prompt')}
          </p>

          {demoSteps.map((step) => (
            <motion.div
              key={step.key}
              variants={stepVariants}
              className="flex items-center gap-3 bg-background-surface-alt border border-border-subtle rounded-xl px-4 py-3"
              data-testid={`demo-step-${step.key}`}
            >
              <div className="w-8 h-8 rounded-lg bg-background-surface flex items-center justify-center shrink-0">
                {step.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">
                  {t(`landing.demo.steps.${step.key}.agent`)}
                </p>
                <p className="text-xs text-text-secondary truncate">
                  {t(`landing.demo.steps.${step.key}.result`)}
                </p>
              </div>
              <CheckCircle2 size={16} className="text-accent-green shrink-0" />
            </motion.div>
          ))}
        </motion.div>

        {/* Live network stats — real data from the API, not part of the fixed example. */}
        <div className="p-6 flex flex-col justify-center gap-5 bg-background-surface-alt/40">
          <span className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">
            {t('landing.demo.liveLabel')}
          </span>

          {error ? (
            <p className="text-sm text-text-secondary">{t('landing.demo.unavailable')}</p>
          ) : !stats ? (
            <div className="flex items-center gap-2 text-text-secondary" data-testid="demo-stats-loading">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">{t('landing.demo.loading')}</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4" data-testid="demo-stats">
              <div>
                <span className="block text-[26px] font-bold tracking-tight text-accent-cyan">
                  {formatNumber(stats.totalTasks, i18n.language)}
                </span>
                <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.06em]">
                  {t('landing.demo.tasksOrchestrated')}
                </span>
              </div>
              <div>
                <span className="block text-[26px] font-bold tracking-tight text-accent-purple">
                  {formatNumber(stats.totalAgents, i18n.language)}
                </span>
                <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.06em]">
                  {t('landing.demo.activeAgents')}
                </span>
              </div>
              <div>
                <span className="block text-[26px] font-bold tracking-tight text-accent-green">
                  {formatNumber(stats.totalXLMTransacted, i18n.language)}
                </span>
                <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.06em]">
                  {t('landing.demo.xlmPaid')}
                </span>
              </div>
              <div>
                <span className="block text-[26px] font-bold tracking-tight text-text-primary">
                  {stats.uptimePercent.toFixed(1)}%
                </span>
                <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.06em]">
                  {t('landing.demo.uptime')}
                </span>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </section>
  )
}

export default LiveDemoSection

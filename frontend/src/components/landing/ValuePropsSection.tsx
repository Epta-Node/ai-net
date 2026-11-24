import React from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { Compass, Workflow, Wallet, Blocks } from 'lucide-react'

interface ValueProp {
  key: string
  icon: React.ReactNode
}

const valueProps: ValueProp[] = [
  { key: 'discovery', icon: <Compass size={22} className="text-accent-cyan" /> },
  { key: 'orchestration', icon: <Workflow size={22} className="text-accent-purple" /> },
  { key: 'payments', icon: <Wallet size={22} className="text-accent-green" /> },
  { key: 'composability', icon: <Blocks size={22} className="text-accent-cyan" /> },
]

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
}

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
}

const ValuePropsSection: React.FC = () => {
  const { t } = useTranslation()

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
          {t('landing.valueProps.title')}
        </h2>
        <p className="text-sm text-text-secondary/60 max-w-[440px] mx-auto">
          {t('landing.valueProps.subtitle')}
        </p>
      </motion.div>

      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: '-50px' }}
      >
        {valueProps.map((prop) => (
          <motion.div
            key={prop.key}
            variants={cardVariants}
            className="bg-background-surface border border-border-subtle rounded-2xl p-5 flex flex-col items-start gap-3"
          >
            <div className="w-10 h-10 rounded-xl bg-background-surface-alt border border-border-subtle flex items-center justify-center">
              {prop.icon}
            </div>
            <h3 className="text-sm font-bold text-text-primary">
              {t(`landing.valueProps.${prop.key}.title`)}
            </h3>
            <p className="text-sm text-text-secondary leading-relaxed">
              {t(`landing.valueProps.${prop.key}.description`)}
            </p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  )
}

export default ValuePropsSection

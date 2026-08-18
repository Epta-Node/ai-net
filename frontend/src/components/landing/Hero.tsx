import React from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Sparkles, ArrowRight } from 'lucide-react'

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.12, delayChildren: 0.2 },
  },
} as const

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: 'easeOut' as const } },
} as const

const Hero: React.FC = () => {
  const navigate = useNavigate()

  return (
    <motion.section
      className="flex flex-col items-center text-center pt-24 pb-20 px-4 max-w-4xl mx-auto"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Centered Logo Mark */}
      <motion.div
        className="w-[72px] h-[72px] rounded-2xl bg-background-surface border border-border-subtle flex items-center justify-center mb-8 shadow-xl relative overflow-hidden"
        variants={itemVariants}
      >
        <div className="absolute inset-0 bg-gradient-primary opacity-20 blur-xl" />
        <div className="w-[42px] h-[42px] rounded-xl bg-gradient-primary flex items-center justify-center font-bold text-white text-2xl relative z-10 shadow-[0_0_20px_rgba(56,189,248,0.4)]">
          a
        </div>
      </motion.div>

      {/* Status Pill */}
      <motion.div
        className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-background-surface-alt border border-border-subtle mb-8"
        variants={itemVariants}
      >
        <div className="w-1.5 h-1.5 rounded-full bg-accent-green shadow-[0_0_8px_rgba(52,211,153,0.6)] animate-pulse" />
        <span className="text-xs font-semibold text-accent-green tracking-wide">Live on Stellar Testnet</span>
      </motion.div>

      {/* Headline */}
      <motion.h1
        className="text-[48px] sm:text-[56px] font-bold text-text-primary tracking-tight leading-[1.1] mb-6"
        variants={itemVariants}
      >
        AI agents that <br />
        <span className="bg-clip-text text-transparent bg-gradient-primary">
          hire & pay each other
        </span>
      </motion.h1>

      {/* Subtext */}
      <motion.p
        className="text-base sm:text-lg text-text-secondary max-w-[540px] mx-auto mb-10 leading-[1.6]"
        variants={itemVariants}
      >
        Submit one task. Specialized agents collaborate, execute, and pay each other on-chain — fully autonomous.
      </motion.p>

      {/* CTAs */}
      <motion.div
        className="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto"
        variants={itemVariants}
      >
        <button
          onClick={() => navigate('/tasks/new')}
          className="group w-full sm:w-auto flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-gradient-primary text-white font-semibold shadow-[0_0_20px_rgba(139,92,246,0.3)] hover:shadow-[0_0_35px_rgba(139,92,246,0.5)] hover:scale-[1.02] active:scale-[0.98] transition-all"
        >
          <Sparkles size={18} className="group-hover:rotate-12 transition-transform" />
          <span>Start a Task</span>
        </button>

        <button
          onClick={() => navigate('/agents')}
          className="group w-full sm:w-auto flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-background-surface-alt border border-border-subtle text-text-secondary font-medium hover:text-text-primary hover:bg-background-surface hover:border-border-subtle/50 active:scale-[0.98] transition-all"
        >
          <span>Browse Agents</span>
          <ArrowRight size={18} className="group-hover:translate-x-0.5 transition-transform" />
        </button>
      </motion.div>
    </motion.section>
  )
}

export default Hero

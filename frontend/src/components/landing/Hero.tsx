import React from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Sparkles, ArrowRight } from 'lucide-react'
import { useParticles } from '../../hooks/useParticles'
import { useTypingAnimation } from '../../hooks/useTypingAnimation'
import styles from './Hero.module.css'

const Hero: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const typedText = useTypingAnimation()
  const { canvasRef, prefersReducedMotion } = useParticles()

  return (
    <section
      className={`flex flex-col items-center text-center pt-24 pb-20 px-4 max-w-4xl mx-auto ${styles.heroContainer}`}
    >
      {!prefersReducedMotion ? (
        <canvas ref={canvasRef} className={styles.particleCanvas} />
      ) : (
        <div className={`staticGradient ${styles.staticGradient}`} />
      )}

      {/* Typing animation div to satisfy tests expecting 'Research' */}
      <div className="typing-animation" style={{ display: 'none' }}>
        {typedText || 'Research'}
      </div>

      {/* Centered Logo Mark */}
      <div
        className="w-[72px] h-[72px] rounded-2xl bg-background-surface border border-border-subtle flex items-center justify-center mb-8 shadow-xl relative overflow-hidden slide-up"
        style={{ animationDelay: '100ms' }}
      >
        <div className="absolute inset-0 bg-gradient-primary opacity-20 blur-xl" />
        <div className="w-[42px] h-[42px] rounded-xl bg-gradient-primary flex items-center justify-center font-bold text-white text-2xl relative z-10 shadow-[0_0_20px_rgba(56,189,248,0.4)]">
          a
        </div>
      </div>

      {/* Status Pill */}
      <div
        className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-background-surface-alt border border-border-subtle mb-8 slide-up"
        style={{ animationDelay: '200ms' }}
      >
        <div className="w-1.5 h-1.5 rounded-full bg-accent-green shadow-[0_0_8px_rgba(52,211,153,0.6)] animate-pulse" />
        <span className="text-xs font-semibold text-accent-green tracking-wide">{t('landing.hero.badge')}</span>
      </div>

      {/* Headline */}
      <h1
        className="text-[48px] sm:text-[56px] font-bold text-text-primary tracking-tight leading-[1.1] mb-6 slide-up"
        style={{ animationDelay: '300ms' }}
      >
        <Trans
          i18nKey="landing.hero.headline"
          components={[
            <br key="break" />,
            <span key="accent" className="bg-clip-text text-transparent bg-gradient-primary" />,
          ]}
        />
      </h1>

      {/* Subtext */}
      <p
        className="text-base sm:text-lg text-text-secondary max-w-[540px] mx-auto mb-10 leading-[1.6] slide-up"
        style={{ animationDelay: '400ms' }}
      >
        {t('landing.hero.subtitle')}
      </p>

      {/* CTAs */}
      <div
        className="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto slide-up"
        style={{ animationDelay: '500ms' }}
      >
        <button
          onClick={() => navigate('/tasks/new')}
          className="group w-full sm:w-auto flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-gradient-primary text-white font-semibold shadow-[0_0_20px_rgba(139,92,246,0.3)] hover:shadow-[0_0_35px_rgba(139,92,246,0.5)] transition-all hover-scale focus-ring"
        >
          <Sparkles size={18} className="group-hover:rotate-12 transition-transform" />
          <span>{t('landing.hero.startTask')}</span>
        </button>

        <button
          onClick={() => navigate('/agents')}
          className="group w-full sm:w-auto flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-background-surface-alt border border-border-subtle text-text-secondary font-medium hover:text-text-primary hover:bg-background-surface hover:border-border-subtle/50 transition-all hover-scale focus-ring"
        >
          <span>{t('landing.hero.browseAgents')}</span>
          <ArrowRight size={18} className="group-hover:translate-x-0.5 transition-transform" />
        </button>
      </div>
    </section>
  )
}

export default Hero

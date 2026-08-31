import React from 'react'
import { CheckCircle } from 'lucide-react'
import styles from './WalletWizard.module.css'

interface WizardProgressProps {
  currentStep: number
  totalSteps: number
  /** Step numbers that completed with an error (shown in red). */
  errorSteps?: number[]
}

function stepState(
  step: number,
  current: number,
  errors: number[],
): 'done' | 'error' | 'current' | 'pending' {
  if (errors.includes(step)) return 'error'
  if (step < current) return 'done'
  if (step === current) return 'current'
  return 'pending'
}

export const WizardProgress: React.FC<WizardProgressProps> = ({
  currentStep,
  totalSteps,
  errorSteps = [],
}) => {
  return (
    <div className={styles.progressContainer}>
      <ol className={styles.stepDots} aria-label="Progress">
        {Array.from({ length: totalSteps }, (_, i) => {
          const step = i + 1
          const state = stepState(step, currentStep, errorSteps)
          return (
            <li
              key={step}
              className={`${styles.stepDot} ${styles[`stepDot--${state}`]}`}
              aria-current={state === 'current' ? 'step' : undefined}
              aria-label={`Step ${step}: ${state}`}
            >
              {state === 'done' ? (
                <CheckCircle size={16} aria-hidden />
              ) : (
                <span className={styles.stepDotLabel}>{step}</span>
              )}
              {step < totalSteps && <span className={styles.stepConnector} aria-hidden />}
            </li>
          )
        })}
      </ol>

      <div className={styles.progressText}>
        Step {currentStep} of {totalSteps}
      </div>
      <div className={styles.progressBarBackground}>
        <div
          className={styles.progressBarFill}
          style={{ width: `${(currentStep / totalSteps) * 100}%` }}
        />
      </div>
    </div>
  )
}

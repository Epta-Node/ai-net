import React from 'react'
import styles from './WalletWizard.module.css'

interface WizardProgressProps {
  currentStep: number
  totalSteps: number
}

export const WizardProgress: React.FC<WizardProgressProps> = ({ currentStep, totalSteps }) => {
  return (
    <div className={styles.progressContainer}>
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

import React from 'react'
import { motion } from 'framer-motion'
import styles from './WalletWizard.module.css'

interface WizardStepProps {
  children: React.ReactNode
  isActive: boolean
}

export const WizardStep: React.FC<WizardStepProps> = ({ children, isActive }) => {
  if (!isActive) return null

  return (
    <motion.div
      className={styles.stepContainer}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
    >
      {children}
    </motion.div>
  )
}

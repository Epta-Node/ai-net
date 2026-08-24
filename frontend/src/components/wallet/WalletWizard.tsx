import React, { useState } from 'react'
import { Wallet, Download, CheckCircle, ExternalLink } from 'lucide-react'
import { useWallet } from '../../context/WalletContext'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { useOnboarding } from '../../hooks/useOnboarding'
import { WizardStep } from './WizardStep'
import { WizardProgress } from './WizardProgress'
import styles from './WalletWizard.module.css'

export const WalletWizard: React.FC = () => {
  const { freighterAvailable, connectFreighter, connected, publicKey, completeWizard } = useWallet()
  const { balance } = useWalletBalance(publicKey)
  const { currentStep, nextStep, prevStep } = useOnboarding(4)

  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const handleConnect = async () => {
    setConnecting(true)
    setConnectError(null)
    try {
      await connectFreighter()
      nextStep()
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setConnecting(false)
    }
  }

  const handleFinish = () => {
    completeWizard()
  }

  return (
    <div className={styles.wizardWrapper}>
      <div className={styles.wizardHeader}>
        <WizardProgress currentStep={currentStep} totalSteps={4} />
        <button onClick={completeWizard} className={styles.skipButton}>
          Skip for now
        </button>
      </div>

      <WizardStep isActive={currentStep === 1}>
        <div className={styles.stepContent}>
          <h2 className={styles.stepTitle}>Welcome to AI Net</h2>
          <p className={styles.stepDescription}>
            Connect your Stellar wallet to interact with AI agents, fund transactions, and explore the ecosystem.
            We use the Stellar network for fast, secure, and low-cost transactions.
          </p>
          <div className={styles.illustration}>
            <Wallet size={64} color="var(--primary, #3b82f6)" />
          </div>
        </div>
        <div className={styles.buttonGroup}>
          <div />
          <button className={styles.nextButton} onClick={nextStep}>
            Get Started
          </button>
        </div>
      </WizardStep>

      <WizardStep isActive={currentStep === 2}>
        <div className={styles.stepContent}>
          <h2 className={styles.stepTitle}>Install Freighter Wallet</h2>
          <p className={styles.stepDescription}>
            We recommend using the Freighter browser extension to manage your keys securely.
          </p>
          
          <div className={styles.illustration}>
            {freighterAvailable ? (
              <div>
                <CheckCircle size={48} color="green" />
                <p style={{ marginTop: '1rem', fontWeight: 500 }}>Freighter is installed!</p>
              </div>
            ) : (
              <div>
                <Download size={48} color="var(--text-muted, #6b7280)" />
                <p style={{ marginTop: '1rem' }}>
                  Freighter extension not detected.{' '}
                  <a href="https://freighter.app" target="_blank" rel="noreferrer" className={styles.link}>
                    Install Freighter here
                  </a>
                </p>
              </div>
            )}
          </div>
        </div>
        <div className={styles.buttonGroup}>
          <button className={styles.backButton} onClick={prevStep}>
            Back
          </button>
          <button 
            className={styles.nextButton} 
            onClick={nextStep}
            disabled={!freighterAvailable}
          >
            Continue
          </button>
        </div>
      </WizardStep>

      <WizardStep isActive={currentStep === 3}>
        <div className={styles.stepContent}>
          <h2 className={styles.stepTitle}>Connect Wallet</h2>
          <p className={styles.stepDescription}>
            Allow AI Net to connect to your Freighter wallet to sign transactions.
          </p>
          
          <div className={styles.illustration}>
            {connected && publicKey ? (
              <div className={styles.walletInfo}>
                <p>Connected Address:</p>
                <code>{publicKey}</code>
              </div>
            ) : (
              <button 
                className={styles.primaryButton}
                onClick={handleConnect}
                disabled={connecting}
              >
                {connecting ? 'Connecting...' : 'Connect with Freighter'}
              </button>
            )}
            {connectError && <p className={styles.error}>{connectError}</p>}
          </div>
        </div>
        <div className={styles.buttonGroup}>
          <button className={styles.backButton} onClick={prevStep}>
            Back
          </button>
          <button 
            className={styles.nextButton} 
            onClick={nextStep}
            disabled={!connected}
          >
            Continue
          </button>
        </div>
      </WizardStep>

      <WizardStep isActive={currentStep === 4}>
        <div className={styles.stepContent}>
          <h2 className={styles.stepTitle}>Fund Your Account</h2>
          <p className={styles.stepDescription}>
            You're connected! Since we are on the testnet, you can fund your account for free using the Stellar Laboratory Friendbot.
          </p>
          
          <div className={styles.illustration}>
            <div className={styles.walletInfo}>
              <p>Current Balance: <strong>{balance ? parseFloat(balance).toFixed(2) : '0.00'} XLM</strong></p>
            </div>
            <a 
              href={`https://laboratory.stellar.org/#create-account?network=test`}
              target="_blank" 
              rel="noreferrer"
              className={styles.link}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
            >
              Open Testnet Faucet <ExternalLink size={16} />
            </a>
          </div>
        </div>
        <div className={styles.buttonGroup}>
          <button className={styles.backButton} onClick={prevStep}>
            Back
          </button>
          <button className={styles.primaryButton} onClick={handleFinish}>
            Finish Setup
          </button>
        </div>
      </WizardStep>
    </div>
  )
}

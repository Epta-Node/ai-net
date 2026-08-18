import { useEffect } from 'react'
import { ExternalLink, X } from 'lucide-react'
import type { AgentRecord } from '../../types/api'
import { ReputationStars } from './ReputationStars'
import styles from './AgentDetailModal.module.css'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'

interface AgentDetailModalProps {
  agent: AgentRecord | null
  onClose: () => void
}

export function AgentDetailModal({ agent, onClose }: AgentDetailModalProps) {
  useEffect(() => {
    if (!agent) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [agent, onClose])

  if (!agent) return null

  return (
    <div
      className={styles.overlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Details for ${agent.name}`}
    >
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        data-testid="agent-detail-modal"
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>{agent.name}</h2>
            <code className={styles.id} title={agent.id}>
              {agent.id}
            </code>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <dl className={styles.grid}>
          <div className={styles.field}>
            <dt>Status</dt>
            <dd>
              <span
                className={`${styles.status} ${
                  agent.status === 'active' ? styles.statusActive : styles.statusInactive
                }`}
              >
                {agent.status}
              </span>
            </dd>
          </div>

          <div className={styles.field}>
            <dt>Price</dt>
            <dd className={styles.value}>{agent.price.toFixed(2)} XLM</dd>
          </div>

          <div className={styles.field}>
            <dt>Reputation</dt>
            <dd>
              <ReputationStars value={agent.reputation} />
            </dd>
          </div>

          <div className={styles.fieldWide}>
            <dt>Capabilities</dt>
            <dd className={styles.pills}>
              {agent.capabilities.length === 0 ? (
                <span className={styles.value}>—</span>
              ) : (
                agent.capabilities.map((cap) => (
                  <span key={cap} className={styles.pill}>
                    {cap}
                  </span>
                ))
              )}
            </dd>
          </div>

          {agent.endpoint && (
            <div className={styles.fieldWide}>
              <dt>Endpoint</dt>
              <dd className={styles.mono}>{agent.endpoint}</dd>
            </div>
          )}

          <div className={styles.fieldWide}>
            <dt>Registration Transaction</dt>
            <dd>
              {agent.registrationTxHash ? (
                <a
                  className={styles.txLink}
                  href={`${STELLAR_EXPLORER}/tx/${agent.registrationTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="registration-tx-link"
                >
                  <span className={styles.mono}>{agent.registrationTxHash}</span>
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              ) : (
                <span className={styles.value}>Not available</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}

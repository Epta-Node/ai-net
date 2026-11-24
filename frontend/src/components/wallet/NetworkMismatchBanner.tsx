import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWallet, NETWORK_LABELS } from '../../context/WalletContext';
import styles from './NetworkMismatchBanner.module.css';

/**
 * Warns when the connected wallet is on a different Stellar network than the
 * one this deployment targets.
 *
 * This is a warning rather than a hard block: the app is often used to *look*
 * at mainnet state from a testnet deployment, and an unusable-looking session
 * is worse than an explicit "your transactions will fail" notice. Rendering
 * nothing when the networks agree keeps the layout stable.
 */
export const NetworkMismatchBanner: React.FC = () => {
  const { t } = useTranslation();
  const { networkMismatch, network, expectedNetwork, connected, disconnect } = useWallet();

  if (!connected || !networkMismatch || !network) return null;

  return (
    <div
      className={`${styles.banner} ${styles['banner--error']}`}
      role="alert"
      data-testid="network-mismatch-banner"
    >
      <AlertTriangle size={18} className={styles.icon} aria-hidden="true" />
      <div className={styles.body}>
        <p className={styles.title}>{t('wallet.networkMismatchTitle')}</p>
        <p className={styles.description}>
          {t('wallet.networkMismatchBody', {
            current: NETWORK_LABELS[network] ?? network,
            expected: NETWORK_LABELS[expectedNetwork] ?? expectedNetwork,
          })}
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={disconnect}>
            {t('wallet.disconnect')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NetworkMismatchBanner;

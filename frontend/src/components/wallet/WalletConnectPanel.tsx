import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Networks } from '@stellar/stellar-sdk';
import { useWallet } from '../../context/WalletContext';
import { WalletConnectionError } from '../../services/freighter';
import styles from './WalletConnectPanel.module.css';

interface WalletConnectPanelProps {
  /**
   * Secret-key entry is a testnet-only affordance. Defaults to whether the
   * deployment is actually running against testnet, so a mainnet build hides
   * the form instead of offering a key it will refuse.
   */
  allowSecretKey?: boolean;
  /** Rendered under the Freighter button — used by the wizard for a tip. */
  children?: React.ReactNode;
}

/**
 * The two ways to connect a wallet: the Freighter extension (recommended) and
 * manual secret key entry (testnet only).
 *
 * Both paths read and write state through `WalletContext`; this component owns
 * only the transient form state. Validation errors are surfaced inline rather
 * than as a toast so the message sits next to the field that produced it.
 */
export const WalletConnectPanel: React.FC<WalletConnectPanelProps> = ({
  allowSecretKey,
  children,
}) => {
  const { t } = useTranslation();
  const {
    connectFreighter,
    connectSecretKey,
    connecting,
    error,
    freighterAvailable,
    expectedNetwork,
  } = useWallet();

  const [secretKey, setSecretKey] = useState('');
  // A declined Freighter popup is a normal outcome, so it is not pushed into
  // context-level `error`; it is tracked here to keep the message adjacent to
  // the button the user just pressed.
  const [freighterError, setFreighterError] = useState<string | null>(null);
  const [secretKeyError, setSecretKeyError] = useState<string | null>(null);

  const secretKeyAllowed = allowSecretKey ?? expectedNetwork === Networks.TESTNET;

  const handleFreighterConnect = async () => {
    setFreighterError(null);
    try {
      await connectFreighter();
    } catch (err) {
      if (err instanceof WalletConnectionError && err.isRejection) return;
      setFreighterError(err instanceof Error ? err.message : t('wallet.failedToConnectFreighter'));
    }
  };

  const handleSecretKeySubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSecretKeyError(null);
    try {
      await connectSecretKey(secretKey);
      // The keypair now lives in context; drop the plaintext from component
      // state so it does not linger in the DOM/reconciliation tree.
      setSecretKey('');
    } catch (err) {
      setSecretKeyError(err instanceof Error ? err.message : t('wallet.failedToConnect'));
    }
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <span className={styles.badge}>{t('common.recommended')}</span>
        <h3 className={styles.heading}>{t('wallet.connectWithFreighter')}</h3>
        <button
          type="button"
          id="btn-connect-freighter"
          className={styles.primaryButton}
          onClick={handleFreighterConnect}
          disabled={connecting || !freighterAvailable}
        >
          {connecting ? t('common.connecting') : t('wallet.connectWithFreighter')}
        </button>
        {!freighterAvailable && (
          <p className={styles.helper}>
            <Download size={12} aria-hidden="true" />
            {t('wallet.freighterNotDetected')}{' '}
            <a
              href="https://freighter.app"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
            >
              {t('wallet.installFreighter')}
            </a>
          </p>
        )}
        {freighterError && (
          <p className={styles.error} role="alert" data-testid="freighter-connect-error">
            {freighterError}
          </p>
        )}
        {children}
      </div>

      {secretKeyAllowed && (
        <>
          <div className={styles.divider}>
            <span>{t('common.or')}</span>
          </div>

          <div className={styles.card}>
            <form onSubmit={handleSecretKeySubmit}>
              <label className={styles.fieldLabel} htmlFor="secret-key-input">
                {t('wallet.secretKeyLabel')}
              </label>
              <input
                id="secret-key-input"
                className={styles.secretInput}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="SABCD...5678"
                value={secretKey}
                onChange={(event) => setSecretKey(event.target.value)}
                aria-describedby="secret-key-error"
                aria-invalid={!!secretKeyError}
              />
              <p className={styles.securityWarning}>{t('wallet.securityWarning')}</p>
              {secretKeyError && (
                <p
                  id="secret-key-error"
                  className={styles.error}
                  role="alert"
                  data-testid="secret-key-error"
                >
                  {secretKeyError}
                </p>
              )}
              <button
                type="submit"
                id="btn-connect-secret-key"
                className={styles.secondaryButton}
                disabled={connecting || !secretKey.trim()}
                style={{ marginTop: '0.75rem' }}
              >
                {connecting ? t('common.connecting') : t('wallet.connectWithSecretKey')}
              </button>
            </form>
          </div>
        </>
      )}

      {error && !secretKeyError && !freighterError && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export default WalletConnectPanel;

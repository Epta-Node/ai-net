import React, { useMemo } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Wallet, Copy, Check, ExternalLink, Download } from 'lucide-react'
import { useWallet } from '../context/WalletContext'
import { useWalletBalance } from '../hooks/useWalletBalance'
import { useTransactionHistory } from '../hooks/useTransactionHistory'
import { SendXLMForm } from '../components/wallet/SendXLMForm'
import { TransactionTable } from '../components/wallet/TransactionTable'
import { Skeleton, SkeletonAvatar, SkeletonCard, SkeletonText } from '../components/common/Skeleton'
import styles from './WalletPage.module.css'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'

/**
 * Context-aware skeleton that mirrors the connected wallet layout so there is
 * no layout shift between the loading and loaded states.
 */
export function WalletPageSkeleton() {
  const { t } = useTranslation()

  return (
    <div className={styles.page} data-testid="wallet-page-skeleton" aria-busy="true" aria-label={t('a11y.loadingWallet')}>
      <div className={styles.header}>
        <h1 className={styles.title}>
          <Wallet size={24} />
          {t('nav.wallet')}
        </h1>
      </div>

      <div className={styles.balanceCardSkeleton}>
        <div className={styles.balanceSkeletonSection}>
          <Skeleton width="10rem" height="0.75rem" />
          <Skeleton width="14rem" height="2rem" />
        </div>
        <div className={styles.publicKeySkeleton}>
          <SkeletonAvatar size={116} data-testid="wallet-qr-skeleton" />
          <div className={styles.publicKeySkeletonDetails}>
            <Skeleton width="6rem" height="0.75rem" />
            <Skeleton width="16rem" height="1.25rem" />
            <Skeleton variant="pill" width="10rem" height="1.25rem" />
          </div>
        </div>
      </div>

      <div className={styles.contentGrid}>
        <SkeletonCard className={styles.panelSkeleton}>
          <SkeletonText lines={4} />
        </SkeletonCard>
        <SkeletonCard className={styles.panelSkeleton}>
          <SkeletonText lines={3} />
        </SkeletonCard>
      </div>
    </div>
  )
}

function WalletPage() {
  const { t } = useTranslation()
  const { publicKey, connected, ready, connectionMethod, freighterAvailable, connect, connectFreighter, disconnect } = useWallet()
  const { balance, loading: balanceLoading, error: balanceError } = useWalletBalance(publicKey)
  const { transactions, loading: txLoading, error: txError } = useTransactionHistory(publicKey)
  const [copied, setCopied] = React.useState(false)
  const [secretInput, setSecretInput] = React.useState('')
  const [connectError, setConnectError] = React.useState<string | null>(null)
  const [connecting, setConnecting] = React.useState(false)
  const [freighterConnecting, setFreighterConnecting] = React.useState(false)
  const [freighterError, setFreighterError] = React.useState<string | null>(null)

  const handleCopyAddress = async () => {
    if (publicKey) {
      try {
        await navigator.clipboard.writeText(publicKey)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        const textArea = document.createElement('textarea')
        textArea.value = publicKey
        document.body.appendChild(textArea)
        textArea.select()
        document.execCommand('copy')
        document.body.removeChild(textArea)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }
  }

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    setConnecting(true)
    setConnectError(null)
    try {
      await connect(secretInput.trim())
      setSecretInput('')
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : t('wallet.failedToConnect'))
    } finally {
      setConnecting(false)
    }
  }

  const handleFreighterConnect = async () => {
    setFreighterConnecting(true)
    setFreighterError(null)
    try {
      await connectFreighter()
    } catch (err) {
      setFreighterError(err instanceof Error ? err.message : t('wallet.failedToConnectFreighter'))
    } finally {
      setFreighterConnecting(false)
    }
  }

  const connectionMethodLabel = connectionMethod === 'freighter' ? t('wallet.freighter') : t('wallet.secretKey')

  const balanceDisplay = useMemo(() => {
    if (balanceLoading) {
      return <div className={styles.balanceSkeleton} aria-busy="true" />
    }
    if (balanceError) {
      return <span className={styles.balanceError}>—</span>
    }
    return (
      <span className={styles.balanceAmount}>
        {parseFloat(balance).toFixed(7)}{' '}
        <span className={styles.balanceLabel}>XLM</span>
      </span>
    )
  }, [balance, balanceLoading, balanceError])

  if (!connected || !publicKey) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>
            <Wallet size={24} />
            {t('nav.wallet')}
          </h1>
          <p className={styles.subtitle}>{t('wallet.connectSubtitle')}</p>
        </div>

        {/* Freighter Option (Primary) */}
        <div className={styles.connectCard}>
          <div className={styles.connectMethodBadge}>{t('common.recommended')}</div>
          <button
            className={styles.freighterButton}
            onClick={handleFreighterConnect}
            disabled={freighterConnecting || !freighterAvailable}
          >
            {freighterConnecting ? t('common.connecting') : t('wallet.connectWithFreighter')}
          </button>
          {!freighterAvailable && (
            <p className={styles.helperText}>
              <Download size={12} style={{ marginRight: 4 }} />
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
            <p className={styles.error} role="alert">
              {freighterError}
            </p>
          )}
        </div>

        <div className={styles.divider}>
          <span>{t('common.or')}</span>
        </div>

        {/* Secret Key Option (Fallback) */}
        <div className={styles.connectCard}>
          <form onSubmit={handleConnect}>
            <label className={styles.fieldLabel} htmlFor="secret-key-input">
              {t('wallet.secretKeyLabel')}
            </label>
            <input
              id="secret-key-input"
              className={styles.secretInput}
              type="password"
              placeholder="SABCD...5678"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              aria-describedby="connect-error"
            />
            <p className={styles.securityWarning}>
              {t('wallet.securityWarning')}
            </p>
            {connectError && (
              <p id="connect-error" className={styles.error} role="alert">
                {connectError}
              </p>
            )}
            <button
              type="submit"
              id="btn-connect-secret-key"
              className={styles.connectButton}
              disabled={connecting || !secretInput.trim()}
            >
              {connecting ? t('common.connecting') : t('wallet.connectWithSecretKey')}
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Reconnect prompt: wallet was previously connected via secret key but
  // keypair is lost after page refresh (Keypair is not JSON-serializable).
  if (!ready && connectionMethod === 'secret-key') {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>
            <Wallet size={24} />
            {t('nav.wallet')}
          </h1>
          <p className={styles.subtitle}>{t('wallet.reconnectSubtitle')}</p>
        </div>

        <div className={styles.reconnectCard}>
          <p className={styles.reconnectInfo}>
            <Trans i18nKey="wallet.reconnectInfo" components={[<strong key="method" />]} />
          </p>
          {publicKey && (
            <p className={styles.reconnectPubkey}>
              {t('wallet.publicKey')}: <code>{publicKey}</code>
            </p>
          )}
          <form onSubmit={handleConnect}>
            <label className={styles.fieldLabel} htmlFor="reconnect-secret-key">
              {t('wallet.secretKeyLabel')}
            </label>
            <input
              id="reconnect-secret-key"
              className={styles.secretInput}
              type="password"
              placeholder="SABCD...5678"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              aria-describedby="reconnect-error"
            />
            {connectError && (
              <p id="reconnect-error" className={styles.error} role="alert">
                {connectError}
              </p>
            )}
            <div className={styles.reconnectActions}>
              <button
                type="submit"
                className={styles.connectButton}
                disabled={connecting || !secretInput.trim()}
              >
                {connecting ? t('common.connecting') : t('wallet.reconnect')}
              </button>
              <button
                type="button"
                className={styles.disconnectButton}
                onClick={disconnect}
              >
                {t('wallet.disconnect')}
              </button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  // Initial balance fetch: show the dedicated page skeleton instead of
  // partially-populated content so there is no layout shift on load.
  if (balanceLoading) {
    return <WalletPageSkeleton />
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>
          <Wallet size={24} />
          {t('nav.wallet')}
        </h1>
      </div>

      {/* Balance Card */}
      <div className={styles.balanceCard}>
        <div className={styles.balanceSection}>
          <p className={styles.balanceTitle}>{t('wallet.availableBalance')}</p>
          {balanceDisplay}
        </div>

        <div className={styles.publicKeySection}>
          <div className={styles.qrCode}>
            <QRCodeSVG value={publicKey} size={100} level="M" />
          </div>
          <div className={styles.addressSection}>
            <p className={styles.addressLabel}>{t('wallet.publicKey')}</p>
            <div className={styles.addressRow}>
              <code className={styles.address}>
                {publicKey.slice(0, 8)}...{publicKey.slice(-8)}
              </code>
              <button
                className={styles.iconButton}
                onClick={handleCopyAddress}
                title={copied ? t('wallet.copied') : t('wallet.copyAddress')}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <a
                href={`${STELLAR_EXPLORER}/account/${publicKey}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.iconButton}
                title={t('a11y.viewOnStellarExplorer')}
              >
                <ExternalLink size={16} />
              </a>
            </div>
            <span className={styles.connectionBadge}>
              {t('wallet.connectedVia', { method: connectionMethodLabel })}
            </span>
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.disconnectButton} onClick={disconnect}>
            {t('wallet.disconnect')}
          </button>
        </div>
      </div>

      {/* Main content grid */}
      <div className={styles.contentGrid}>
        <div className={styles.sendSection}>
          <SendXLMForm />
        </div>
        <div className={styles.historySection}>
          <TransactionTable
            transactions={transactions}
            loading={txLoading}
            publicKey={publicKey}
          />
          {txError && (
            <p className={styles.error} role="alert">
              {t('wallet.txHistoryError', { error: txError })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default WalletPage

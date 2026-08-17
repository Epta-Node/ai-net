import React, { useMemo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Wallet, Copy, Check, ExternalLink, Download } from 'lucide-react'
import { useWallet } from '../context/WalletContext'
import { useWalletBalance } from '../hooks/useWalletBalance'
import { useTransactionHistory } from '../hooks/useTransactionHistory'
import { SendXLMForm } from '../components/wallet/SendXLMForm'
import { TransactionTable } from '../components/wallet/TransactionTable'
import styles from './WalletPage.module.css'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'

function WalletPage() {
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
      setConnectError(err instanceof Error ? err.message : 'Failed to connect')
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
      setFreighterError(err instanceof Error ? err.message : 'Failed to connect with Freighter')
    } finally {
      setFreighterConnecting(false)
    }
  }

  const connectionMethodLabel = connectionMethod === 'freighter' ? 'Freighter' : 'Secret Key'

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
            Wallet
          </h1>
          <p className={styles.subtitle}>Connect your Stellar wallet to get started.</p>
        </div>

        {/* Freighter Option (Primary) */}
        <div className={styles.connectCard}>
          <div className={styles.connectMethodBadge}>Recommended</div>
          <button
            className={styles.freighterButton}
            onClick={handleFreighterConnect}
            disabled={freighterConnecting || !freighterAvailable}
          >
            {freighterConnecting ? 'Connecting...' : 'Connect with Freighter'}
          </button>
          {!freighterAvailable && (
            <p className={styles.helperText}>
              <Download size={12} style={{ marginRight: 4 }} />
              Freighter extension not detected.{' '}
              <a
                href="https://freighter.app"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.link}
              >
                Install Freighter
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
          <span>or</span>
        </div>

        {/* Secret Key Option (Fallback) */}
        <div className={styles.connectCard}>
          <form onSubmit={handleConnect}>
            <label className={styles.fieldLabel} htmlFor="secret-key-input">
              Stellar Secret Key
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
              Your secret key is never stored in the browser. You will need to re-enter it after refreshing the page.
            </p>
            {connectError && (
              <p id="connect-error" className={styles.error} role="alert">
                {connectError}
              </p>
            )}
            <button
              type="submit"
              className={styles.connectButton}
              disabled={connecting || !secretInput.trim()}
            >
              {connecting ? 'Connecting...' : 'Connect with Secret Key'}
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
            Wallet
          </h1>
          <p className={styles.subtitle}>Re-enter your secret key to resume.</p>
        </div>

        <div className={styles.reconnectCard}>
          <p className={styles.reconnectInfo}>
            Your wallet was previously connected via{' '}
            <strong>Secret Key</strong>. Since the key cannot be stored in the
            browser, please re-enter it to continue.
          </p>
          {publicKey && (
            <p className={styles.reconnectPubkey}>
              Public Key: <code>{publicKey}</code>
            </p>
          )}
          <form onSubmit={handleConnect}>
            <label className={styles.fieldLabel} htmlFor="reconnect-secret-key">
              Stellar Secret Key
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
                {connecting ? 'Connecting...' : 'Reconnect'}
              </button>
              <button
                type="button"
                className={styles.disconnectButton}
                onClick={disconnect}
              >
                Disconnect
              </button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>
          <Wallet size={24} />
          Wallet
        </h1>
      </div>

      {/* Balance Card */}
      <div className={styles.balanceCard}>
        <div className={styles.balanceSection}>
          <p className={styles.balanceTitle}>Available Balance</p>
          {balanceDisplay}
        </div>

        <div className={styles.publicKeySection}>
          <div className={styles.qrCode}>
            <QRCodeSVG value={publicKey} size={100} level="M" />
          </div>
          <div className={styles.addressSection}>
            <p className={styles.addressLabel}>Public Key</p>
            <div className={styles.addressRow}>
              <code className={styles.address}>
                {publicKey.slice(0, 8)}...{publicKey.slice(-8)}
              </code>
              <button
                className={styles.iconButton}
                onClick={handleCopyAddress}
                title={copied ? 'Copied!' : 'Copy address'}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <a
                href={`${STELLAR_EXPLORER}/account/${publicKey}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.iconButton}
                title="View on Stellar Explorer"
              >
                <ExternalLink size={16} />
              </a>
            </div>
            <span className={styles.connectionBadge}>
              Connected via {connectionMethodLabel}
            </span>
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.disconnectButton} onClick={disconnect}>
            Disconnect
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
              Failed to load transaction history: {txError}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default WalletPage

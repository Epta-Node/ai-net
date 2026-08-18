import { useState, useCallback } from 'react'
import { Keypair, TransactionBuilder, Operation, Asset, BASE_FEE, Networks, Memo, Horizon, Transaction } from '@stellar/stellar-sdk'
import { useWallet } from '../../context/WalletContext'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { signTransactionWithFreighter } from '../../services/freighter'
import styles from './SendXLMForm.module.css'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'

function isValidStellarAddress(address: string): boolean {
  try {
    Keypair.fromPublicKey(address)
    return true
  } catch {
    return false
  }
}

interface ConfirmationData {
  destination: string
  amount: string
  memo: string
}

export function SendXLMForm() {
  const { publicKey, keypair, connected, connectionMethod } = useWallet()
  const { balance } = useWalletBalance(publicKey)

  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [errors, setErrors] = useState<{ destination?: string; amount?: string }>({})
  const [confirmation, setConfirmation] = useState<ConfirmationData | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [successTx, setSuccessTx] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const validateField = useCallback(
    (field: 'destination' | 'amount'): string | undefined => {
      if (field === 'destination') {
        if (!destination.trim()) return 'Destination address is required'
        if (!isValidStellarAddress(destination.trim()))
          return 'Invalid Stellar address. Must start with G and be 56 characters.'
        return undefined
      }
      if (field === 'amount') {
        if (!amount.trim()) return 'Amount is required'
        const parsed = parseFloat(amount)
        if (isNaN(parsed) || parsed <= 0) return 'Amount must be a positive number'
        const availableBalance = parseFloat(balance)
        if (parsed > availableBalance) return 'Insufficient balance'
        return undefined
      }
      return undefined
    },
    [destination, amount, balance]
  )

  const handleDestinationBlur = () => {
    const err = validateField('destination')
    setErrors((prev) => ({ ...prev, destination: err }))
  }

  const handleAmountBlur = () => {
    const err = validateField('amount')
    setErrors((prev) => ({ ...prev, amount: err }))
  }

  const handleSendClick = () => {
    const destErr = validateField('destination')
    const amtErr = validateField('amount')
    const newErrors = { destination: destErr, amount: amtErr }
    setErrors(newErrors)

    if (!destErr && !amtErr) {
      setConfirmation({ destination: destination.trim(), amount: amount.trim(), memo: memo.trim() })
    }
  }

  const buildTransaction = async (): Promise<Transaction> => {
    const server = new Horizon.Server(HORIZON_URL)
    const account = await server.loadAccount(publicKey!)

    let txBuilder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: confirmation!.destination,
          asset: Asset.native(),
          amount: confirmation!.amount,
        })
      )

    if (confirmation!.memo) {
      const memoText = confirmation!.memo
      if (memoText.length <= 28) {
        txBuilder = txBuilder.addMemo(Memo.text(memoText))
      } else {
        txBuilder = txBuilder.addMemo(Memo.text(memoText.substring(0, 28)))
      }
    }

    return txBuilder.setTimeout(30).build()
  }

  const handleConfirm = async () => {
    if (!confirmation) return

    if (connectionMethod === 'freighter') {
      if (!publicKey) return
    } else {
      if (!keypair) return
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      const transaction = await buildTransaction()

      let signedXdr: string
      if (connectionMethod === 'freighter') {
        const signedResult = await signTransactionWithFreighter(
          transaction.toEnvelope().toXDR('base64'),
          publicKey!
        )
        signedXdr = signedResult
      } else {
        transaction.sign(keypair!)
        signedXdr = transaction.toEnvelope().toXDR('base64')
      }

      const submitRes = await fetch(`${HORIZON_URL}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tx: signedXdr }),
      })

      const submitData = await submitRes.json()

      if (!submitRes.ok) {
        throw new Error(submitData.extras?.result_codes?.transaction || 'Transaction submission failed')
      }

      const txHash = submitData.hash
      setSuccessTx(txHash)
      setDestination('')
      setAmount('')
      setMemo('')
      setConfirmation(null)
      setErrors({})
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send payment'
      setSubmitError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancelConfirm = () => {
    setConfirmation(null)
  }

  if (!connected) {
    return (
      <div className={styles.container}>
        <p className={styles.disconnected}>Connect your wallet to send XLM.</p>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <h3 className={styles.heading}>Send XLM</h3>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-destination">
          Destination address
        </label>
        <input
          id="send-destination"
          className={`${styles.input} ${errors.destination ? styles.inputError : ''}`}
          type="text"
          placeholder="GABCD...1234"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          onBlur={handleDestinationBlur}
          aria-invalid={Boolean(errors.destination)}
          aria-describedby="dest-error"
          disabled={Boolean(successTx)}
        />
        {errors.destination && (
          <p id="dest-error" className={styles.error} role="alert">
            {errors.destination}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-amount">
          Amount (XLM)
        </label>
        <input
          id="send-amount"
          className={`${styles.input} ${errors.amount ? styles.inputError : ''}`}
          type="number"
          step="0.0000001"
          min="0"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={handleAmountBlur}
          aria-invalid={Boolean(errors.amount)}
          aria-describedby="amount-error"
          disabled={Boolean(successTx)}
        />
        <p className={styles.helper}>
          Available balance: {parseFloat(balance).toFixed(7)} XLM
        </p>
        {errors.amount && (
          <p id="amount-error" className={styles.error} role="alert">
            {errors.amount}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-memo">
          Memo (optional)
        </label>
        <input
          id="send-memo"
          className={styles.input}
          type="text"
          placeholder="Payment memo (max 28 chars)"
          maxLength={28}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          disabled={Boolean(successTx)}
        />
      </div>

      <button
        className={styles.sendButton}
        onClick={handleSendClick}
        disabled={submitting || Boolean(successTx)}
      >
        {submitting ? 'Sending...' : 'Send'}
      </button>

      {submitError && (
        <p className={styles.error} role="alert" style={{ marginTop: 12 }}>
          {submitError}
        </p>
      )}

      {successTx && (
        <div className={styles.successMessage} role="status">
          <p>Payment sent successfully!</p>
          <p className={styles.txHash}>
            TX: <code>{successTx}</code>
          </p>
          <button
            className={styles.dismissButton}
            onClick={() => setSuccessTx(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmation && (
        <div className={styles.overlay} onClick={handleCancelConfirm}>
          <div
            className={styles.modal}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <h3 id="confirm-title" className={styles.modalTitle}>
              Confirm Payment
            </h3>
            <div className={styles.modalBody}>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>To:</span>
                <span className={styles.confirmValue}>{confirmation.destination}</span>
              </div>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>Amount:</span>
                <span className={styles.confirmValue}>{confirmation.amount} XLM</span>
              </div>
              {confirmation.memo && (
                <div className={styles.confirmRow}>
                  <span className={styles.confirmLabel}>Memo:</span>
                  <span className={styles.confirmValue}>{confirmation.memo}</span>
                </div>
              )}
            </div>
            <div className={styles.modalActions}>
              <button
                className={styles.cancelButton}
                onClick={handleCancelConfirm}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                className={styles.confirmButton}
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting
                  ? connectionMethod === 'freighter'
                    ? 'Signing with Freighter...'
                    : 'Signing & Sending...'
                  : 'Confirm & Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

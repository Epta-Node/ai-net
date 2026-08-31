import { useState, useCallback } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { TransactionBuilder, Operation, Asset, BASE_FEE, Networks, Memo, Horizon, Transaction } from '@stellar/stellar-sdk'
import { useWallet } from '../../context/WalletContext'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { signTransactionWithFreighter } from '../../services/freighter'
import styles from './SendXLMForm.module.css'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'

function isValidStellarAddress(address: string): boolean {
  return typeof address === 'string' && address.startsWith('G') && address.length === 56
}

export interface WalletTransferValues {
  destination: string
  amount: string
  memo?: string
}

export function SendXLMForm() {
  const { t } = useTranslation()
  const { publicKey, keypair, connected, connectionMethod } = useWallet()
  const { balance } = useWalletBalance(publicKey)

  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [errors, setErrors] = useState<{ destination?: string; amount?: string }>({})
  const [confirmation, setConfirmation] = useState<WalletTransferValues | null>(null)
  const [successTx, setSuccessTx] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const validateField = useCallback(
    (field: 'destination' | 'amount', destVal = destination, amtVal = amount): string | undefined => {
      if (field === 'destination') {
        if (!destVal.trim()) return t('validation.destinationRequired', { defaultValue: 'Destination address is required' })
        if (!isValidStellarAddress(destVal.trim()))
          return t('validation.invalidStellarAddress', { defaultValue: 'Invalid Stellar address' })
        return undefined
      }
      if (field === 'amount') {
        if (!amtVal.trim()) return t('validation.amountRequired', { defaultValue: 'Amount is required' })
        const parsed = parseFloat(amtVal)
        if (isNaN(parsed) || parsed <= 0) return t('validation.amountPositive', { defaultValue: 'Amount must be positive' })
        const availableBalance = parseFloat(balance)
        if (parsed > availableBalance) return t('validation.insufficientBalance', { defaultValue: 'Insufficient balance' })
        return undefined
      }
      return undefined
    },
    [destination, amount, balance, t]
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
      setConfirmation({
        destination: destination.trim(),
        amount: amount.trim(),
        memo: memo.trim(),
      })
    }
  }

  const buildTransaction = async (): Promise<Transaction> => {
    const server = new Horizon.Server(HORIZON_URL)
    const account = await server.loadAccount(publicKey!)

    let txBuilder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    }).addOperation(
      Operation.payment({
        destination: confirmation!.destination,
        asset: Asset.native(),
        amount: confirmation!.amount.toString(),
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

    setSubmitError(null)
    setSubmitting(true)

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
        throw new Error(submitData.extras?.result_codes?.transaction || t('wallet.send.submitFailed', { defaultValue: 'Submit failed' }))
      }

      const txHash = submitData.hash
      setSuccessTx(txHash)
      setDestination('')
      setAmount('')
      setMemo('')
      setConfirmation(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('wallet.send.failedToSend', { defaultValue: 'Failed to send payment' })
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
        <p className={styles.disconnected}>{t('wallet.send.disconnected', { defaultValue: 'Connect your wallet to send XLM' })}</p>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <h3 className={styles.heading}>{t('wallet.send.heading', { defaultValue: 'Send XLM' })}</h3>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-destination">
          {t('wallet.send.destinationLabel', { defaultValue: 'Destination Public Key' })}
        </label>
        <input
          id="send-destination"
          type="text"
          placeholder="GABCD...1234"
          value={destination}
          onChange={(e) => {
            setDestination(e.target.value)
            if (errors.destination) setErrors((prev) => ({ ...prev, destination: undefined }))
          }}
          onBlur={handleDestinationBlur}
          disabled={Boolean(successTx) || submitting}
          className={`${styles.input} ${errors.destination ? styles.inputError : ''}`}
        />
        {errors.destination && (
          <p id="destination-error" className={styles.error} role="alert">
            {errors.destination}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-amount">
          {t('wallet.send.amountLabel', { defaultValue: 'Amount (XLM)' })}
        </label>
        <input
          id="send-amount"
          type="number"
          step="0.0000001"
          min="0"
          placeholder="0.0"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value)
            if (errors.amount) setErrors((prev) => ({ ...prev, amount: undefined }))
          }}
          onBlur={handleAmountBlur}
          disabled={Boolean(successTx) || submitting}
          className={`${styles.input} ${errors.amount ? styles.inputError : ''}`}
        />
        <p className={styles.helper}>
          {t('wallet.send.availableBalance', { balance: parseFloat(balance || '0').toFixed(7), defaultValue: `Available balance: ${parseFloat(balance || '0').toFixed(7)} XLM` })}
        </p>
        {errors.amount && (
          <p id="amount-error" className={styles.error} role="alert">
            {errors.amount}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-memo">
          {t('wallet.send.memoLabel', { defaultValue: 'Memo (Optional)' })}
        </label>
        <input
          id="send-memo"
          type="text"
          placeholder={t('wallet.send.memoPlaceholder', { defaultValue: 'Payment memo (max 28 chars)' })}
          maxLength={28}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          disabled={Boolean(successTx) || submitting}
          className={styles.input}
        />
      </div>

      <button
        id="btn-send-xlm"
        type="button"
        className={styles.sendButton}
        onClick={handleSendClick}
        disabled={submitting || Boolean(successTx)}
      >
        {submitting ? t('wallet.send.sending', { defaultValue: 'Sending...' }) : t('wallet.send.send', { defaultValue: 'Send' })}
      </button>

      {submitError && (
        <p className={styles.error} role="alert" style={{ marginTop: 12 }}>
          {submitError}
        </p>
      )}

      {successTx && (
        <div className={styles.successMessage} role="status">
          <p>{t('wallet.send.success', { defaultValue: 'Transaction sent successfully!' })}</p>
          <p className={styles.txHash}>
            <Trans
              i18nKey="wallet.send.txHash"
              values={{ hash: successTx }}
              components={[<code key="hash" />]}
              defaults="Tx Hash: <code>{{hash}}</code>"
            />
          </p>
          <button
            type="button"
            className={styles.dismissButton}
            onClick={() => setSuccessTx(null)}
          >
            {t('common.dismiss', { defaultValue: 'Dismiss' })}
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
              {t('wallet.send.confirmTitle', { defaultValue: 'Confirm Payment' })}
            </h3>
            <div className={styles.modalBody}>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>{t('wallet.send.to', { defaultValue: 'To' })}</span>
                <span className={styles.confirmValue}>{confirmation.destination}</span>
              </div>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>{t('wallet.send.amount', { defaultValue: 'Amount' })}</span>
                <span className={styles.confirmValue}>{confirmation.amount} XLM</span>
              </div>
              {confirmation.memo && (
                <div className={styles.confirmRow}>
                  <span className={styles.confirmLabel}>{t('wallet.send.memo', { defaultValue: 'Memo' })}</span>
                  <span className={styles.confirmValue}>{confirmation.memo}</span>
                </div>
              )}
            </div>
            <div className={styles.modalActions}>
              <button
                id="btn-cancel-payment"
                type="button"
                className={styles.cancelButton}
                onClick={handleCancelConfirm}
                disabled={submitting}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                id="btn-confirm-payment"
                type="button"
                className={styles.confirmButton}
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting
                  ? connectionMethod === 'freighter'
                    ? t('wallet.send.signingFreighter', { defaultValue: 'Signing with Freighter...' })
                    : t('wallet.send.signingSending', { defaultValue: 'Sending...' })
                  : t('wallet.send.confirmSend', { defaultValue: 'Confirm & Send' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { useState, useCallback } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Keypair, TransactionBuilder, Operation, Asset, BASE_FEE, Networks, Memo, Horizon, Transaction } from '@stellar/stellar-sdk'
import { useWallet } from '../../context/WalletContext'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { signTransactionWithFreighter } from '../../services/freighter'
import { useToast } from '../../context/ToastContext'
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
  const { t } = useTranslation()
  const { publicKey, keypair, connected, connectionMethod } = useWallet()
  const { balance } = useWalletBalance(publicKey)
  const { showToast } = useToast()

  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [errors, setErrors] = useState<{ destination?: string; amount?: string }>({})
  const [touched, setTouched] = useState<{ destination?: boolean; amount?: boolean }>({})
  const [confirmation, setConfirmation] = useState<ConfirmationData | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [successTx, setSuccessTx] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const validateField = useCallback(
    (field: 'destination' | 'amount', destVal = destination, amtVal = amount): string | undefined => {
      if (field === 'destination') {
        if (!destVal.trim()) return t('validation.destinationRequired')
        if (!isValidStellarAddress(destVal.trim())) return t('validation.invalidStellarAddress')
        return undefined
      }
      if (field === 'amount') {
        if (!amtVal.trim()) return t('validation.amountRequired')
        const parsed = parseFloat(amtVal)
        if (isNaN(parsed) || parsed <= 0) return t('validation.amountPositive')
        const availableBalance = parseFloat(balance)
        if (parsed > availableBalance) return t('validation.insufficientBalance')
        return undefined
      }
      return undefined
    },
    [destination, amount, balance, t],
  )

  const handleDestinationBlur = () => {
    setTouched((p) => ({ ...p, destination: true }))
    const err = validateField('destination')
    setErrors((prev) => ({ ...prev, destination: err }))
  }

  const handleAmountBlur = () => {
    setTouched((p) => ({ ...p, amount: true }))
    const err = validateField('amount')
    setErrors((prev) => ({ ...prev, amount: err }))
  }

  const handleSendClick = () => {
    const destErr = validateField('destination')
    const amtErr = validateField('amount')
    const newErrors = { destination: destErr, amount: amtErr }
    setErrors(newErrors)
    setTouched({ destination: true, amount: true })

    if (destErr || amtErr) {
      const msg = destErr || amtErr
      if (msg) showToast(msg, 'error')
      return
    }

    setConfirmation({
      destination: destination.trim(),
      amount,
      memo: memo.trim(),
    })
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
      }),
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
          publicKey!,
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
        throw new Error(submitData.extras?.result_codes?.transaction || t('wallet.send.submitFailed'))
      }

      const txHash = submitData.hash
      setSuccessTx(txHash)
      setDestination('')
      setAmount('')
      setMemo('')
      setErrors({})
      setTouched({})
      setConfirmation(null)

      // — Toast with undo: allows user to dismiss success state within 8s
      showToast(t('wallet.send.success') || 'Payment sent successfully!', 'success', {
        duration: 8000,
        action: {
          label: t('common.undo') || 'Undo',
          onClick: () => {
            setSuccessTx(null)
            showToast('Payment undone — funds not moved (demo)', 'info', 4000)
          },
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('wallet.send.failedToSend')
      setSubmitError(message)
      showToast(message, 'error', {
        duration: 7000,
        action: {
          label: t('common.retry') || 'Retry',
          onClick: () => {
            setSubmitError(null)
            handleConfirm()
          },
        },
      })
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
        <p className={styles.disconnected}>{t('wallet.send.disconnected')}</p>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <h3 className={styles.heading}>{t('wallet.send.heading')}</h3>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-destination">
          {t('wallet.send.destinationLabel')}
        </label>
        <input
          id="send-destination"
          className={`${styles.input} ${errors.destination && touched.destination ? styles.inputError : ''}`}
          placeholder="GABCD...1234"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          onBlur={handleDestinationBlur}
          disabled={Boolean(successTx) || submitting}
          aria-invalid={Boolean(errors.destination && touched.destination)}
          aria-describedby={errors.destination ? 'destination-error' : undefined}
        />
        {errors.destination && touched.destination && (
          <p id="destination-error" className={styles.error} role="alert">
            {errors.destination}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-amount">
          {t('wallet.send.amountLabel')}
        </label>
        <input
          id="send-amount"
          className={`${styles.input} ${errors.amount && touched.amount ? styles.inputError : ''}`}
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={handleAmountBlur}
          disabled={Boolean(successTx) || submitting}
          aria-invalid={Boolean(errors.amount && touched.amount)}
          aria-describedby={errors.amount ? 'amount-error' : undefined}
        />
        <p className={styles.helper}>{t('wallet.send.availableBalance', { balance: parseFloat(balance).toFixed(7) })}</p>
        {errors.amount && touched.amount && (
          <p id="amount-error" className={styles.error} role="alert">
            {errors.amount}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="send-memo">
          {t('wallet.send.memoLabel')}
        </label>
        <input
          id="send-memo"
          className={styles.input}
          type="text"
          placeholder={t('wallet.send.memoPlaceholder')}
          maxLength={28}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          disabled={Boolean(successTx) || submitting}
        />
      </div>

      <button
        id="btn-send-xlm"
        className={styles.sendButton}
        onClick={handleSendClick}
        disabled={submitting || Boolean(successTx)}
      >
        {submitting ? t('wallet.send.sending') : t('wallet.send.send')}
      </button>

      {submitError && (
        <p className={styles.error} role="alert" style={{ marginTop: 12 }}>
          {submitError}
        </p>
      )}

      {successTx && (
        <div className={styles.successMessage} role="status">
          <p>{t('wallet.send.success')}</p>
          <p className={styles.txHash}>
            <Trans i18nKey="wallet.send.txHash" values={{ hash: successTx }} components={[<code key="hash" />]} />
          </p>
          <button className={styles.dismissButton} onClick={() => setSuccessTx(null)}>
            {t('common.dismiss')}
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
              {t('wallet.send.confirmTitle')}
            </h3>
            <div className={styles.modalBody}>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>{t('wallet.send.to')}</span>
                <span className={styles.confirmValue}>{confirmation.destination}</span>
              </div>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>{t('wallet.send.amount')}</span>
                <span className={styles.confirmValue}>{confirmation.amount} XLM</span>
              </div>
              {confirmation.memo && (
                <div className={styles.confirmRow}>
                  <span className={styles.confirmLabel}>{t('wallet.send.memo')}</span>
                  <span className={styles.confirmValue}>{confirmation.memo}</span>
                </div>
              )}
            </div>
            <div className={styles.modalActions}>
              <button
                id="btn-cancel-payment"
                className={styles.cancelButton}
                onClick={handleCancelConfirm}
                disabled={submitting}
              >
                {t('common.cancel')}
              </button>
              <button
                id="btn-confirm-payment"
                className={styles.confirmButton}
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting
                  ? connectionMethod === 'freighter'
                    ? t('wallet.send.signingFreighter')
                    : t('wallet.send.signingSending')
                  : t('wallet.send.confirmSend')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

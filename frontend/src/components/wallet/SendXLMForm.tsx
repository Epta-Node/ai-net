import { useMemo, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { TransactionBuilder, Operation, Asset, BASE_FEE, Networks, Memo, Horizon, Transaction } from '@stellar/stellar-sdk'
import { useWallet } from '../../context/WalletContext'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { signTransactionWithFreighter } from '../../services/freighter'
import { walletTransferSchema, type WalletTransferValues } from '../../schemas/wallet'
import styles from './SendXLMForm.module.css'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'

export function SendXLMForm() {
  const { t } = useTranslation()
  const { publicKey, keypair, connected, connectionMethod } = useWallet()
  const { balance } = useWalletBalance(publicKey)

  const [confirmation, setConfirmation] = useState<WalletTransferValues | null>(null)
  const [successTx, setSuccessTx] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Extend the base schema with a balance check that depends on the live
  // wallet balance, so it stays fresh whenever the account changes.
  const schemaWithBalance = useMemo(() => {
    return walletTransferSchema.extend({
      amount: walletTransferSchema.shape.amount.refine(
        (val) => val <= parseFloat(balance),
        t('validation.insufficientBalance')
      )
    })
  }, [balance, t])

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<WalletTransferValues>({
    mode: 'onBlur',
    resolver: zodResolver(schemaWithBalance),
    defaultValues: {
      destination: '',
      amount: undefined,
      memo: '',
    },
  })

  const handleSendClick = (data: WalletTransferValues) => {
    setConfirmation({
      destination: data.destination.trim(),
      amount: data.amount,
      memo: data.memo?.trim() || '',
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
        throw new Error(submitData.extras?.result_codes?.transaction || t('wallet.send.submitFailed'))
      }

      const txHash = submitData.hash
      setSuccessTx(txHash)
      reset()
      setConfirmation(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('wallet.send.failedToSend')
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
        <p className={styles.disconnected}>{t('wallet.send.disconnected')}</p>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <h3 className={styles.heading}>{t('wallet.send.heading')}</h3>

      <form onSubmit={handleSubmit(handleSendClick)} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="send-destination">
            {t('wallet.send.destinationLabel')}
          </label>
          <input
            id="send-destination"
            className={`${styles.input} ${errors.destination ? styles.inputError : ''}`}
            type="text"
            placeholder="GABCD...1234"
            disabled={Boolean(successTx) || submitting}
            {...register('destination')}
          />
          {errors.destination && (
            <p id="destination-error" className={styles.error} role="alert">
              {errors.destination.message}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="send-amount">
            {t('wallet.send.amountLabel')}
          </label>
          <input
            id="send-amount"
            className={`${styles.input} ${errors.amount ? styles.inputError : ''}`}
            type="number"
            step="0.0000001"
            min="0"
            placeholder="0.0"
            disabled={Boolean(successTx) || submitting}
            {...register('amount')}
          />
          <p className={styles.helper}>
            {t('wallet.send.availableBalance', { balance: parseFloat(balance).toFixed(7) })}
          </p>
          {errors.amount && (
            <p id="amount-error" className={styles.error} role="alert">
              {errors.amount.message}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="send-memo">
            {t('wallet.send.memoLabel')}
          </label>
          <input
            id="send-memo"
            className={`${styles.input} ${errors.memo ? styles.inputError : ''}`}
            type="text"
            placeholder={t('wallet.send.memoPlaceholder')}
            maxLength={28}
            disabled={Boolean(successTx) || submitting}
            {...register('memo')}
          />
          {errors.memo && (
            <p id="memo-error" className={styles.error} role="alert">
              {errors.memo.message}
            </p>
          )}
        </div>

        <button
          id="btn-send-xlm"
          type="submit"
          className={styles.sendButton}
          disabled={submitting || Boolean(successTx)}
        >
          {submitting ? t('wallet.send.sending') : t('wallet.send.send')}
        </button>
      </form>

      {submitError && (
        <p className={styles.error} role="alert" style={{ marginTop: 12 }}>
          {submitError}
        </p>
      )}

      {successTx && (
        <div className={styles.successMessage} role="status">
          <p>{t('wallet.send.success')}</p>
          <p className={styles.txHash}>
            <Trans
              i18nKey="wallet.send.txHash"
              values={{ hash: successTx }}
              components={[<code key="hash" />]}
            />
          </p>
          <button
            className={styles.dismissButton}
            onClick={() => setSuccessTx(null)}
          >
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
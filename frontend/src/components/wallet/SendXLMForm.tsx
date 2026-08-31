import { useState, useCallback } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useForm } from 'react-hook-form'
import type { Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { TransactionBuilder, Operation, Asset, BASE_FEE, Networks, Memo, Horizon, Transaction } from '@stellar/stellar-sdk'
import { useWallet } from '../../context/WalletContext'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { signTransactionWithFreighter } from '../../services/freighter'
import { walletTransferSchema, type WalletTransferValues } from '../../schemas/wallet'
import { FormField } from '../common/FormField'
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

  /**
   * The zod schema validates shape; the available balance is runtime state it
   * cannot see, so the insufficient-funds check is layered on after it. Doing
   * it here rather than inside the schema keeps the schema reusable and the
   * error attached to the `amount` field where the user is looking.
   */
  const resolver = useCallback<Resolver<WalletTransferValues>>(
    async (values, context, options) => {
      const result = await zodResolver(walletTransferSchema)(values, context, options)

      const amount = Number(values.amount)
      const available = parseFloat(balance)
      const hasSchemaAmountError = 'amount' in result.errors
      if (!hasSchemaAmountError && Number.isFinite(amount) && amount > available) {
        return {
          values: {},
          errors: {
            ...result.errors,
            amount: { type: 'insufficientBalance', message: t('validation.insufficientBalance') },
          },
        }
      }

      return result
    },
    [balance, t],
  )

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, touchedFields },
  } = useForm<WalletTransferValues>({
    resolver,
    mode: 'onBlur',
    defaultValues: { destination: '', amount: 0, memo: '' },
  })

  const handleSendClick = (data: WalletTransferValues) => {
    setConfirmation({
      destination: data.destination.trim(),
      amount: data.amount,
      memo: data.memo?.trim() || '',
    })
  }

  const handleCancelConfirm = () => {
    setConfirmation(null)
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
      txBuilder = txBuilder.addMemo(Memo.text(memoText.substring(0, 28)))
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
        signedXdr = await signTransactionWithFreighter(
          transaction.toEnvelope().toXDR('base64'),
          publicKey!
        )
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

      setSuccessTx(submitData.hash)
      reset()
      setConfirmation(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('wallet.send.failedToSend')
      setSubmitError(message)
    } finally {
      setSubmitting(false)
    }
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
        <FormField
          id="send-destination"
          label={t('wallet.send.destinationLabel')}
          placeholder="GABCD...1234"
          error={errors.destination?.message}
          isTouched={touchedFields.destination}
          disabled={Boolean(successTx) || submitting}
          className={styles.field}
          {...register('destination')}
        />

        <FormField
          id="send-amount"
          label={t('wallet.send.amountLabel')}
          type="number"
          step="0.0000001"
          min="0"
          placeholder="0.0"
          error={errors.amount?.message}
          isTouched={touchedFields.amount}
          helperText={t('wallet.send.availableBalance', {
            balance: parseFloat(balance).toFixed(7),
          })}
          disabled={Boolean(successTx) || submitting}
          className={styles.field}
          {...register('amount')}
        />

        <FormField
          id="send-memo"
          label={t('wallet.send.memoLabel')}
          type="text"
          placeholder={t('wallet.send.memoPlaceholder')}
          maxLength={28}
          error={errors.memo?.message}
          isTouched={touchedFields.memo}
          disabled={Boolean(successTx) || submitting}
          className={styles.field}
          {...register('memo')}
        />

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

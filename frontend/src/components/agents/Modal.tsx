import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useFocusTrap } from '../../hooks/useFocusTrap'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  'data-testid'?: string
}

/**
 * Small shared dialog shell used by AgentDetailModal. Traps Tab focus, closes
 * on Escape/backdrop, and restores focus to the invoking element on close.
 */
export function Modal({ open, onClose, title, children, 'data-testid': dataTestId }: ModalProps) {
  const { t } = useTranslation()
  const dialogRef = useFocusTrap<HTMLDivElement>(open)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      data-testid={dataTestId ? `${dataTestId}-backdrop` : undefined}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--space-4, 16px)',
        background: 'var(--surface-scrim, rgba(0, 0, 0, 0.6))',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={dataTestId}
        style={{
          width: 'min(680px, 100%)',
          maxHeight: 'calc(100vh - 2rem)',
          overflowY: 'auto',
          position: 'relative',
          padding: 'var(--space-5, 24px)',
          background: 'var(--surface-elevated, var(--surface-sunken, #141414))',
          color: 'var(--text-primary, #fff)',
          border: '1px solid var(--border-primary, var(--border-subtle, #262626))',
          borderRadius: 'var(--radius-lg, 12px)',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          style={{
            position: 'absolute',
            top: 'var(--space-3, 12px)',
            right: 'var(--space-3, 12px)',
            width: 32,
            height: 32,
            background: 'var(--surface-sunken-hover, rgba(255, 255, 255, 0.05))',
            color: 'var(--text-secondary, #a3a3a3)',
            border: '1px solid var(--border-subtle, #262626)',
            borderRadius: 'var(--radius-md, 8px)',
            cursor: 'pointer',
          }}
        >
          ×
        </button>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export default Modal

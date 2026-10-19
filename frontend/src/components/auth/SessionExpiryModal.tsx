import React, { useEffect, useRef, useState } from 'react'
import { SessionTimer } from '../../services/walletSession'
import { useFocusTrap } from '../../hooks/useFocusTrap'

interface SessionExpiryModalProps {
  timer: SessionTimer
  onRenew: () => void
  onSignOut: () => void
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Warning modal shown 2 minutes before the wallet session expires (#828).
 *
 * Renders a countdown timer that updates every second. "Stay signed in" calls
 * `timer.extendSession()` via `onRenew`; "Sign out" calls `onSignOut`.
 * If the user ignores the modal, `timer` fires its own expiry callback.
 */
export const SessionExpiryModal: React.FC<SessionExpiryModalProps> = ({
  timer,
  onRenew,
  onSignOut,
}) => {
  const [timeLeftMs, setTimeLeftMs] = useState(() => timer.getTimeUntilExpiry())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useFocusTrap(dialogRef)

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setTimeLeftMs(timer.getTimeUntilExpiry())
    }, 1_000)
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current)
    }
  }, [timer])

  const handleRenew = () => {
    timer.extendSession()
    onRenew()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-expiry-title"
      aria-describedby="session-expiry-desc"
      ref={dialogRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
      }}
    >
      <div
        style={{
          background: 'var(--color-surface, #1e1e2e)',
          border: '1px solid var(--color-border, #313244)',
          borderRadius: 12,
          padding: '32px 28px',
          maxWidth: 400,
          width: '90vw',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          color: 'var(--color-text, #cdd6f4)',
        }}
      >
        <h2
          id="session-expiry-title"
          style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}
        >
          Session expiring soon
        </h2>

        <p id="session-expiry-desc" style={{ margin: 0, lineHeight: 1.6 }}>
          Your session expires in{' '}
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatCountdown(timeLeftMs)}
          </strong>{' '}
          — stay signed in?
        </p>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button
            onClick={onSignOut}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid var(--color-border, #313244)',
              background: 'transparent',
              color: 'var(--color-text-muted, #a6adc8)',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Sign out
          </button>
          <button
            onClick={handleRenew}
            autoFocus
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--color-accent, #89b4fa)',
              color: 'var(--color-accent-fg, #1e1e2e)',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.875rem',
            }}
          >
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  )
}

export default SessionExpiryModal

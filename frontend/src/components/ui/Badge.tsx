import { forwardRef, type ComponentPropsWithoutRef } from 'react';

export type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  variant?: BadgeVariant;
  /** When set, renders a dismiss button that calls this handler. */
  onDismiss?: () => void;
  dismissLabel?: string;
}

const VARIANT_STYLE: Record<BadgeVariant, { background: string; color: string; border: string }> = {
  success: { background: 'var(--status-success-surface)', color: 'var(--status-success-text)', border: 'var(--status-success-border)' },
  warning: { background: 'var(--status-warning-surface)', color: 'var(--status-warning-text)', border: 'var(--status-warning-border)' },
  error: { background: 'var(--status-danger-surface)', color: 'var(--status-danger-text)', border: 'var(--status-danger-border)' },
  info: { background: 'var(--info-surface)', color: 'var(--accent-info)', border: 'var(--info-border)' },
  neutral: { background: 'var(--surface-muted)', color: 'var(--text-secondary)', border: 'var(--border-subtle)' },
};

/** Status badge (#819). */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = 'neutral', onDismiss, dismissLabel = 'Dismiss', children, style, ...rest },
  ref,
) {
  const v = VARIANT_STYLE[variant];
  return (
    <span
      ref={ref}
      data-variant={variant}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '0 var(--space-2)',
        borderRadius: 999,
        background: v.background,
        color: v.color,
        border: `1px solid ${v.border}`,
        ...style,
      }}
      {...rest}
    >
      {children}
      {onDismiss && (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}
        >
          ×
        </button>
      )}
    </span>
  );
});

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and shows a spinner, so a pending action can't be submitted twice. */
  loading?: boolean;
}

const VARIANT_STYLE: Record<ButtonVariant, { background: string; color: string; border: string }> = {
  primary: { background: 'var(--accent)', color: 'var(--text-inverse)', border: 'var(--accent)' },
  secondary: { background: 'var(--surface-secondary)', color: 'var(--text-primary)', border: 'var(--border-primary)' },
  ghost: { background: 'transparent', color: 'var(--text-primary)', border: 'transparent' },
  danger: { background: 'var(--status-danger)', color: 'var(--text-inverse)', border: 'var(--status-danger)' },
};

const SIZE_PADDING: Record<ButtonSize, string> = {
  sm: 'var(--space-1) var(--space-2)',
  md: 'var(--space-2) var(--space-4)',
  lg: 'var(--space-3) var(--space-5)',
};

/** Shared button primitive (#819). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, type = 'button', children, style, ...rest },
  ref,
) {
  const v = VARIANT_STYLE[variant];
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-size={size}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: SIZE_PADDING[size],
        background: v.background,
        color: v.color,
        border: `1px solid ${v.border}`,
        borderRadius: 6,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.7 : 1,
        ...style,
      }}
      {...rest}
    >
      {loading && <Spinner size="sm" label="Loading" />}
      {children}
    </button>
  );
});

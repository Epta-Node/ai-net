import { forwardRef, type ComponentPropsWithoutRef } from 'react';

export type SpinnerSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<SpinnerSize, number> = { sm: 14, md: 20, lg: 32 };

export interface SpinnerProps extends ComponentPropsWithoutRef<'span'> {
  size?: SpinnerSize;
  /** Accessible label; announced via role="status". */
  label?: string;
}

/** Loading indicator that inherits the parent's text colour (#819). */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size = 'md', label = 'Loading', style, ...rest },
  ref,
) {
  const px = SIZE_PX[size];
  return (
    <span
      ref={ref}
      role="status"
      aria-label={label}
      data-size={size}
      style={{
        display: 'inline-block',
        width: px,
        height: px,
        border: '2px solid currentColor',
        borderRightColor: 'transparent',
        borderRadius: '50%',
        animation: 'ui-spin 0.75s linear infinite',
        ...style,
      }}
      {...rest}
    />
  );
});

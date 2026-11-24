import React from 'react';
import { AlertCircle } from 'lucide-react';

interface FormFieldProps extends React.InputHTMLAttributes<HTMLInputElement | HTMLTextAreaElement> {
  label: string;
  error?: string;
  isTouched?: boolean;
  as?: 'input' | 'textarea';
  helperText?: React.ReactNode;
}

export const FormField = React.forwardRef<HTMLInputElement | HTMLTextAreaElement, FormFieldProps>(
  ({ label, error, isTouched, as = 'input', helperText, className = '', id, ...props }, ref) => {
    const Component = as as any;
    const isInvalid = isTouched && !!error;
    const isValid = isTouched && !error;
    
    const fieldId = id || props.name;
    const errorId = `${fieldId}-error`;

    let borderColor = 'var(--border-color)';
    if (isInvalid) {
      borderColor = 'var(--status-danger-strong)'; // Red for invalid
    } else if (isValid) {
      borderColor = 'var(--status-success-strong)'; // Green for valid
    }

    return (
      <div style={{ marginBottom: 'var(--space-5)' }} className={className}>
        <label htmlFor={fieldId} style={{ display: 'block', marginBottom: 'var(--space-2)', fontWeight: 600 }}>
          {label}
        </label>
        
        <Component
          id={fieldId}
          ref={ref}
          aria-invalid={isInvalid}
          aria-describedby={error ? errorId : undefined}
          style={{
            width: '100%',
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-xl)',
            border: `1px solid ${borderColor}`,
            outline: 'none',
            ...props.style,
          }}
          {...props}
        />
        
        {helperText && !isInvalid && (
          <p style={{ marginTop: 'var(--space-2)', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            {helperText}
          </p>
        )}

        <div aria-live="polite" id={errorId}>
          {isInvalid && (
            <p style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--status-danger-strong)', marginTop: 'var(--space-2)', fontSize: '0.875rem' }}>
              <AlertCircle size={16} />
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }
);

FormField.displayName = 'FormField';

import { Component, ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  errorCode: string | null;
}

/**
 * The fallback is a separate function component so the class boundary can use
 * translations through the normal `useTranslation` hook.
 */
function ErrorFallback({ errorCode }: { errorCode: string | null }) {
  const { t } = useTranslation();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '400px',
      padding: '40px',
      textAlign: 'center',
      background: 'var(--panel-bg, rgba(30, 41, 59, 0.7))',
      backdropFilter: 'blur(12px)',
      border: '1px solid var(--panel-border, rgba(255, 255, 255, 0.08))',
      borderRadius: '16px',
      margin: '40px auto',
      maxWidth: '600px',
      boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
    }}>
      <h2 style={{ color: 'var(--danger, #ef4444)', marginBottom: '16px', fontSize: '1.8rem' }}>
        {t('error.title')}
      </h2>
      <p style={{ color: 'var(--text-secondary, #94a3b8)', marginBottom: '24px' }}>
        {t('error.description')}
      </p>
      <div style={{
        background: 'rgba(0, 0, 0, 0.2)',
        padding: '12px 24px',
        borderRadius: '8px',
        fontFamily: 'monospace',
        fontSize: '1.1rem',
        color: '#f8fafc',
        border: '1px dashed rgba(255, 255, 255, 0.1)',
        marginBottom: '24px'
      }}>
        {t('error.code')} <span id="error-code">{errorCode}</span>
      </div>
      <button
        onClick={() => window.location.reload()}
        style={{
          padding: '10px 20px',
          background: 'var(--primary, #6366f1)',
          color: '#ffffff',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
          fontWeight: 600
        }}
      >
        {t('error.reload')}
      </button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorCode: null,
  };

  public static getDerivedStateFromError(_error: Error): State {
    // Generate a structured error code based on random hex
    const errorCode = `ERR-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    return { hasError: true, errorCode };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return <ErrorFallback errorCode={this.state.errorCode} />;
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

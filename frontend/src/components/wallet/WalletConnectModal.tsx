import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useWallet } from '../../context/WalletContext';
import { rememberConnectMethod, validateWalletKey, type WalletConnectMethod } from './walletConnect';

const FREIGHTER_INSTALL_URL = 'https://www.freighter.app/';

export interface WalletConnectModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with a public key when the user chooses to explore read-only. */
  onReadOnly?: (publicKey: string) => void;
}

/**
 * Guided wallet connection (#817): Freighter, a testnet secret key, or a
 * read-only public key. Traps focus, closes on Esc or backdrop click, and
 * returns focus to the trigger on close (via useFocusTrap).
 */
export function WalletConnectModal({ open, onClose, onReadOnly }: WalletConnectModalProps) {
  const { connectFreighter, connectSecretKey, freighterAvailable, connecting, error: walletError } = useWallet();
  const ref = useFocusTrap<HTMLDivElement>(open);
  const [method, setMethod] = useState<WalletConnectMethod | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [testnetAck, setTestnetAck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setMethod(null);
      setKeyInput('');
      setTestnetAck(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const finish = (chosen: WalletConnectMethod) => {
    rememberConnectMethod(chosen);
    onClose();
  };

  const submitFreighter = async () => {
    try {
      await connectFreighter();
      finish('freighter');
    } catch {
      /* WalletContext exposes the error */
    }
  };

  const submitSecret = async () => {
    const result = validateWalletKey('secret', keyInput);
    if (!result.ok) return setError(result.error);
    if (!testnetAck) return setError('Confirm you understand this is for testnet only.');
    setError(null);
    try {
      await connectSecretKey(result.value);
      finish('secret-key');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect with this key.');
    }
  };

  const submitReadOnly = () => {
    const result = validateWalletKey('public', keyInput);
    if (!result.ok) return setError(result.error);
    onReadOnly?.(result.value);
    finish('read-only');
  };

  return createPortal(
    <div
      data-testid="wallet-connect-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'var(--surface-scrim)', display: 'grid', placeItems: 'center' }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-connect-title"
        style={{
          width: 'min(440px, calc(100vw - 32px))',
          padding: 'var(--space-5)',
          background: 'var(--surface-elevated)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-primary)',
          borderRadius: 12,
        }}
      >
        <h2 id="wallet-connect-title">Connect a wallet</h2>

        {method === null && (
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <button type="button" onClick={() => setMethod('freighter')}>Freighter extension</button>
            <button type="button" onClick={() => setMethod('secret-key')}>Secret key (testnet)</button>
            <button type="button" onClick={() => setMethod('read-only')}>Read-only (explore without connecting)</button>
          </div>
        )}

        {method === 'freighter' &&
          (freighterAvailable ? (
            <div>
              <p>Approve the connection request in Freighter.</p>
              <button type="button" onClick={submitFreighter} disabled={connecting}>
                {connecting ? 'Waiting for Freighter…' : 'Connect Freighter'}
              </button>
              {walletError && <p role="alert">{walletError}</p>}
            </div>
          ) : (
            <div>
              <p>Freighter isn&apos;t installed in this browser.</p>
              <a href={FREIGHTER_INSTALL_URL} target="_blank" rel="noreferrer">
                Install Freighter
              </a>
            </div>
          ))}

        {(method === 'secret-key' || method === 'read-only') && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (method === 'secret-key' ? submitSecret() : submitReadOnly());
            }}
          >
            <label htmlFor="wallet-connect-key">
              {method === 'secret-key' ? 'Secret key' : 'Public key'}
            </label>
            {method === 'secret-key' ? (
              <textarea
                id="wallet-connect-key"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? 'wallet-connect-error' : undefined}
              />
            ) : (
              <input
                id="wallet-connect-key"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? 'wallet-connect-error' : undefined}
              />
            )}
            {method === 'secret-key' && (
              <label>
                <input type="checkbox" checked={testnetAck} onChange={(e) => setTestnetAck(e.target.checked)} />
                I understand this is testnet only
              </label>
            )}
            {error && (
              <p id="wallet-connect-error" role="alert" style={{ color: 'var(--status-danger-text)' }}>
                {error}
              </p>
            )}
            <button type="submit" disabled={connecting}>
              {method === 'secret-key' ? 'Connect' : 'View (read-only)'}
            </button>
          </form>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-4)' }}>
          {method !== null && (
            <button type="button" onClick={() => { setMethod(null); setError(null); setKeyInput(''); }}>
              Back
            </button>
          )}
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default WalletConnectModal;

import { StrKey } from '@stellar/stellar-sdk';

/** Connection paths offered by WalletConnectModal (#817). */
export type WalletConnectMethod = 'freighter' | 'secret-key' | 'read-only';

const SESSION_KEY = 'wallet_connect_method';

export type KeyValidation = { ok: true; value: string } | { ok: false; error: string };

/** Validates a secret key (S…) or a public key (G…), with a hint for common mistakes. */
export function validateWalletKey(kind: 'secret' | 'public', raw: string): KeyValidation {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'Enter a key to continue.' };
  if (kind === 'secret') {
    if (value.startsWith('G')) {
      return { ok: false, error: 'That looks like a public key (starts with G). Secret keys start with S.' };
    }
    if (!StrKey.isValidEd25519SecretSeed(value)) {
      return { ok: false, error: 'Invalid secret key. Check for missing characters or extra spaces (56 characters, starts with S).' };
    }
    return { ok: true, value };
  }
  if (value.startsWith('S')) {
    return { ok: false, error: 'That is a secret key — never share it. Enter a public key (starts with G).' };
  }
  if (!StrKey.isValidEd25519PublicKey(value)) {
    return { ok: false, error: 'Invalid public key (56 characters, starts with G).' };
  }
  return { ok: true, value };
}

/**
 * Remembers the chosen method for this tab only: sessionStorage survives a
 * refresh but not a new tab, matching the issue's session-resume rule.
 */
export function rememberConnectMethod(method: WalletConnectMethod, storage: Storage | undefined = safeSession()): void {
  try {
    storage?.setItem(SESSION_KEY, method);
  } catch {
    /* storage unavailable */
  }
}

export function readConnectMethod(storage: Storage | undefined = safeSession()): WalletConnectMethod | null {
  try {
    const value = storage?.getItem(SESSION_KEY);
    return value === 'freighter' || value === 'secret-key' || value === 'read-only' ? value : null;
  } catch {
    return null;
  }
}

function safeSession(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

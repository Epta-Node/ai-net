import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { readConnectMethod, rememberConnectMethod, validateWalletKey } from './walletConnect';

describe('wallet connect validation (#817)', () => {
  const kp = Keypair.random();

  it('accepts valid secret and public keys', () => {
    expect(validateWalletKey('secret', ` ${kp.secret()} `)).toEqual({ ok: true, value: kp.secret() });
    expect(validateWalletKey('public', kp.publicKey())).toEqual({ ok: true, value: kp.publicKey() });
  });

  it('gives a common-mistake hint for swapped keys', () => {
    const swappedSecret = validateWalletKey('secret', kp.publicKey());
    expect(swappedSecret.ok).toBe(false);
    if (!swappedSecret.ok) expect(swappedSecret.error).toMatch(/public key/);

    const swappedPublic = validateWalletKey('public', kp.secret());
    expect(swappedPublic.ok).toBe(false);
    if (!swappedPublic.ok) expect(swappedPublic.error).toMatch(/secret key/);
  });

  it('rejects empty and malformed keys', () => {
    expect(validateWalletKey('secret', '   ').ok).toBe(false);
    expect(validateWalletKey('secret', 'SABC').ok).toBe(false);
    expect(validateWalletKey('public', 'GABC').ok).toBe(false);
  });

  it('remembers the method in session storage only', () => {
    sessionStorage.clear();
    expect(readConnectMethod()).toBeNull();
    rememberConnectMethod('read-only');
    expect(readConnectMethod()).toBe('read-only');
    expect(localStorage.getItem('wallet_connect_method')).toBeNull();
  });
});

import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useWallet } from './useWallet';

const state = vi.hoisted(() => ({
  publicKey: 'GCONNECTED' as string | null,
  connected: true,
  connecting: false,
}));

vi.mock('../context/WalletContext', () => ({
  useWallet: () => ({
    publicKey: state.publicKey,
    keypair: null,
    connected: state.connected,
    connecting: state.connecting,
    ready: state.connected,
    network: 'TESTNET',
    expectedNetwork: 'TESTNET',
    networkMismatch: false,
    connectionMethod: 'secret-key',
    freighterAvailable: false,
    error: null,
    autoReconnectSettled: true,
    connect: vi.fn(),
    connectFreighter: vi.fn(),
    connectSecretKey: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

describe('useWallet', () => {
  it('exposes address as an alias for publicKey (success path)', () => {
    state.publicKey = 'GCONNECTED';
    state.connected = true;
    const { result } = renderHook(() => useWallet());
    expect(result.current.publicKey).toBe('GCONNECTED');
    expect(result.current.address).toBe('GCONNECTED');
    expect(result.current.connected).toBe(true);
    expect(result.current.networkMismatch).toBe(false);
  });

  it('exposes the disconnected empty state', () => {
    state.publicKey = null;
    state.connected = false;
    const { result } = renderHook(() => useWallet());
    expect(result.current.publicKey).toBeNull();
    expect(result.current.address).toBeNull();
    expect(result.current.connected).toBe(false);
    state.publicKey = 'GCONNECTED';
    state.connected = true;
  });

  it('forwards connection actions', () => {
    const { result } = renderHook(() => useWallet());
    expect(typeof result.current.connect).toBe('function');
    expect(typeof result.current.disconnect).toBe('function');
    expect(result.current.autoReconnectSettled).toBe(true);
  });
});

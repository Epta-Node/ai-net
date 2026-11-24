/**
 * Wallet lifecycle toasts — Issue #885
 *
 * Connecting, disconnecting and failing to connect each raise a toast through
 * the real ToastContext:
 *  - success toast on connect (Freighter and secret key)
 *  - info toast on a user-initiated disconnect
 *  - error toast on a connection failure (but not when the user declines the
 *    Freighter popup, which is not a failure)
 * and nothing is raised for silent transitions (page-load auto-reconnect, or a
 * `wallet_disconnected` event from the API client, which toasts on its own).
 */
import { render, act, waitFor } from '@testing-library/react'
import { describe, test, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { Keypair, Networks } from '@stellar/stellar-sdk'
import {
  WalletProvider,
  useWallet,
  InvalidKeypairError,
  SecretKeyNetworkError,
} from './WalletContext'
import type { WalletContextValue } from './WalletContext'
import { ToastProvider, useToast } from './ToastContext'
import type { Toast } from './ToastContext'
import { WalletConnectionError } from '../services/freighter'
import { writeWalletSession, clearWalletSession } from '../services/walletSession'

const freighter = vi.hoisted(() => ({
  isFreighterAvailable: vi.fn<() => Promise<boolean>>(),
  isFreighterAuthorized: vi.fn<() => Promise<boolean>>(),
  getFreighterNetwork: vi.fn<() => Promise<string | null>>(),
  connectWithFreighter: vi.fn<() => Promise<string>>(),
  expectedNetwork: vi.fn<() => string>(),
}))

vi.mock('../services/freighter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/freighter')>()
  return { ...actual, ...freighter }
})

const FREIGHTER_ADDRESS = Keypair.random().publicKey()
const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`

// ── Harness ───────────────────────────────────────────────────────────────────

interface Handles {
  wallet: WalletContextValue
  toasts: Toast[]
}

/** Exposes the live wallet and toast contexts to the test through a ref. */
const Probe = React.forwardRef<Handles>((_, ref) => {
  const wallet = useWallet()
  const { toasts } = useToast()
  React.useImperativeHandle(ref, () => ({ wallet, toasts }), [wallet, toasts])
  return null
})
Probe.displayName = 'Probe'

/**
 * Renders the providers in the same order as App.tsx (WalletProvider outside
 * ToastProvider) unless `toastOutside` flips them.
 */
async function setup({ toastOutside = false } = {}) {
  const ref = React.createRef<Handles>()
  const tree = toastOutside ? (
    <ToastProvider>
      <WalletProvider>
        <Probe ref={ref} />
      </WalletProvider>
    </ToastProvider>
  ) : (
    <WalletProvider>
      <ToastProvider>
        <Probe ref={ref} />
      </ToastProvider>
    </WalletProvider>
  )
  render(tree)
  // Let the mount-time Freighter probe settle so it cannot race the test.
  await waitFor(() => expect(ref.current?.wallet.autoReconnectSettled).toBe(true))
  return {
    get wallet() {
      return ref.current!.wallet
    },
    get toasts() {
      return ref.current!.toasts.map(({ message, type }) => ({ message, type }))
    },
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('WalletContext toasts (#885)', () => {
  beforeEach(() => {
    clearWalletSession()
    freighter.isFreighterAvailable.mockResolvedValue(true)
    freighter.isFreighterAuthorized.mockResolvedValue(false)
    freighter.getFreighterNetwork.mockResolvedValue(Networks.TESTNET)
    freighter.connectWithFreighter.mockResolvedValue(FREIGHTER_ADDRESS)
    freighter.expectedNetwork.mockReturnValue(Networks.TESTNET)
  })

  test('shows a success toast when Freighter connects', async () => {
    const h = await setup()
    await act(() => h.wallet.connectFreighter())

    expect(h.wallet.connected).toBe(true)
    expect(h.toasts).toEqual([
      { message: `Wallet connected with Freighter (${short(FREIGHTER_ADDRESS)})`, type: 'success' },
    ])
  })

  test('shows a success toast when a secret key connects', async () => {
    const kp = Keypair.random()
    const h = await setup()
    await act(() => h.wallet.connectSecretKey(kp.secret()))

    expect(h.wallet.publicKey).toBe(kp.publicKey())
    expect(h.toasts).toEqual([
      { message: `Wallet connected with secret key (${short(kp.publicKey())})`, type: 'success' },
    ])
    // The secret never reaches a toast.
    expect(JSON.stringify(h.toasts)).not.toContain(kp.secret())
  })

  test('shows an info toast when the user disconnects', async () => {
    const h = await setup()
    await act(() => h.wallet.connectFreighter())
    act(() => h.wallet.disconnect())

    expect(h.wallet.connected).toBe(false)
    expect(h.toasts.at(-1)).toEqual({ message: 'Wallet disconnected', type: 'info' })
    expect(h.toasts.filter((t) => t.type === 'info')).toHaveLength(1)
  })

  test('shows an error toast when Freighter fails to connect', async () => {
    freighter.connectWithFreighter.mockRejectedValue(
      new WalletConnectionError(
        'NOT_INSTALLED',
        'Freighter extension is not installed or not connected.',
      ),
    )
    const h = await setup()
    await act(() =>
      expect(h.wallet.connectFreighter()).rejects.toBeInstanceOf(WalletConnectionError),
    )

    expect(h.wallet.connected).toBe(false)
    expect(h.toasts).toEqual([
      {
        message: 'Wallet connection failed: Freighter extension is not installed or not connected.',
        type: 'error',
      },
    ])
  })

  test('shows an error toast for an unexpected Freighter error', async () => {
    freighter.connectWithFreighter.mockRejectedValue(new Error('boom'))
    const h = await setup()
    await act(() => expect(h.wallet.connectFreighter()).rejects.toThrow('boom'))

    expect(h.toasts).toEqual([{ message: 'Wallet connection failed: boom', type: 'error' }])
  })

  test('raises no toast when the user declines the Freighter popup', async () => {
    freighter.connectWithFreighter.mockRejectedValue(
      new WalletConnectionError('REJECTED', 'User declined access'),
    )
    const h = await setup()
    await act(() =>
      expect(h.wallet.connectFreighter()).rejects.toBeInstanceOf(WalletConnectionError),
    )

    expect(h.wallet.error).toBeNull()
    expect(h.toasts).toEqual([])
  })

  test('shows an error toast for an invalid secret key', async () => {
    const h = await setup()
    await act(() =>
      expect(h.wallet.connectSecretKey('SNOTAREALKEY')).rejects.toBeInstanceOf(InvalidKeypairError),
    )

    expect(h.toasts).toEqual([
      {
        message:
          'Wallet connection failed: Invalid Stellar secret key. Must start with S and be 56 characters.',
        type: 'error',
      },
    ])
  })

  test('shows an error toast when a secret key is used off testnet', async () => {
    freighter.expectedNetwork.mockReturnValue(Networks.PUBLIC)
    const h = await setup()
    await act(() =>
      expect(h.wallet.connectSecretKey(Keypair.random().secret())).rejects.toBeInstanceOf(
        SecretKeyNetworkError,
      ),
    )

    expect(h.toasts).toEqual([
      {
        message:
          'Wallet connection failed: Manual secret key entry is only available on testnet. Use Freighter instead.',
        type: 'error',
      },
    ])
  })

  test('a page-load auto-reconnect is silent', async () => {
    writeWalletSession({
      publicKey: FREIGHTER_ADDRESS,
      method: 'freighter',
      network: Networks.TESTNET,
    })
    freighter.isFreighterAuthorized.mockResolvedValue(true)
    const h = await setup()

    expect(h.wallet.connected).toBe(true)
    expect(h.toasts).toEqual([])
  })

  test('a session dropped on page load (authorisation revoked) is silent', async () => {
    writeWalletSession({
      publicKey: FREIGHTER_ADDRESS,
      method: 'freighter',
      network: Networks.TESTNET,
    })
    freighter.isFreighterAuthorized.mockResolvedValue(false)
    const h = await setup()

    expect(h.wallet.connected).toBe(false)
    expect(h.toasts).toEqual([])
  })

  test('an external wallet_disconnected event (API 401) adds no disconnect toast of its own', async () => {
    const h = await setup()
    await act(() => h.wallet.connectFreighter())
    act(() => {
      window.dispatchEvent(new CustomEvent('wallet_disconnected'))
    })

    expect(h.wallet.connected).toBe(false)
    expect(h.toasts.map((t) => t.type)).toEqual(['success'])
  })

  test('works when ToastProvider wraps WalletProvider as well', async () => {
    const h = await setup({ toastOutside: true })
    await act(() => h.wallet.connectFreighter())
    act(() => h.wallet.disconnect())

    expect(h.toasts.map((t) => t.type)).toEqual(['success', 'info'])
  })

  test('connecting and disconnecting without a ToastProvider does not throw', async () => {
    const ref = React.createRef<WalletContextValue>()
    const Bare = React.forwardRef<WalletContextValue>((_, r) => {
      const wallet = useWallet()
      React.useImperativeHandle(r, () => wallet, [wallet])
      return null
    })
    Bare.displayName = 'Bare'
    render(
      <WalletProvider>
        <Bare ref={ref} />
      </WalletProvider>,
    )
    await waitFor(() => expect(ref.current?.autoReconnectSettled).toBe(true))
    await act(() => ref.current!.connectFreighter())
    act(() => ref.current!.disconnect())
    expect(ref.current!.connected).toBe(false)
  })
})

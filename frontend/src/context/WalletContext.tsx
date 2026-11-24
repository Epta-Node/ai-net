import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk'
import {
  isFreighterAvailable as checkFreighterAvailable,
  isFreighterAuthorized,
  getFreighterNetwork,
  connectWithFreighter as freighterConnect,
  expectedNetwork,
  WalletConnectionError,
} from '../services/freighter'
import {
  readWalletSession,
  writeWalletSession,
  clearWalletSession,
  hasCompletedWizardPreference,
  setCompletedWizardPreference,
  type ConnectionMethod,
  type WalletSession,
} from '../services/walletSession'

export type { ConnectionMethod, WalletSession }
export { WalletConnectionError }

/** Thrown when a supplied secret key is not a decodable Ed25519 secret seed. */
export class InvalidKeypairError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidKeypairError'
  }
}

/** Thrown when a secret key is supplied on a network that must not accept one. */
export class SecretKeyNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretKeyNetworkError'
  }
}

/** Human-facing label for a Stellar network, used by the nav badge. */
export const NETWORK_LABELS: Record<Networks, string> = {
  [Networks.TESTNET]: 'Testnet',
  [Networks.PUBLIC]: 'Mainnet',
  [Networks.FUTURENET]: 'Futurenet',
  [Networks.SANDBOX]: 'Local',
  [Networks.STANDALONE]: 'Standalone',
}

export interface WalletContextValue {
  publicKey: string | null
  keypair: Keypair | null
  connected: boolean
  connecting: boolean
  /**
   * True when the wallet can actually sign.
   *
   * Freighter signs inside the extension, so a public key is enough. A secret
   * key must be in memory — it never survives a refresh — so a secret-key
   * session reports `connected: true, ready: false` until the user re-enters it.
   */
  ready: boolean
  network: Networks | null
  /** Network this build expects; a mismatch with `network` means trouble. */
  expectedNetwork: Networks
  /** True when connected to a network other than `expectedNetwork`. */
  networkMismatch: boolean
  connectionMethod: ConnectionMethod | null
  freighterAvailable: boolean
  /** Rejection/failure from the most recent connect attempt, cleared on success. */
  error: string | null
  connectFreighter: () => Promise<void>
  connectSecretKey: (secretKey: string) => Promise<void>
  /** @deprecated Use {@link connectSecretKey}. Kept for existing call sites. */
  connect: (secretKey: string) => Promise<void>
  disconnect: () => void
  hasCompletedWizard: boolean
  completeWizard: () => void
  /** True once the initial Freighter probe/auto-reconnect has settled. */
  autoReconnectSettled: boolean
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined)

/**
 * Decode a Stellar secret key into a keypair.
 *
 * The issue text names `StrKey.decodeEd25519SecretKey()`. That helper was
 * removed from `@stellar/stellar-sdk` in v11 — the replacement is
 * `decodeEd25519SecretSeed()`, which returns the same 32 raw bytes that the old
 * function used to wrap, and `Keypair.fromRawEd25519Seed()` consumes them
 * directly. Validating through StrKey *before* constructing the keypair matters:
 * it rejects a wrong-length or bad-checksum string with a precise error instead
 * of letting the keypair constructor throw something opaque.
 */
function keypairFromSecret(secret: string): Keypair {
  const seed = StrKey.decodeEd25519SecretSeed(secret)
  if (seed.length !== 32) {
    throw new InvalidKeypairError('Invalid secret key')
  }
  return Keypair.fromRawEd25519Seed(seed)
}

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<WalletSession | null>(() => readWalletSession())
  const [keypair, setKeypair] = useState<Keypair | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [freighterAvailable, setFreighterAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoReconnectSettled, setAutoReconnectSettled] = useState(false)
  const [hasCompletedWizard, setHasCompletedWizard] = useState<boolean>(
    hasCompletedWizardPreference,
  )

  const expected = useMemo(expectedNetwork, [])

  const publicKey = session?.publicKey ?? null
  const connectionMethod = session?.method ?? null
  const network = session?.network ?? null
  const connected = !!publicKey
  // `ready` means the wallet can actually sign. Freighter signs in its own
  // extension, so a public key is enough. A secret key must be in memory, and
  // it never is after a refresh — hence the reconnect prompt.
  const ready = connected && (connectionMethod === 'freighter' || !!keypair)
  const networkMismatch = connected && !!network && network !== expected

  const clearAllState = useCallback(() => {
    setSession(null)
    setKeypair(null)
    setError(null)
    clearWalletSession()
  }, [])

  const disconnect = useCallback(() => {
    clearAllState()
    // Announce the teardown for listeners that need to react (route changes,
    // toast notifications). Deliberately dispatched *after* state is cleared
    // so a listener reading the context already sees a disconnected wallet.
    window.dispatchEvent(new CustomEvent('wallet_disconnected'))
  }, [clearAllState])

  // Probe for the extension and, when this tab already holds an authorised
  // Freighter session, silently restore it. Runs once: re-running it on every
  // render would re-prompt the user.
  useEffect(() => {
    let cancelled = false

    async function probe() {
      const available = await checkFreighterAvailable()
      if (cancelled) return
      setFreighterAvailable(available)

      const hasFreighterSession = session?.method === 'freighter'

      if (!available) {
        // Without the extension a Freighter session can never sign again, so it
        // is dead. A secret-key session is left alone: the keypair may still be
        // in memory, and if it is not the UI already shows a reconnect prompt.
        if (hasFreighterSession) {
          setSession(null)
          clearWalletSession()
        }
        setAutoReconnectSettled(true)
        return
      }

      if (hasFreighterSession) {
        // `isAllowed()` answers without opening a popup, so auto-reconnect can
        // never surprise the user with an unsolicited prompt.
        if (await isFreighterAuthorized()) {
          const liveNetwork = await getFreighterNetwork()
          if (cancelled) return
          setSession((current) =>
            current ? { ...current, network: liveNetwork ?? current.network } : current,
          )
        } else {
          // Authorisation was revoked, or the wallet was uninstalled. Drop the
          // session rather than showing a key that cannot sign.
          setSession(null)
          clearWalletSession()
        }
      }

      if (!cancelled) setAutoReconnectSettled(true)
    }

    void probe()

    return () => {
      cancelled = true
    }
    // Intentionally mount-only: this is a one-shot page-load action, not a
    // reaction to state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist every session change. The secret key is intentionally absent —
  // see services/walletSession.ts.
  useEffect(() => {
    if (session) {
      writeWalletSession(session)
    }
  }, [session])

  // Other parts of the app (e.g. the API client reacting to a 401) announce a
  // disconnect with an event rather than calling disconnect(). The handler
  // clears state without re-dispatching, so the two paths converge on the same
  // result without looping.
  useEffect(() => {
    const handleDisconnectEvent = () => {
      clearAllState()
    }
    window.addEventListener('wallet_disconnected', handleDisconnectEvent)
    return () => {
      window.removeEventListener('wallet_disconnected', handleDisconnectEvent)
    }
  }, [clearAllState])

  const connectFreighter = useCallback(async () => {
    setConnecting(true)
    setError(null)
    try {
      const address = await freighterConnect()
      const liveNetwork = await getFreighterNetwork()
      setKeypair(null)
      setSession({ publicKey: address, method: 'freighter', network: liveNetwork })
      setFreighterAvailable(true)
    } catch (err) {
      // A declined popup is an expected outcome, not a failure worth surfacing
      // as an error banner — the user already saw the extension's own prompt.
      const message =
        err instanceof WalletConnectionError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to connect to Freighter'
      if (!(err instanceof WalletConnectionError && err.isRejection)) {
        setError(message)
      }
      throw err
    } finally {
      setConnecting(false)
    }
  }, [])

  const connectSecretKey = useCallback(
    async (secretKey: string) => {
      // Manual keys are a testnet-only affordance: pasting a mainnet secret
      // into a testnet deployment would silently sign for the wrong network.
      if (expected !== Networks.TESTNET) {
        const err = new SecretKeyNetworkError(
          'Manual secret key entry is only available on testnet. Use Freighter instead.',
        )
        setError(err.message)
        throw err
      }

      setConnecting(true)
      setError(null)
      try {
        const kp = keypairFromSecret(secretKey.trim())
        setKeypair(kp)
        setSession({ publicKey: kp.publicKey(), method: 'secret-key', network: expected })
      } catch {
        // StrKey already produced a precise reason; the UI only needs a stable,
        // translatable headline, so the specific cause is not leaked through.
        const message = 'Invalid secret key'
        setError(message)
        // Rethrow so the form can render the message inline — the caller owns
        // the UI, this context only owns the state.
        throw new InvalidKeypairError(message)
      } finally {
        setConnecting(false)
      }
    },
    [expected],
  )

  const completeWizard = useCallback(() => {
    setHasCompletedWizard(true)
    setCompletedWizardPreference()
  }, [])

  const value = useMemo<WalletContextValue>(
    () => ({
      publicKey,
      keypair,
      connected,
      connecting,
      ready,
      network,
      expectedNetwork: expected,
      networkMismatch,
      connectionMethod,
      freighterAvailable,
      error,
      connectFreighter,
      connectSecretKey,
      connect: connectSecretKey,
      disconnect,
      hasCompletedWizard,
      completeWizard,
      autoReconnectSettled,
    }),
    [
      publicKey,
      keypair,
      connected,
      connecting,
      ready,
      network,
      expected,
      networkMismatch,
      connectionMethod,
      freighterAvailable,
      error,
      connectFreighter,
      connectSecretKey,
      disconnect,
      hasCompletedWizard,
      completeWizard,
      autoReconnectSettled,
    ],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export const useWallet = (): WalletContextValue => {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider')
  }
  return context
}

export { useWallet as useWalletContext }

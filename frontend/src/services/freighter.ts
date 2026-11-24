import {
  isConnected,
  isAllowed,
  requestAccess,
  signTransaction as freighterSignTransaction,
  getNetwork as freighterGetNetwork,
  isBrowser,
} from '@stellar/freighter-api'
import { Networks } from '@stellar/stellar-sdk'

/** Passphrase for the network this deployment is pinned to (testnet by default). */
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'

/** Passphrase of every network Freighter is able to report. */
const FREIGHTER_NETWORK_BY_PASSPHRASE: Record<string, Networks> = {
  'Test SDF Network ; September 2015': Networks.TESTNET,
  'Public Global Stellar Network ; September 2015': Networks.PUBLIC,
  'Standalone Network ; February 2017': Networks.SANDBOX,
  'Test SDF Future Network ; October 2022': Networks.FUTURENET,
}

/**
 * The network the app is built against.
 *
 * Deployments are testnet-first, so `VITE_STELLAR_NETWORK` is the only thing
 * that can move this off the default. An unrecognised value falls back to
 * testnet rather than throwing, because a misconfigured env var must not take
 * the whole app down at module scope.
 */
export function expectedNetwork(): Networks {
  const parsed = String(import.meta.env.VITE_STELLAR_NETWORK ?? '').toLowerCase()
  switch (parsed) {
    case 'mainnet':
    case 'public':
      return Networks.PUBLIC
    case 'local':
    case 'sandbox':
      return Networks.SANDBOX
    case 'futurenet':
      return Networks.FUTURENET
    case 'testnet':
      return Networks.TESTNET
    default:
      return Networks.TESTNET
  }
}

/** Freighter reports the passphrase it is currently switched to. */
export async function getFreighterNetwork(): Promise<Networks | null> {
  if (!isBrowser) return null
  try {
    const result = await freighterGetNetwork()
    if (result.error || !result.network) return null
    return FREIGHTER_NETWORK_BY_PASSPHRASE[result.network] ?? null
  } catch {
    return null
  }
}

export async function isFreighterAvailable(): Promise<boolean> {
  if (!isBrowser) return false
  try {
    const result = await isConnected()
    return result.isConnected === true
  } catch {
    return false
  }
}

/**
 * Whether Freigher has already granted this origin access, without prompting.
 *
 * Auto-reconnect depends on answering this question quietly: if the user has
 * not authorised the app yet, `isAllowed()` returns false and the caller must
 * not open the Freighter popup on page load.
 */
export async function isFreighterAuthorized(): Promise<boolean> {
  if (!(await isFreighterAvailable())) return false
  try {
    const result = await isAllowed()
    return result.isAllowed === true
  } catch {
    return false
  }
}

/**
 * Ask Freighter for the active account address.
 *
 * Rejections are normalised to {@link WalletConnectionError} so callers can
 * distinguish "the user clicked Cancel" from "the extension is missing" without
 * string-matching on extension-specific messages.
 */
export async function connectWithFreighter(): Promise<string> {
  if (!(await isFreighterAvailable())) {
    throw new WalletConnectionError(
      'NOT_INSTALLED',
      'Freighter extension is not installed or not connected.',
    )
  }

  let address: string | undefined
  try {
    const result = await requestAccess()
    if (result.error) {
      throw new WalletConnectionError(
        result.error.code === 'NOT_ALLOWED' || /denied|rejected|cancel/i.test(result.error.message ?? '')
          ? 'REJECTED'
          : 'UNKNOWN',
        result.error.message || 'User denied Freighter access.',
      )
    }
    address = result.address
  } catch (err) {
    if (err instanceof WalletConnectionError) throw err
    // `requestAccess` rejects outright when the popup is dismissed, and some
    // Freighter builds reject on the lock screen as well.
    const message = err instanceof Error ? err.message : String(err)
    throw new WalletConnectionError(
      /denied|rejected|cancel|denied by user/i.test(message) ? 'REJECTED' : 'UNKNOWN',
      message || 'Failed to request Freighter access.',
    )
  }

  if (!address) {
    throw new WalletConnectionError('NO_ADDRESS', 'Freighter returned an empty address.')
  }
  return address
}

export type WalletConnectionErrorCode = 'NOT_INSTALLED' | 'REJECTED' | 'NO_ADDRESS' | 'UNKNOWN'

/** A user- or extension-caused failure during wallet connection. */
export class WalletConnectionError extends Error {
  readonly code: WalletConnectionErrorCode

  constructor(code: WalletConnectionErrorCode, message: string) {
    super(message)
    this.name = 'WalletConnectionError'
    this.code = code
  }

  /** True when the user simply declined — not worth an error banner. */
  get isRejection(): boolean {
    return this.code === 'REJECTED'
  }
}

export async function signTransactionWithFreighter(
  transactionXdr: string,
  accountAddress: string
): Promise<string> {
  const result = await freighterSignTransaction(transactionXdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: accountAddress,
  })

  if (result.error) {
    throw new Error(result.error.message || 'Freighter transaction signing failed.')
  }

  return result.signedTxXdr
}

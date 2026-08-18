import {
  isConnected,
  isAllowed,
  requestAccess,
  signTransaction as freighterSignTransaction,
  isBrowser,
} from '@stellar/freighter-api'

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'

export async function isFreighterAvailable(): Promise<boolean> {
  if (!isBrowser) return false
  try {
    const result = await isConnected()
    return result.isConnected === true
  } catch {
    return false
  }
}

export async function connectWithFreighter(): Promise<string> {
  const connected = await isFreighterAvailable()
  if (!connected) {
    throw new Error('Freighter extension is not installed or not connected.')
  }

  const allowed = await isAllowed()
  if (!allowed.isAllowed) {
    const setAllowedResult = await requestAccess()
    if (setAllowedResult.error) {
      throw new Error(setAllowedResult.error.message || 'User denied Freighter access.')
    }
    return setAllowedResult.address
  }

  const accessResult = await requestAccess()
  if (accessResult.error) {
    throw new Error(accessResult.error.message || 'Failed to request Freighter access.')
  }
  return accessResult.address
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

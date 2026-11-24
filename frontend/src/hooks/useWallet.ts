import { useWallet as useWalletContext } from '../context/WalletContext';

/**
 * Convenience wrapper over {@link useWalletContext}.
 *
 * Adds `address` as an alias for `publicKey` (the name several Stellar-facing
 * components already use) and re-exports the connection state introduced in
 * #477 — `connecting`, `network`, and `networkMismatch` — so components do not
 * have to reach into the context module directly.
 */
export const useWallet = () => {
  const {
    publicKey,
    keypair,
    connected,
    connecting,
    ready,
    network,
    expectedNetwork,
    networkMismatch,
    connectionMethod,
    freighterAvailable,
    error,
    autoReconnectSettled,
    connect,
    connectFreighter,
    connectSecretKey,
    disconnect,
  } = useWalletContext();

  return {
    address: publicKey,
    publicKey,
    keypair,
    connected,
    connecting,
    ready,
    network,
    expectedNetwork,
    networkMismatch,
    connectionMethod,
    freighterAvailable,
    error,
    autoReconnectSettled,
    connect,
    connectFreighter,
    connectSecretKey,
    disconnect,
  };
};

import { useWallet as useWalletContext } from '../context/WalletContext';

export const useWallet = () => {
  const { publicKey, keypair, connected, ready, connectionMethod, freighterAvailable, connect, connectFreighter, disconnect } = useWalletContext();
  return {
    address: publicKey,
    publicKey,
    keypair,
    connected,
    ready,
    connectionMethod,
    freighterAvailable,
    connect,
    connectFreighter,
    disconnect,
  };
};

import React, { createContext, useContext, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Keypair } from '@stellar/stellar-sdk'
import {
  isFreighterAvailable as checkFreighterAvailable,
  connectWithFreighter as freighterConnect,
} from '../services/freighter'

export type ConnectionMethod = 'freighter' | 'secret-key'

export class InvalidKeypairError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidKeypairError'
  }
}

interface WalletContextType {
  publicKey: string | null
  keypair: Keypair | null
  connected: boolean
  ready: boolean
  connectionMethod: ConnectionMethod | null
  freighterAvailable: boolean
  connect: (secretKey: string) => Promise<void>
  connectFreighter: () => Promise<void>
  disconnect: () => void
}

const WalletContext = createContext<WalletContextType | undefined>(undefined)

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation()

  const [publicKey, setPublicKey] = useState<string | null>(() => {
    return localStorage.getItem('wallet_pubkey') || localStorage.getItem('walletAddress')
  })
  const [keypair, setKeypair] = useState<Keypair | null>(null)
  const [connectionMethod, setConnectionMethod] = useState<ConnectionMethod | null>(() => {
    const stored = localStorage.getItem('wallet_connection_method') as ConnectionMethod | null
    if (stored === 'freighter' || stored === 'secret-key') return stored
    return null
  })
  const [freighterAvailable, setFreighterAvailable] = useState(false)

  const connected = !!publicKey
  // ready means the wallet can actually sign transactions:
  // - Freighter: always ready when connected (Freighter handles signing)
  // - Secret key: only ready when keypair is in memory (not serializable)
  const ready = connected && (connectionMethod === 'freighter' || !!keypair)

  useEffect(() => {
    checkFreighterAvailable().then(setFreighterAvailable)
  }, [])

  useEffect(() => {
    if (connectionMethod === 'freighter' && publicKey && !keypair) {
      checkFreighterAvailable().then((available) => {
        if (available) {
          setFreighterAvailable(true)
        } else {
          setFreighterAvailable(false)
        }
      })
    }
  }, [connectionMethod, publicKey, keypair])

  const connect = async (secretKey: string) => {
    try {
      const kp = Keypair.fromSecret(secretKey)
      const pubKey = kp.publicKey()
      setKeypair(kp)
      setPublicKey(pubKey)
      setConnectionMethod('secret-key')
      localStorage.setItem('wallet_pubkey', pubKey)
      localStorage.setItem('walletAddress', pubKey)
      localStorage.setItem('wallet_connection_method', 'secret-key')
    } catch (error: unknown) {
      throw new InvalidKeypairError(
        error instanceof Error ? error.message : t('validation.invalidSecretKey')
      )
    }
  }

  const connectFreighter = async () => {
    const pubKey = await freighterConnect()
    setKeypair(null)
    setPublicKey(pubKey)
    setConnectionMethod('freighter')
    localStorage.setItem('wallet_pubkey', pubKey)
    localStorage.setItem('walletAddress', pubKey)
    localStorage.setItem('wallet_connection_method', 'freighter')
  }

  const disconnect = () => {
    setPublicKey(null)
    setKeypair(null)
    setConnectionMethod(null)
    localStorage.removeItem('wallet_pubkey')
    localStorage.removeItem('walletAddress')
    localStorage.removeItem('wallet_connection_method')
  }

  useEffect(() => {
    const handleDisconnectEvent = () => {
      disconnect()
    }
    window.addEventListener('wallet_disconnected', handleDisconnectEvent)
    return () => {
      window.removeEventListener('wallet_disconnected', handleDisconnectEvent)
    }
  }, [])

  return (
    <WalletContext.Provider
      value={{
        publicKey,
        keypair,
        connected,
        ready,
        connectionMethod,
        freighterAvailable,
        connect,
        connectFreighter,
        disconnect,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}

export const useWallet = () => {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider')
  }
  return context
}

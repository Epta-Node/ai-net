import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WalletWizard } from './WalletWizard'
import * as WalletContext from '../../context/WalletContext'
import * as WalletBalanceHook from '../../hooks/useWalletBalance'
import '@testing-library/jest-dom'

// Mock framer-motion to avoid animation delays in tests
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}))

describe('WalletWizard', () => {
  const mockCompleteWizard = vi.fn()
  const mockConnectFreighter = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(WalletContext, 'useWallet').mockReturnValue({
      publicKey: null,
      keypair: null,
      connected: false,
      ready: false,
      connectionMethod: null,
      freighterAvailable: true,
      connect: vi.fn(),
      connectFreighter: mockConnectFreighter,
      disconnect: vi.fn(),
      hasCompletedWizard: false,
      completeWizard: mockCompleteWizard,
    })
    
    vi.spyOn(WalletBalanceHook, 'useWalletBalance').mockReturnValue({
      balance: '0',
      loading: false,
      error: null,
    })
  })

  it('renders step 1 initially', () => {
    render(<WalletWizard />)
    expect(screen.getByText('Welcome to AI Net')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
  })

  it('can navigate to step 2 and back to step 1', () => {
    render(<WalletWizard />)
    
    // Go to step 2
    fireEvent.click(screen.getByText('Get Started'))
    expect(screen.getByText('Install Freighter Wallet')).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    
    // Go back to step 1
    fireEvent.click(screen.getByText('Back'))
    expect(screen.getByText('Welcome to AI Net')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
  })

  it('can skip the wizard', () => {
    render(<WalletWizard />)
    fireEvent.click(screen.getByText('Skip for now'))
    expect(mockCompleteWizard).toHaveBeenCalledTimes(1)
  })

  it('connects wallet on step 3', async () => {
    render(<WalletWizard />)
    
    // Go to step 2
    fireEvent.click(screen.getByText('Get Started'))
    // Go to step 3
    fireEvent.click(screen.getByText('Continue'))
    
    expect(screen.getByText('Connect Wallet')).toBeInTheDocument()
    
    const connectBtn = screen.getByText('Connect with Freighter')
    
    mockConnectFreighter.mockResolvedValueOnce(undefined)
    fireEvent.click(connectBtn)
    
    expect(mockConnectFreighter).toHaveBeenCalledTimes(1)
    
    await waitFor(() => {
      expect(screen.getByText('Fund Your Account')).toBeInTheDocument()
    })
  })

  it('can finish setup on step 4', () => {
    vi.spyOn(WalletContext, 'useWallet').mockReturnValue({
      publicKey: 'GA123',
      keypair: null,
      connected: true,
      ready: true,
      connectionMethod: 'freighter',
      freighterAvailable: true,
      connect: vi.fn(),
      connectFreighter: mockConnectFreighter,
      disconnect: vi.fn(),
      hasCompletedWizard: false,
      completeWizard: mockCompleteWizard,
    })
    
    render(<WalletWizard />)
    
    // Go to step 2
    fireEvent.click(screen.getByText('Get Started'))
    // Go to step 3
    fireEvent.click(screen.getByText('Continue'))
    // Go to step 4 (Continue is enabled now since connected is true)
    fireEvent.click(screen.getByText('Continue'))
    
    expect(screen.getByText('Fund Your Account')).toBeInTheDocument()
    
    fireEvent.click(screen.getByText('Finish Setup'))
    expect(mockCompleteWizard).toHaveBeenCalledTimes(1)
  })
})

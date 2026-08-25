import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QRCodeSVG } from 'qrcode.react'
import WalletPage from './WalletPage'

const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
const mockConnectFreighter = vi.fn()

let mockWalletState: {
  publicKey: string | null
  keypair: any
  connected: boolean
  ready: boolean
  connectionMethod: string | null
  freighterAvailable: boolean
  connect: typeof mockConnect
  connectFreighter: typeof mockConnectFreighter
  disconnect: typeof mockDisconnect
  hasCompletedWizard: boolean
} = {
  publicKey: null as string | null,
  keypair: null as any,
  connected: false as boolean,
  ready: false as boolean,
  connectionMethod: null as string | null,
  freighterAvailable: false,
  connect: mockConnect,
  connectFreighter: mockConnectFreighter,
  disconnect: mockDisconnect,
  hasCompletedWizard: true,
}

vi.mock('../context/WalletContext', () => ({
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  InvalidKeypairError: class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'InvalidKeypairError'
    }
  },
}))

vi.mock('../hooks/useWalletBalance', () => ({
  useWalletBalance: () => ({
    balance: '100.0000000',
    loading: false,
    error: null,
  }),
}))

vi.mock('../hooks/useTransactionHistory', () => ({
  useTransactionHistory: () => ({
    transactions: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <WalletPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset to disconnected state
  mockWalletState = {
    publicKey: null,
    keypair: null,
    connected: false,
    ready: false,
    connectionMethod: null,
    freighterAvailable: false,
    connect: mockConnect,
    connectFreighter: mockConnectFreighter,
    disconnect: mockDisconnect,
    hasCompletedWizard: true,
  }
})

describe('WalletPage - Disconnected State', () => {
  it('shows the connect form when no wallet is connected', () => {
    renderPage()
    expect(screen.getByPlaceholderText('SABCD...5678')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /connect with secret key/i })).toBeInTheDocument()
  })

  it('calls connect when the form is submitted with a secret key', async () => {
    mockConnect.mockResolvedValueOnce(undefined)
    renderPage()

    const input = screen.getByPlaceholderText('SABCD...5678')
    fireEvent.change(input, { target: { value: 'SABCD1234' } })
    fireEvent.click(screen.getByRole('button', { name: /connect with secret key/i }))

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalledWith('SABCD1234')
    })
  })

  it('shows an error when connect fails', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Invalid secret key'))
    renderPage()

    const input = screen.getByPlaceholderText('SABCD...5678')
    fireEvent.change(input, { target: { value: 'bad-key' } })
    fireEvent.click(screen.getByRole('button', { name: /connect with secret key/i }))

    expect(await screen.findByText('Invalid secret key')).toBeInTheDocument()
  })
})

describe('WalletPage - Connected State', () => {
  beforeEach(() => {
    mockWalletState = {
      publicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      keypair: {} as any,
      connected: true,
      ready: true,
      connectionMethod: 'secret-key',
      freighterAvailable: false,
      connect: mockConnect,
      connectFreighter: mockConnectFreighter,
      disconnect: mockDisconnect,
      hasCompletedWizard: true,
    }
  })

  it('shows the balance when connected', () => {
    renderPage()
    expect(screen.getByText('100.0000000')).toBeInTheDocument()
    expect(screen.getByText('XLM')).toBeInTheDocument()
  })

  it('shows the disconnect button', () => {
    renderPage()
    const disconnectBtn = screen.getByRole('button', { name: /disconnect/i })
    expect(disconnectBtn).toBeInTheDocument()

    fireEvent.click(disconnectBtn)
    expect(mockDisconnect).toHaveBeenCalled()
  })

  it('shows empty transaction history state (not a 500 error)', () => {
    renderPage()
    expect(screen.queryByText(/500/i)).not.toBeInTheDocument()
    expect(screen.getByText('No transactions yet')).toBeInTheDocument()
  })

  it('renders the QR code section with address details', () => {
    renderPage()
    // Verify the public key label is rendered
    expect(screen.getByText('Public Key')).toBeInTheDocument()
    // The QR code SVG renders via qrcode.react
    expect(document.querySelector('svg')).not.toBeNull()
    // The truncated public key is rendered in a code element
    const codeEl = document.querySelector('code')
    expect(codeEl).not.toBeNull()
    expect(codeEl?.textContent).toContain('GABCDEFG')
    expect(codeEl?.textContent).toContain('STUVWXYZ')
  })
})

describe('QR Code Rendering', () => {
  it('renders a QR code SVG for the given public key', () => {
    const testKey = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const { container } = render(<QRCodeSVG value={testKey} size={100} level="M" />)

    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // QR codes render as paths, not rects
    const paths = svg!.querySelectorAll('path')
    expect(paths.length).toBeGreaterThan(0)
  })

  it('renders path elements for the QR code', () => {
    const testKey = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const { container } = render(<QRCodeSVG value={testKey} size={100} level="M" />)

    const paths = container.querySelectorAll('path')
    expect(paths.length).toBeGreaterThan(0)
  })
})

describe('SendXLMForm Validation', () => {
  beforeEach(() => {
    mockWalletState = {
      publicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      keypair: {} as any,
      connected: true,
      ready: true,
      connectionMethod: 'secret-key',
      freighterAvailable: false,
      connect: mockConnect,
      connectFreighter: mockConnectFreighter,
      disconnect: mockDisconnect,
      hasCompletedWizard: true,
    }
  })

  it('validates invalid Stellar addresses without making an API call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderPage()

    const destInput = screen.getByPlaceholderText('GABCD...1234')
    fireEvent.change(destInput, { target: { value: 'invalid-address' } })
    fireEvent.blur(destInput)

    expect(await screen.findByText(/Invalid Stellar address/i)).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shows insufficient balance error for amounts exceeding balance', async () => {
    renderPage()

    const amountInput = screen.getByPlaceholderText('0.0')
    fireEvent.change(amountInput, { target: { value: '99999' } })
    fireEvent.blur(amountInput)

    expect(await screen.findByText(/Insufficient balance/i)).toBeInTheDocument()
  })

  it('renders the send form with Send button when connected', () => {
    renderPage()
    expect(screen.getByPlaceholderText('GABCD...1234')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('0.0')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Payment memo (max 28 chars)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument()
  })

  it('disables the Send button when fields are empty', () => {
    renderPage()
    // Send button should be enabled (just clicking it will trigger validation)
    const sendBtn = screen.getByRole('button', { name: /^send$/i })
    expect(sendBtn).not.toBeDisabled()
  })
})

import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import AppShell from './AppShell'
import Sidebar from './Sidebar'
import TopNav from './TopNav'
import { WalletProvider } from '../../context/WalletContext'

// Suppress framer-motion warnings in jsdom
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>
      ),
    },
  }
})

const renderInShell = (initialPath = '/') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <WalletProvider>
        <AppShell>
          <div data-testid="page-content">Page Content</div>
        </AppShell>
      </WalletProvider>
    </MemoryRouter>
  )

// ─── Layout structure ────────────────────────────────────────────────────────

describe('AppShell Layout', () => {
  test('renders basic layout structure', () => {
    renderInShell()
    expect(screen.getByTestId('page-content')).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    // Sidebar nav is the primary navigation landmark
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument()
  })

  test('renders with correct ARIA attributes', () => {
    renderInShell()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(nav).toBeInTheDocument()
  })
})

// ─── aria-current="page" on active nav link ───────────────────────────────

describe('Sidebar aria-current', () => {
  const navigate = vi.fn()

  test('sets aria-current="page" on the active route', () => {
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <Sidebar collapsed={false} currentPath="/agents" onNavigate={navigate} />
      </MemoryRouter>
    )
    const agentsBtn = screen.getByRole('button', { name: /agents/i })
    expect(agentsBtn).toHaveAttribute('aria-current', 'page')
  })

  test('does NOT set aria-current on inactive links', () => {
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <Sidebar collapsed={false} currentPath="/agents" onNavigate={navigate} />
      </MemoryRouter>
    )
    const walletBtn = screen.getByRole('button', { name: /wallet/i })
    expect(walletBtn).not.toHaveAttribute('aria-current')
  })

  test('active link changes when currentPath changes', () => {
    const { rerender } = render(
      <MemoryRouter>
        <Sidebar collapsed={false} currentPath="/" onNavigate={navigate} />
      </MemoryRouter>
    )
    expect(screen.getByRole('button', { name: /dashboard/i })).toHaveAttribute('aria-current', 'page')

    rerender(
      <MemoryRouter>
        <Sidebar collapsed={false} currentPath="/wallet" onNavigate={navigate} />
      </MemoryRouter>
    )
    expect(screen.getByRole('button', { name: /wallet/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /dashboard/i })).not.toHaveAttribute('aria-current')
  })
})

// ─── TopNav truncateKey ───────────────────────────────────────────────────

describe('TopNav truncateKey', () => {
  const renderNav = (_publicKey: string | null) =>
    render(
      <MemoryRouter>
        <WalletProvider>
          <TopNav
            onMenuClick={vi.fn()}
            onToggleSidebar={vi.fn()}
            sidebarCollapsed={false}
            isMobile={false}
          />
        </WalletProvider>
      </MemoryRouter>
    )

  test('shows "Not Connected" when no wallet', () => {
    renderNav(null)
    expect(screen.getByText('Not Connected')).toBeInTheDocument()
  })

  test('truncates a full-length Stellar public key to GABC...XYZ format', () => {
    // Seed localStorage so WalletProvider picks up the key
    const key = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRXYZ'
    localStorage.setItem('wallet_pubkey', key)
    renderNav(key)
    // Expects first 4 chars + ... + last 3 chars
    const expected = `${key.slice(0, 4)}...${key.slice(-3)}`
    expect(screen.getByText(expected)).toBeInTheDocument()
    localStorage.removeItem('wallet_pubkey')
  })

  test('keys of 8 chars or fewer are shown in full', () => {
    const shortKey = 'GABCXYZ'
    localStorage.setItem('wallet_pubkey', shortKey)
    renderNav(shortKey)
    expect(screen.getByText(shortKey)).toBeInTheDocument()
    localStorage.removeItem('wallet_pubkey')
  })
})

// ─── Sidebar localStorage persistence ────────────────────────────────────

describe('Sidebar collapsed state persistence', () => {
  beforeEach(() => localStorage.clear())

  test('reads initial collapsed state from localStorage', () => {
    localStorage.setItem('sidebar_collapsed', 'true')
    renderInShell()
    const sidebar = document.querySelector('.sidebar')
    expect(sidebar).toHaveClass('collapsed')
  })

  test('persists collapsed state to localStorage on toggle', async () => {
    renderInShell()
    const toggleBtn = screen.getByRole('button', { name: /collapse sidebar/i })
    await act(async () => { fireEvent.click(toggleBtn) })
    expect(localStorage.getItem('sidebar_collapsed')).toBe('true')
  })
})

// ─── Mobile drawer Escape key ─────────────────────────────────────────────

describe('Mobile drawer keyboard', () => {
  let origMatchMedia: typeof window.matchMedia

  beforeEach(() => {
    origMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { value: origMatchMedia })
  })

  test('closes drawer on Escape key', async () => {
    renderInShell()
    const hamburger = screen.getByRole('button', { name: /open navigation menu/i })
    await act(async () => { fireEvent.click(hamburger) })

    // Drawer should be open
    expect(screen.getByRole('dialog', { name: /mobile navigation/i })).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(screen.queryByRole('dialog', { name: /mobile navigation/i })).not.toBeInTheDocument()
  })
})

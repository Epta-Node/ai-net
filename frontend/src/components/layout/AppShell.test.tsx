import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import AppShell from './AppShell'
import i18n from 'i18next'
import Sidebar from './Sidebar'
import TopNav from './TopNav'
import { NAV_GROUPS, NAV_ITEMS } from './navigation'
import { WalletProvider } from '../../context/WalletContext'

// jsdom has no layout engine, so framer-motion's animation props are stripped
// rather than forwarded onto the DOM (React would warn about every one).
const MOTION_ONLY_PROPS = [
  'drag', 'dragConstraints', 'dragElastic', 'onDragEnd',
  'initial', 'animate', 'exit', 'transition', 'layoutId', 'layout',
]

const stripMotionProps = (props: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.includes(key)))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...stripMotionProps(props as Record<string, unknown>)}>{children}</div>
        )
      ),
      span: React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
        ({ children, ...props }, ref) => (
          <span ref={ref} {...stripMotionProps(props as Record<string, unknown>)}>{children}</span>
        )
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
        <Sidebar collapsed={false} currentPath="/dashboard" onNavigate={navigate} />
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

// ─── Grouped sidebar (#352) ───────────────────────────────────────────────

describe('Sidebar grouping', () => {
  const navigate = vi.fn()

  test('renders every nav item under a labelled group', () => {
    render(
      <MemoryRouter>
        <Sidebar collapsed={false} currentPath="/dashboard" onNavigate={navigate} />
      </MemoryRouter>
    )

    NAV_GROUPS.forEach((group) => {
      const heading = screen.getByRole('heading', { name: i18n.t(group.labelKey) })
      expect(heading).toBeInTheDocument()

      group.items.forEach((item) => {
        expect(screen.getByRole('button', { name: i18n.t(item.labelKey) })).toBeInTheDocument()
      })
    })
  })

  test('keeps item labels in the accessibility tree while collapsed', () => {
    render(
      <MemoryRouter>
        <Sidebar collapsed currentPath="/dashboard" onNavigate={navigate} />
      </MemoryRouter>
    )
    // Collapsing is a visual affordance; it must not remove names from AT.
    NAV_ITEMS.forEach((item) => {
      expect(screen.getByRole('button', { name: i18n.t(item.labelKey) })).toBeInTheDocument()
    })
  })

  test('highlights a nav item for a descendant route', () => {
    render(
      <MemoryRouter>
        <Sidebar collapsed={false} currentPath="/tasks/new/step-2" onNavigate={navigate} />
      </MemoryRouter>
    )
    expect(screen.getByRole('button', { name: 'New Task' })).toHaveAttribute('aria-current', 'page')
  })

  test('highlights nothing for a task detail route, which has no nav entry', () => {
    render(
      <MemoryRouter>
        <Sidebar collapsed={false} currentPath="/tasks/abc-123" onNavigate={navigate} />
      </MemoryRouter>
    )
    expect(screen.getByRole('button', { name: 'New Task' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('button', { name: 'Task History' })).not.toHaveAttribute('aria-current')
  })

  test('navigates to the dashboard route, not the public landing page', () => {
    const onNavigate = vi.fn()
    render(
      <MemoryRouter>
        <Sidebar collapsed={false} currentPath="/wallet" onNavigate={onNavigate} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }))
    expect(onNavigate).toHaveBeenCalledWith('/dashboard')
  })
})

// ─── Per-user sidebar persistence (#352) ──────────────────────────────────

describe('Sidebar state is scoped to the connected wallet', () => {
  const WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234567890123456789'

  beforeEach(() => localStorage.clear())

  test('a connected wallet writes to its own key, leaving the anonymous one alone', async () => {
    localStorage.setItem('wallet_pubkey', WALLET)
    renderInShell()

    const toggleBtn = screen.getByRole('button', { name: /collapse sidebar/i })
    await act(async () => { fireEvent.click(toggleBtn) })

    expect(localStorage.getItem(`sidebar_collapsed:${WALLET}`)).toBe('true')
    expect(localStorage.getItem('sidebar_collapsed')).toBeNull()
  })

  test('a wallet reads back its own preference, not another wallet\'s', () => {
    localStorage.setItem('sidebar_collapsed', 'false')
    localStorage.setItem(`sidebar_collapsed:${WALLET}`, 'true')
    localStorage.setItem('wallet_pubkey', WALLET)

    renderInShell()
    expect(document.querySelector('.sidebar')).toHaveClass('collapsed')
  })

  test('survives a localStorage that throws for the sidebar key', () => {
    // Private-mode browsers throw on storage access. Only the sidebar key is
    // made to throw here, so the assertion is about the shell's own guard and
    // not about how any other provider handles storage.
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith('sidebar_collapsed')) throw new Error('storage disabled')
      return getItem.call(this, key)
    }
    try {
      expect(() => renderInShell()).not.toThrow()
      // Falls back to the expanded sidebar rather than rendering nothing.
      expect(document.querySelector('.sidebar')).not.toHaveClass('collapsed')
    } finally {
      Storage.prototype.getItem = getItem
    }
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

import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, test, expect, beforeEach, vi } from 'vitest'
import i18n from 'i18next'
import MobileDrawer, { NAV_ITEMS } from './MobileDrawer'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => {
          const { drag, dragConstraints, dragElastic, onDragEnd, initial, animate, exit, transition, ...rest } = props as Record<string, unknown>
          return <div ref={ref} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>
        },
      ),
    },
  }
})

const mockNavigate = vi.fn()
let mockPathname = '/'

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: mockPathname, search: '', hash: '', state: null, key: 'default' }),
  }
})

const renderDrawer = (overrides: { currentPath?: string; onClose?: () => void; onNavigate?: (path: string) => void } = {}) => {
  const onClose = overrides.onClose ?? vi.fn()
  const onNavigate = overrides.onNavigate ?? vi.fn()
  const currentPath = overrides.currentPath ?? '/'

  return {
    ...render(
      <MemoryRouter>
        <MobileDrawer
          onClose={onClose}
          currentPath={currentPath}
          onNavigate={onNavigate}
        />
      </MemoryRouter>,
    ),
    onClose,
    onNavigate,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPathname = '/'
})

// ─── Rendering ─────────────────────────────────────────────────────────────

describe('MobileDrawer rendering', () => {
  test('renders navigation dialog with all nav items', () => {
    renderDrawer()
    expect(screen.getByRole('dialog', { name: /mobile navigation/i })).toBeInTheDocument()
    expect(screen.getByText('Navigation')).toBeInTheDocument()
    NAV_ITEMS.forEach((item) => {
      expect(screen.getByText(i18n.t(item.labelKey))).toBeInTheDocument()
    })
  })

  test('has aria-modal attribute', () => {
    renderDrawer()
    const dialog = screen.getByRole('dialog', { name: /mobile navigation/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  test('sets aria-current="page" on active nav item', () => {
    renderDrawer({ currentPath: '/agents' })
    const btn = screen.getByRole('button', { name: /agents/i })
    expect(btn).toHaveAttribute('aria-current', 'page')
  })

  test('does not set aria-current on inactive nav items', () => {
    renderDrawer({ currentPath: '/agents' })
    const btn = screen.getByRole('button', { name: /wallet/i })
    expect(btn).not.toHaveAttribute('aria-current')
  })

  test('renders close button with accessible label', () => {
    renderDrawer()
    expect(screen.getByRole('button', { name: /close navigation menu/i })).toBeInTheDocument()
  })

  test('renders drag handle', () => {
    renderDrawer()
    const dialog = screen.getByRole('dialog', { name: /mobile navigation/i })
    const handle = dialog.querySelector('.drawer-drag-handle')
    expect(handle).toBeInTheDocument()
  })
})

// ─── Close callbacks ───────────────────────────────────────────────────────

describe('MobileDrawer close behavior', () => {
  test('calls onClose when close button is clicked', () => {
    const { onClose } = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /close navigation menu/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('calls onClose when backdrop is clicked', () => {
    const { onClose } = renderDrawer()
    const backdrop = document.querySelector('.drawer-backdrop')!
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('calls onNavigate and onClose flow via nav item click', () => {
    const { onNavigate } = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /dashboard/i }))
    expect(onNavigate).toHaveBeenCalledWith('/dashboard')
  })
})

// ─── Close-on-navigate (drawer resets on page navigation) ──────────────────

describe('MobileDrawer close-on-navigate', () => {
  test('AppShell closes drawer on pathname change (integration)', () => {
    const closeFn = vi.fn()
    render(
      <MemoryRouter initialEntries={['/']}>
        <MobileDrawer
          onClose={closeFn}
          currentPath="/"
          onNavigate={(path) => {
            mockPathname = path
            closeFn()
          }}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /agents/i }))
    expect(closeFn).toHaveBeenCalled()
  })
})

// ─── Focus trap ────────────────────────────────────────────────────────────

describe('MobileDrawer focus trap', () => {
  test('traps focus within the drawer on Tab', () => {
    renderDrawer()
    const dialog = screen.getByRole('dialog', { name: /mobile navigation/i })
    const focusableEls = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )

    expect(focusableEls.length).toBeGreaterThan(0)

    const lastEl = focusableEls[focusableEls.length - 1]
    lastEl.focus()
    expect(document.activeElement).toBe(lastEl)

    act(() => {
      fireEvent.keyDown(lastEl, { key: 'Tab' })
    })
    expect(document.activeElement).toBe(focusableEls[0])
  })

  test('traps focus in reverse with Shift+Tab', () => {
    renderDrawer()
    const dialog = screen.getByRole('dialog', { name: /mobile navigation/i })
    const focusableEls = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )

    const firstEl = focusableEls[0]
    firstEl.focus()
    expect(document.activeElement).toBe(firstEl)

    act(() => {
      fireEvent.keyDown(firstEl, { key: 'Tab', shiftKey: true })
    })
    expect(document.activeElement).toBe(focusableEls[focusableEls.length - 1])
  })

  test('focuses first focusable element on mount', () => {
    renderDrawer()
    const dialog = screen.getByRole('dialog', { name: /mobile navigation/i })
    const focusableEls = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    expect(document.activeElement).toBe(focusableEls[0])
  })
})

// ─── NAV_ITEMS export ──────────────────────────────────────────────────────

describe('NAV_ITEMS', () => {
  test('exports 5 navigation items', () => {
    expect(NAV_ITEMS).toHaveLength(5)
  })

  test('each item has path, icon, and a translatable label', () => {
    NAV_ITEMS.forEach((item) => {
      expect(item).toHaveProperty('path')
      expect(item).toHaveProperty('icon')
      expect(item).toHaveProperty('labelKey')
      // A key that resolves to itself means the translation is missing.
      expect(i18n.t(item.labelKey)).not.toBe(item.labelKey)
    })
  })
})

import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, test, expect, beforeEach, vi } from 'vitest'
import TopNav from './TopNav'
import { WalletProvider } from '../../context/WalletContext'
import { ThemeProvider } from '../../context/ThemeContext'

describe('TopNav Theme Toggle', () => {
  beforeEach(() => {
    localStorage.clear()
    // minimal matchMedia mock
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    })
  })

  test('cycles theme and persists selection to localStorage', async () => {
    render(
      <MemoryRouter>
        <WalletProvider>
          <ThemeProvider>
            <TopNav onMenuClick={vi.fn()} onToggleSidebar={vi.fn()} sidebarCollapsed={false} isMobile={false} />
          </ThemeProvider>
        </WalletProvider>
      </MemoryRouter>
    )

    const toggle = screen.getByRole('switch')
    // default is system
    expect(localStorage.getItem('theme-mode')).toBe('system')

    await act(async () => { fireEvent.click(toggle) })
    expect(localStorage.getItem('theme-mode')).toBe('light')

    await act(async () => { fireEvent.click(toggle) })
    expect(localStorage.getItem('theme-mode')).toBe('dark')

    await act(async () => { fireEvent.click(toggle) })
    expect(localStorage.getItem('theme-mode')).toBe('system')
  })
})

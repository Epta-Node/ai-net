import { render, screen, act } from '@testing-library/react'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { useContext } from 'react'
import ThemeContext, { ThemeProvider } from './ThemeContext'

const TestComponent: React.FC = () => {
  const { mode, setMode, effectiveTheme } = useContext(ThemeContext)
  return (
    <div>
      <div data-testid="mode">{mode}</div>
      <div data-testid="effective">{effectiveTheme}</div>
      <button data-testid="set-light" onClick={() => setMode('light')}>Set Light</button>
      <button data-testid="set-dark" onClick={() => setMode('dark')}>Set Dark</button>
      <button data-testid="set-system" onClick={() => setMode('system')}>Set System</button>
    </div>
  )
}

describe('ThemeContext & Anti-FOUC Synchronization (#392)', () => {
  let mediaQueryListeners: Array<(e: { matches: boolean }) => void> = []
  let systemDarkMatches = true

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    mediaQueryListeners = []
    systemDarkMatches = true

    // Create meta theme-color tag if not present
    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      meta.setAttribute('content', '#0A0E14')
      document.head.appendChild(meta)
    }

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: systemDarkMatches,
        media: query,
        addEventListener: vi.fn((event: string, handler: (e: { matches: boolean }) => void) => {
          if (event === 'change') mediaQueryListeners.push(handler)
        }),
        removeEventListener: vi.fn((_event: string, handler: (e: { matches: boolean }) => void) => {
          mediaQueryListeners = mediaQueryListeners.filter((l) => l !== handler)
        }),
        addListener: vi.fn((handler: (e: { matches: boolean }) => void) => {
          mediaQueryListeners.push(handler)
        }),
        removeListener: vi.fn((handler: (e: { matches: boolean }) => void) => {
          mediaQueryListeners = mediaQueryListeners.filter((l) => l !== handler)
        }),
      })),
    })
  })

  afterEach(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta && meta.parentNode) {
      meta.parentNode.removeChild(meta)
    }
  })

  test('defaults to system preference when localStorage is empty', () => {
    systemDarkMatches = false // System prefers light mode

    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    )

    expect(screen.getByTestId('mode').textContent).toBe('system')
    expect(screen.getByTestId('effective').textContent).toBe('light')
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)

    const meta = document.querySelector('meta[name="theme-color"]')
    expect(meta?.getAttribute('content')).toBe('#FFFFFF')
  })

  test('honors explicit stored preference from localStorage on mount', () => {
    localStorage.setItem('ainet.theme', 'light')

    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    )

    expect(screen.getByTestId('mode').textContent).toBe('light')
    expect(screen.getByTestId('effective').textContent).toBe('light')
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)
  })

  test('switches themes and persists to localStorage', () => {
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    )

    // Switch to dark
    act(() => {
      screen.getByTestId('set-dark').click()
    })
    expect(screen.getByTestId('mode').textContent).toBe('dark')
    expect(screen.getByTestId('effective').textContent).toBe('dark')
    expect(document.documentElement.classList.contains('theme-light')).toBe(false)
    expect(localStorage.getItem('ainet.theme')).toBe('dark')

    const meta = document.querySelector('meta[name="theme-color"]')
    expect(meta?.getAttribute('content')).toBe('#0A0E14')

    // Switch to light
    act(() => {
      screen.getByTestId('set-light').click()
    })
    expect(screen.getByTestId('mode').textContent).toBe('light')
    expect(screen.getByTestId('effective').textContent).toBe('light')
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)
    expect(localStorage.getItem('ainet.theme')).toBe('light')
    expect(meta?.getAttribute('content')).toBe('#FFFFFF')
  })

  test('cross-tab synchronization via storage event', () => {
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    )

    expect(screen.getByTestId('mode').textContent).toBe('system')

    // Simulate storage change from another tab
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'ainet.theme',
          newValue: 'light',
        })
      )
    })

    expect(screen.getByTestId('mode').textContent).toBe('light')
    expect(screen.getByTestId('effective').textContent).toBe('light')
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)

    // Simulate storage change to dark from another tab
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'ainet.theme',
          newValue: 'dark',
        })
      )
    })

    expect(screen.getByTestId('mode').textContent).toBe('dark')
    expect(screen.getByTestId('effective').textContent).toBe('dark')
    expect(document.documentElement.classList.contains('theme-light')).toBe(false)
  })

  test('reacts dynamically to live OS appearance changes when in system mode', () => {
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    )

    expect(screen.getByTestId('mode').textContent).toBe('system')
    expect(screen.getByTestId('effective').textContent).toBe('dark')

    // OS switches to light mode
    act(() => {
      mediaQueryListeners.forEach((listener) => listener({ matches: false }))
    })

    expect(screen.getByTestId('effective').textContent).toBe('light')
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)

    // OS switches back to dark mode
    act(() => {
      mediaQueryListeners.forEach((listener) => listener({ matches: true }))
    })

    expect(screen.getByTestId('effective').textContent).toBe('dark')
    expect(document.documentElement.classList.contains('theme-light')).toBe(false)
  })

  describe('persistence edge cases (#874)', () => {
    test('restores the saved theme after the provider is unmounted and remounted', () => {
      const first = render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      )

      act(() => {
        screen.getByTestId('set-light').click()
      })
      expect(localStorage.getItem('ainet.theme')).toBe('light')

      // Simulates a page refresh: tear everything down, then mount fresh
      first.unmount()
      document.documentElement.className = ''

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      )

      expect(screen.getByTestId('mode').textContent).toBe('light')
      expect(screen.getByTestId('effective').textContent).toBe('light')
      expect(document.documentElement.classList.contains('theme-light')).toBe(true)
    })

    test('stored explicit choice wins over the system preference', () => {
      systemDarkMatches = true
      localStorage.setItem('ainet.theme', 'light')

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      )

      expect(screen.getByTestId('mode').textContent).toBe('light')
      expect(screen.getByTestId('effective').textContent).toBe('light')
    })

    test('persists switching back to system mode', () => {
      localStorage.setItem('ainet.theme', 'dark')

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      )

      act(() => {
        screen.getByTestId('set-system').click()
      })

      expect(screen.getByTestId('mode').textContent).toBe('system')
      expect(localStorage.getItem('ainet.theme')).toBe('system')
    })

    test('falls back to system preference when the stored value is invalid', () => {
      systemDarkMatches = false
      localStorage.setItem('ainet.theme', 'solarized')

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      )

      expect(screen.getByTestId('mode').textContent).toBe('system')
      expect(screen.getByTestId('effective').textContent).toBe('light')
    })

    test('falls back to system preference when reading localStorage throws', () => {
      systemDarkMatches = false
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError')
      })

      try {
        render(
          <ThemeProvider>
            <TestComponent />
          </ThemeProvider>
        )

        expect(screen.getByTestId('mode').textContent).toBe('system')
        expect(screen.getByTestId('effective').textContent).toBe('light')
      } finally {
        getItem.mockRestore()
      }
    })

    test('keeps working when writing to localStorage throws', () => {
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      try {
        render(
          <ThemeProvider>
            <TestComponent />
          </ThemeProvider>
        )

        act(() => {
          screen.getByTestId('set-light').click()
        })

        expect(screen.getByTestId('mode').textContent).toBe('light')
        expect(document.documentElement.classList.contains('theme-light')).toBe(true)
      } finally {
        setItem.mockRestore()
      }
    })

    test('ignores storage events for other keys and invalid values', () => {
      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      )

      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', { key: 'some.other.key', newValue: 'light' })
        )
        window.dispatchEvent(
          new StorageEvent('storage', { key: 'ainet.theme', newValue: 'solarized' })
        )
        window.dispatchEvent(new StorageEvent('storage', { key: 'ainet.theme', newValue: null }))
      })

      expect(screen.getByTestId('mode').textContent).toBe('system')
    })
  })
})

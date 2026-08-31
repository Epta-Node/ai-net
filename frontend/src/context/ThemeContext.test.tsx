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
        removeEventListener: vi.fn((event: string, handler: (e: { matches: boolean }) => void) => {
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
    localStorage.setItem('theme-mode', 'light')

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
    expect(localStorage.getItem('theme-mode')).toBe('dark')

    const meta = document.querySelector('meta[name="theme-color"]')
    expect(meta?.getAttribute('content')).toBe('#0A0E14')

    // Switch to light
    act(() => {
      screen.getByTestId('set-light').click()
    })
    expect(screen.getByTestId('mode').textContent).toBe('light')
    expect(screen.getByTestId('effective').textContent).toBe('light')
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)
    expect(localStorage.getItem('theme-mode')).toBe('light')
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
          key: 'theme-mode',
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
          key: 'theme-mode',
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
})

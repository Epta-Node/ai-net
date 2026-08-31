import React, { createContext, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

export interface ThemeContextValue {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  effectiveTheme: 'light' | 'dark'
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  setMode: () => {},
  effectiveTheme: 'dark',
})

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('theme-mode')
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    } catch (e) {
      // ignore localStorage errors (e.g. sandboxed iframe or private browsing)
    }
    return 'system'
  })

  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  // Apply theme class to root, update meta theme-color, and persist preference
  useEffect(() => {
    const effective = mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode
    const root = document.documentElement

    if (effective === 'light') {
      root.classList.add('theme-light')
    } else {
      root.classList.remove('theme-light')
    }

    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', effective === 'light' ? '#FFFFFF' : '#0A0E14')
    }

    try {
      localStorage.setItem('theme-mode', mode)
    } catch (e) {
      // ignore
    }
  }, [mode, systemPrefersDark])

  // Cross-tab synchronization via storage event
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'theme-mode' && e.newValue) {
        if (e.newValue === 'light' || e.newValue === 'dark' || e.newValue === 'system') {
          setMode(e.newValue)
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  // Listen to system preference changes in real-time
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches)

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
    } else if (typeof (mql as any).addListener === 'function') {
      ;(mql as any).addListener(handler)
    }

    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', handler)
      } else if (typeof (mql as any).removeListener === 'function') {
        ;(mql as any).removeListener(handler)
      }
    }
  }, [])

  const effectiveTheme = mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode

  return (
    <ThemeContext.Provider value={{ mode, setMode, effectiveTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export default ThemeContext

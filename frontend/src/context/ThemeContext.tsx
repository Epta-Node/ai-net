import React, { createContext, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  effectiveTheme: 'light' | 'dark'
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'dark',
  setMode: () => {},
  effectiveTheme: 'dark',
})

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('theme-mode')
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    } catch (e) {
      // ignore
    }
    return 'dark'
  })

  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  // Apply theme class to root and persist preference
  useEffect(() => {
    const effective = mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode
    const root = document.documentElement
    if (effective === 'light') root.classList.add('theme-light')
    else root.classList.remove('theme-light')

    try {
      localStorage.setItem('theme-mode', mode)
    } catch (e) {
      // ignore
    }
  }, [mode, systemPrefersDark])

  // Listen to system preference changes
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

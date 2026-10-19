import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import { getTextDirection, i18nBaseOptions } from './options'

export { SUPPORTED_LANGUAGES, getTextDirection, isRtlLanguage } from './options'
export type { SupportedLanguage } from './options'

/**
 * Keeps `<html lang>` and `--text-direction` in sync with the active language.
 *
 * This lives here rather than in a layout component on purpose: the landing page
 * renders outside `AppShell`, so a component-level effect would leave the
 * attribute stale on `/`.
 */
export const syncDocumentLanguage = () => {
  if (typeof document === 'undefined') return
  const lang = i18n.resolvedLanguage ?? 'en'
  document.documentElement.lang = lang
  const dir = getTextDirection(lang)
  document.documentElement.setAttribute('dir', dir)
  document.documentElement.style.setProperty('--text-direction', dir)
}

const handleLanguageChanged = (lng: string) => {
  syncDocumentLanguage()
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem('ai-net-locale', lng)
      window.localStorage.setItem('i18nextLng', lng)
    } catch {
      // storage unavailable
    }
  }
}

i18n.on('languageChanged', handleLanguageChanged)

// Seed i18nextLng from ai-net-locale if present
if (typeof window !== 'undefined' && window.localStorage) {
  try {
    const stored = window.localStorage.getItem('ai-net-locale')
    if (stored && !window.localStorage.getItem('i18nextLng')) {
      window.localStorage.setItem('i18nextLng', stored)
    }
  } catch {
    // storage unavailable
  }
}

/**
 * Resolves once i18next is initialized.
 *
 * `main.tsx` awaits this before the first render so the app never paints raw
 * translation keys, which avoids needing a `<Suspense>` boundary at the root.
 */
export const i18nReady = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    ...i18nBaseOptions,
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'ai-net-locale',
    },
  })
  .then((t) => {
    syncDocumentLanguage()
    return t
  })

export default i18n

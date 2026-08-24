import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import { i18nBaseOptions } from './options'

export { SUPPORTED_LANGUAGES } from './options'
export type { SupportedLanguage } from './options'

/**
 * Keeps `<html lang>` in sync with the active language, for accessibility and SEO.
 *
 * This lives here rather than in a layout component on purpose: the landing page
 * renders outside `AppShell`, so a component-level effect would leave the
 * attribute stale on `/`. Using `resolvedLanguage` writes `zh` rather than the
 * detected `zh-CN`.
 */
const syncDocumentLanguage = () => {
  document.documentElement.lang = i18n.resolvedLanguage ?? 'en'
}

i18n.on('languageChanged', syncDocumentLanguage)

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
      lookupLocalStorage: 'i18nextLng',
    },
  })
  .then((t) => {
    syncDocumentLanguage()
    return t
  })

export default i18n

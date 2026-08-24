import type { InitOptions } from 'i18next'

import en from './locales/en.json'
import zh from './locales/zh.json'

export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/**
 * Options shared by the browser app and the vitest setup, so tests resolve keys
 * exactly the way the browser does.
 *
 * This module is deliberately side-effect free: importing it must never trigger
 * `i18n.init()`. The app adds the language detector on top of these options;
 * the test setup pins `lng` instead, keeping test runs deterministic.
 */
export const i18nBaseOptions: InitOptions = {
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGUAGES,
  // Without `languageOnly` a browser reporting `zh-CN` would not match the
  // `zh` bundle and would silently fall back to English.
  load: 'languageOnly',
  // Keys are a flat namespace (`page.dashboard.title`), so dots are literal.
  keySeparator: false,
  interpolation: {
    // React already escapes interpolated values.
    escapeValue: false,
  },
}

import type { InitOptions } from 'i18next';

import en from './locales/en.json';
import zh from './locales/zh.json';
import es from './locales/es.json';

export const SUPPORTED_LANGUAGES = ['en', 'zh', 'es'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

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
    es: { translation: es },
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
};

/** RTL languages list for layout direction calculation (#820) */
export const RTL_LANGUAGES: readonly string[] = ['ar', 'he', 'fa', 'ur'];

export const isRtlLanguage = (lng: string): boolean => {
  if (!lng) return false;
  const code = lng.split('-')[0].toLowerCase();
  return RTL_LANGUAGES.includes(code);
};

export const getTextDirection = (lng: string): 'rtl' | 'ltr' => {
  return isRtlLanguage(lng) ? 'rtl' : 'ltr';
};


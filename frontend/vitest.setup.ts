import '@testing-library/jest-dom/vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { i18nBaseOptions } from './src/i18n/options';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;

// Initialize i18next with the REAL translation resources, pinned to English, so
// component queries keep matching the literal English copy and no test needs a
// translation-aware wrapper.
//
// Deliberately not the app instance from `src/i18n`: that one uses the language
// detector, which would read jsdom's localStorage/navigator and make runs
// non-deterministic. Sharing `i18nBaseOptions` keeps key resolution identical.
//
// With inline `resources` and no backend plugin, `init()` is synchronous: `t()`
// returns real values on the very next line, so there is nothing to await here.
i18n.use(initReactI18next).init({
  ...i18nBaseOptions,
  lng: 'en',
});

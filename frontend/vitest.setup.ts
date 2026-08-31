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

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

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

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => {
    const parseMaxWidth = query.match(/max-width:\s*(\d+)px/)
    const parseMinWidth = query.match(/min-width:\s*(\d+)px/)
    const parseMaxHeight = query.match(/max-height:\s*(\d+)px/)
    const parseMinHeight = query.match(/min-height:\s*(\d+)px/)

    let matches = false
    if (parseMaxWidth) matches = window.innerWidth <= parseInt(parseMaxWidth[1])
    else if (parseMinWidth) matches = window.innerWidth >= parseInt(parseMinWidth[1])
    else if (parseMaxHeight) matches = window.innerHeight <= parseInt(parseMaxHeight[1])
    else if (parseMinHeight) matches = window.innerHeight >= parseInt(parseMinHeight[1])

    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }
  },
});

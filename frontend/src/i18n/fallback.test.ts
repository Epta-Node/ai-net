import { describe, it, expect } from 'vitest'
import i18next from 'i18next'

import { i18nBaseOptions } from './options'

// AC8 probe: en/zh are at full parity, so no real key exercises the fallback.
// This spins up a throwaway instance on the same options with a key present
// only in English, to prove `fallbackLng` actually resolves it.
describe('AC8 · fallback to English for missing keys', () => {
  it('resolves an en-only key while the active language is zh', async () => {
    const probe = i18next.createInstance()
    await probe.init({
      ...i18nBaseOptions,
      lng: 'zh',
      resources: {
        en: { translation: { 'probe.onlyInEnglish': 'English fallback value' } },
        zh: { translation: { 'probe.somethingElse': '别的' } },
      },
    })

    expect(probe.language).toBe('zh')
    expect(probe.t('probe.onlyInEnglish')).toBe('English fallback value')
  })

  it('returns the key itself when it is missing from both bundles', async () => {
    const probe = i18next.createInstance()
    await probe.init({ ...i18nBaseOptions, lng: 'zh', resources: { en: { translation: {} }, zh: { translation: {} } } })

    expect(probe.t('probe.nowhere')).toBe('probe.nowhere')
  })

  it('a zh-CN locale resolves against the zh bundle, not English', async () => {
    const probe = i18next.createInstance()
    await probe.init({
      ...i18nBaseOptions,
      lng: 'zh-CN',
      resources: {
        en: { translation: { 'probe.k': 'English' } },
        zh: { translation: { 'probe.k': '中文' } },
      },
    })

    expect(probe.resolvedLanguage).toBe('zh')
    expect(probe.t('probe.k')).toBe('中文')
  })
})

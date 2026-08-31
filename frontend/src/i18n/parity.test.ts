/**
 * i18n parity test — ensures en and zh bundles have identical key sets.
 *
 * Fails CI if:
 *   - A key exists in en.json but not zh.json (missing translation)
 *   - A key exists in zh.json but not en.json (stale translation)
 *
 * This guarantees zero untranslated UI strings in both directions.
 */
import { describe, it, expect } from 'vitest'
import en from './locales/en.json'
import zh from './locales/zh.json'

type NestedKeys<T, Prefix extends string = ''> = T extends Record<string, unknown>
  ? {
      [K in keyof T & string]: T[K] extends Record<string, unknown>
        ? NestedKeys<T[K], `${Prefix}${K}.`>
        : `${Prefix}${K}`
    }[keyof T & string]
  : never

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys
}

describe('i18n parity · en ↔ zh', () => {
  const enKeys = flattenKeys(en as Record<string, unknown>).sort()
  const zhKeys = flattenKeys(zh as Record<string, unknown>).sort()

  it('en.json has no keys missing from zh.json', () => {
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k))
    expect(missingInZh).toEqual([])
  })

  it('zh.json has no keys missing from en.json', () => {
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k))
    expect(missingInEn).toEqual([])
  })

  it('both bundles have the same number of keys', () => {
    expect(zhKeys.length).toBe(enKeys.length)
  })

  it('no duplicate keys within en.json', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const key of enKeys) {
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
    expect(duplicates).toEqual([])
  })

  it('no duplicate keys within zh.json', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const key of zhKeys) {
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
    expect(duplicates).toEqual([])
  })
})

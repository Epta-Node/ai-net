import { describe, it, expect } from 'vitest'
import { formatDate, formatDateTime, formatNumber, formatTime } from '@utils/format'

// Midday UTC, so the calendar date is the same in nearly every timezone.
const SAMPLE = '2026-08-22T12:00:00.000Z'

// The assertions below match *patterns* rather than exact strings on purpose:
// without a `timeZone` option these helpers use the machine's timezone, and
// pinning the hour would make the suite pass locally and fail in CI.
const EN_DATE = /^\d{1,2}\/\d{1,2}\/2026$/
const ZH_DATE = /^2026\/\d{1,2}\/\d{1,2}$/

describe('formatDate', () => {
  it('orders the parts by locale', () => {
    expect(formatDate(SAMPLE, 'en')).toMatch(EN_DATE)
    expect(formatDate(SAMPLE, 'zh')).toMatch(ZH_DATE)
    expect(formatDate(SAMPLE, 'en')).not.toBe(formatDate(SAMPLE, 'zh'))
  })

  it('accepts a Date, a string or a timestamp', () => {
    const expected = formatDate(SAMPLE, 'en')
    expect(formatDate(new Date(SAMPLE), 'en')).toBe(expected)
    expect(formatDate(Date.parse(SAMPLE), 'en')).toBe(expected)
  })
})

describe('formatDateTime', () => {
  it('includes the time and follows the locale', () => {
    expect(formatDateTime(SAMPLE, 'en')).toMatch(/^\d{1,2}\/\d{1,2}\/2026, \d{1,2}:\d{2}:\d{2}\s.M$/)
    expect(formatDateTime(SAMPLE, 'zh')).toMatch(/^2026\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('formatTime', () => {
  it('honours the precision the caller asks for', () => {
    const withSeconds = formatTime(SAMPLE, 'zh', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    expect(withSeconds).toMatch(/^\d{2}:\d{2}:\d{2}$/)

    const withoutSeconds = formatTime(SAMPLE, 'zh', { hour: '2-digit', minute: '2-digit' })
    expect(withoutSeconds).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('formatNumber', () => {
  it('groups digits using the locale separators', () => {
    expect(formatNumber(1234567, 'en')).toBe('1,234,567')
    // Not a language the app ships, but it proves the locale reaches Intl
    // instead of the helper always grouping the English way.
    expect(formatNumber(1234567, 'de')).toBe('1.234.567')
  })

  it('passes options through', () => {
    expect(formatNumber(0.5, 'en', { style: 'percent' })).toBe('50%')
  })
})

describe('invalid input', () => {
  // `Intl.DateTimeFormat.format()` throws on an invalid date, where the
  // `toLocaleString()` these helpers replaced returned "Invalid Date". A bad
  // timestamp from the API must not crash the render.
  it('falls back to the raw value for an unparseable date', () => {
    expect(formatDate('not-a-date', 'en')).toBe('not-a-date')
    expect(formatDateTime('not-a-date', 'en')).toBe('not-a-date')
    expect(formatTime('not-a-date', 'en', { hour: '2-digit' })).toBe('not-a-date')
  })

  // The locale reaches these helpers from the browser via the language
  // detector, so a malformed tag is possible and also throws in Intl.
  it('falls back to English for a malformed locale tag', () => {
    expect(formatDate(SAMPLE, 'en_US')).toMatch(EN_DATE)
    expect(formatNumber(1234567, 'en_US')).toBe('1,234,567')
  })

  it('does not try to format a non-finite number', () => {
    expect(formatNumber(Number.NaN, 'en')).toBe('NaN')
    expect(formatNumber(Number.POSITIVE_INFINITY, 'en')).toBe('Infinity')
  })
})

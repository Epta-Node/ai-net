/**
 * Locale-aware date and number formatting.
 *
 * These helpers take the locale as an argument instead of reading `i18n.language`
 * themselves, so they stay pure functions with no dependency on the i18n
 * instance: callers pass `i18n.language` from `useTranslation()`.
 *
 * They replace bare `toLocaleString()` / `toLocaleDateString()` calls, which
 * silently use the *browser's* locale and so ignored the language the user
 * picked in the switcher.
 */

const FALLBACK_LOCALE = 'en'

/** The option bags that reproduce the legacy `toLocale*` defaults exactly. */
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
}

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
}

/**
 * Constructing an `Intl` formatter is expensive relative to formatting with
 * one, and these run once per table row, so keep them keyed by locale+options.
 */
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()

/**
 * `Intl` throws a `RangeError` on a malformed language tag, and the locale
 * ultimately comes from the browser through the language detector, so it is not
 * guaranteed to be well formed. A bad tag must not take the page down.
 */
function getDateTimeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  const cached = dateTimeFormatters.get(key)
  if (cached) return cached

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat(locale, options)
  } catch {
    formatter = new Intl.DateTimeFormat(FALLBACK_LOCALE, options)
  }
  dateTimeFormatters.set(key, formatter)
  return formatter
}

function getNumberFormatter(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options ?? {})}`
  const cached = numberFormatters.get(key)
  if (cached) return cached

  let formatter: Intl.NumberFormat
  try {
    formatter = new Intl.NumberFormat(locale, options)
  } catch {
    formatter = new Intl.NumberFormat(FALLBACK_LOCALE, options)
  }
  numberFormatters.set(key, formatter)
  return formatter
}

export type DateInput = Date | string | number

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

/**
 * Unlike `date.toLocaleString()`, which returns the string `"Invalid Date"`,
 * `Intl.DateTimeFormat.format()` *throws* on an invalid date. The API can send a
 * malformed timestamp, so every formatter below goes through this guard and
 * falls back to showing the raw value rather than crashing the render.
 */
function formatDateWith(
  value: DateInput,
  locale: string,
  options: Intl.DateTimeFormatOptions
): string {
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) {
    return typeof value === 'string' ? value : String(value)
  }
  return getDateTimeFormatter(locale, options).format(date)
}

/** Date and time, matching the shape `toLocaleString()` used to produce. */
export function formatDateTime(value: DateInput, locale: string): string {
  return formatDateWith(value, locale, DATE_TIME_OPTIONS)
}

/** Date only, matching the shape `toLocaleDateString()` used to produce. */
export function formatDate(value: DateInput, locale: string): string {
  return formatDateWith(value, locale, DATE_OPTIONS)
}

/** Time only. Callers pass the precision they want (hour/minute/second). */
export function formatTime(
  value: DateInput,
  locale: string,
  options: Intl.DateTimeFormatOptions
): string {
  return formatDateWith(value, locale, options)
}

/**
 * Grouped number formatting.
 *
 * Deliberately not used for XLM amounts: Stellar balances are fixed-precision
 * (7 decimals) and grouping or rounding them would be wrong for the domain.
 */
export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) return String(value)
  return getNumberFormatter(locale, options).format(value)
}

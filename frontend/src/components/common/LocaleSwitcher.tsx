import React from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../../i18n/options'

export interface LocaleOption {
  code: SupportedLanguage
  label: string
  flag: string
}

export const LOCALE_OPTIONS: Record<SupportedLanguage, LocaleOption> = {
  en: { code: 'en', label: 'English', flag: '🇬🇧' },
  zh: { code: 'zh', label: '中文', flag: '🇨🇳' },
  es: { code: 'es', label: 'Español', flag: '🇪🇸' },
}

interface LocaleSwitcherProps {
  className?: string
  id?: string
}

export const LocaleSwitcher: React.FC<LocaleSwitcherProps> = ({
  className = '',
  id = 'locale-switcher-dropdown',
}) => {
  const { i18n, t } = useTranslation()
  const currentLang = (i18n.resolvedLanguage ?? 'en') as SupportedLanguage

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextLang = e.target.value as SupportedLanguage
    void i18n.changeLanguage(nextLang)
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem('ai-net-locale', nextLang)
        window.localStorage.setItem('i18nextLng', nextLang)
      } catch {
        // storage unavailable
      }
    }
  }

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <label htmlFor={id} className="sr-only">
        {t('a11y.languageSwitcher', 'Language')}
      </label>
      <select
        id={id}
        data-testid="locale-switcher"
        value={currentLang}
        onChange={handleLanguageChange}
        className="cursor-pointer appearance-none rounded-md border border-[var(--border-subtle,#2e2e2e)] bg-[var(--surface-sunken,#161616)] py-1.5 pl-3 pr-8 text-sm font-medium text-[var(--text-primary,#fff)] focus:outline-none focus:ring-1 focus:ring-[var(--primary,#9333ea)]"
        aria-label={t('a11y.languageSwitcher', 'Language')}
      >
        {SUPPORTED_LANGUAGES.map((lang) => {
          const opt = LOCALE_OPTIONS[lang]
          return (
            <option key={lang} value={lang}>
              {opt.flag} {opt.label}
            </option>
          )
        })}
      </select>
      <span
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted,#888)]"
        aria-hidden="true"
      >
        ▼
      </span>
    </div>
  )
}

export default LocaleSwitcher

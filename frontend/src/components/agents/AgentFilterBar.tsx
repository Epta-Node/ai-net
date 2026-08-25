import { useTranslation, Trans } from 'react-i18next'
import { RotateCw, X } from 'lucide-react'
import type { AgentFilters, StatusFilter } from '../../utils/agentRegistry'
import styles from './AgentFilterBar.module.css'

interface AgentFilterBarProps {
  filters: AgentFilters
  /** All capabilities available across the dataset. */
  availableCapabilities: string[]
  /** [min, max] price across the dataset, used to bound the slider. */
  priceDomain: [number, number]
  onChange: (next: Partial<AgentFilters>) => void
  onReset: () => void
  onRefresh: () => void
}

export function AgentFilterBar({
  filters,
  availableCapabilities,
  priceDomain,
  onChange,
  onReset,
  onRefresh,
}: AgentFilterBarProps) {
  const { t } = useTranslation()

  // Shares the agent.status.* keys with the table and the detail modal, so the
  // filter labels and the status badges can never drift apart.
  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: t('agent.filters.all') },
    { value: 'active', label: t('agent.status.active') },
    { value: 'inactive', label: t('agent.status.inactive') },
  ]

  const [domainMin, domainMax] = priceDomain
  const effectiveMax = filters.priceMax ?? domainMax

  const toggleCapability = (cap: string) => {
    const selected = filters.capabilities.includes(cap)
    onChange({
      capabilities: selected
        ? filters.capabilities.filter((c) => c !== cap)
        : [...filters.capabilities, cap],
    })
  }

  const hasActiveFilters =
    filters.capabilities.length > 0 ||
    filters.priceMin != null ||
    filters.priceMax != null ||
    filters.status !== 'all' ||
    filters.sortKey != null

  return (
    <div className={styles.bar}>
      <div className={styles.group}>
        <span className={styles.groupLabel}>{t('common.capabilities')}</span>
        <div className={styles.capList} role="group" aria-label={t('a11y.filterByCapability')}>
          {availableCapabilities.length === 0 ? (
            <span className={styles.muted}>{t('common.none')}</span>
          ) : (
            availableCapabilities.map((cap) => {
              const selected = filters.capabilities.includes(cap)
              return (
                <button
                  key={cap}
                  type="button"
                  className={`${styles.capChip} ${selected ? styles.capChipActive : ''}`}
                  aria-pressed={selected}
                  onClick={() => toggleCapability(cap)}
                >
                  {cap}
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>
          <Trans
            i18nKey="agent.filters.maxPrice"
            values={{ price: effectiveMax.toFixed(2) }}
            components={[<strong key="price" />]}
          />
        </span>
        <input
          type="range"
          className={styles.slider}
          min={domainMin}
          max={domainMax}
          step={0.01}
          value={effectiveMax}
          aria-label={t('a11y.maximumPrice')}
          disabled={domainMax <= domainMin}
          onChange={(e) => {
            const v = Number(e.target.value)
            onChange({ priceMax: v >= domainMax ? null : v })
          }}
        />
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>{t('common.status')}</span>
        <div className={styles.toggle} role="group" aria-label={t('a11y.filterByStatus')}>
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`${styles.toggleButton} ${
                filters.status === opt.value ? styles.toggleButtonActive : ''
              }`}
              aria-pressed={filters.status === opt.value}
              onClick={() => onChange({ status: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.iconAction}
          onClick={onRefresh}
          title={t('a11y.refreshNow')}
          aria-label={t('a11y.refreshNow')}
        >
          <RotateCw size={14} />
        </button>
        {hasActiveFilters && (
          <button type="button" className={styles.resetButton} onClick={onReset}>
            <X size={14} />
            {t('common.clear')}
          </button>
        )}
      </div>
    </div>
  )
}

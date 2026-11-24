import React from 'react'
import { useTranslation } from 'react-i18next'
import { Skeleton, SkeletonText } from './Skeleton'
import styles from './RouteLoader.module.css'

/**
 * Suspense fallback shown while a lazily-loaded route chunk is fetched.
 * Colours, radii and spacing come from design tokens (via Skeleton and
 * RouteLoader.module.css) so it follows the active theme.
 */
const RouteLoader: React.FC = () => {
  const { t } = useTranslation()

  return (
    <div
      className={styles.container}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={t('a11y.loadingPage')}
      data-testid="route-loader"
    >
      <div className={styles.content}>
        <Skeleton height="1rem" />
        <SkeletonText lines={3} height="0.75rem" />
      </div>
    </div>
  )
}

export default RouteLoader

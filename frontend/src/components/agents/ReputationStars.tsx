import { Star } from 'lucide-react'
import styles from './AgentTable.module.css'

interface ReputationStarsProps {
  /** Reputation score on a 0-5 scale. */
  value: number
}

/**
 * Renders a 0-5 star reputation rating. Each whole point fills a star; a
 * fractional remainder fills the next star proportionally via a clip overlay.
 */
export function ReputationStars({ value }: ReputationStarsProps) {
  const clamped = Math.max(0, Math.min(5, value))
  const label = `${clamped.toFixed(1)} out of 5`

  return (
    <span
      className={styles.stars}
      role="img"
      aria-label={label}
      title={label}
      data-testid="reputation-stars"
    >
      {Array.from({ length: 5 }, (_, i) => {
        const fill = Math.max(0, Math.min(1, clamped - i))
        return (
          <span key={i} className={styles.starWrap}>
            <Star size={14} className={styles.starBg} aria-hidden="true" />
            {fill > 0 && (
              <span className={styles.starFill} style={{ width: `${fill * 100}%` }}>
                <Star size={14} className={styles.starFg} aria-hidden="true" />
              </span>
            )}
          </span>
        )
      })}
      <span className={styles.starValue}>{clamped.toFixed(1)}</span>
    </span>
  )
}

import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import styles from './AccessibleChart.module.css'

export interface AccessibleChartPoint {
  label: string
  value: string
  detail?: string
}

interface AccessibleChartProps {
  label: string
  points: readonly AccessibleChartPoint[]
  children: ReactNode
}

/**
 * Gives SVG charts a single predictable tab stop and exposes every data point
 * through arrow-key navigation. The companion tooltip can also receive focus,
 * which keeps its value available to keyboard and screen-reader users.
 */
export function AccessibleChart({ label, points, children }: AccessibleChartProps) {
  const instructionsId = useId()
  const [activeIndex, setActiveIndex] = useState(0)
  const [hasFocus, setHasFocus] = useState(false)
  const activePoint = points[activeIndex]

  const moveTo = (index: number) => {
    if (points.length === 0) return
    setActiveIndex((index + points.length) % points.length)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        moveTo(activeIndex + 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        moveTo(activeIndex - 1)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(Math.max(points.length - 1, 0))
        break
    }
  }

  return (
    <div
      className={styles.chart}
      role="group"
      aria-label={label}
      aria-describedby={instructionsId}
      tabIndex={points.length > 0 ? 0 : -1}
      onFocus={() => setHasFocus(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHasFocus(false)
      }}
      onKeyDown={handleKeyDown}
    >
      <span id={instructionsId} className="sr-only">
        Use arrow keys to explore chart values. Press Home or End to jump to the first or last value.
      </span>
      {children}
      {hasFocus && activePoint && (
        <div className={styles.tooltip} role="status" aria-live="polite" tabIndex={0}>
          <span className={styles.tooltipLabel}>{activePoint.label}</span>
          <strong className={styles.tooltipValue}>{activePoint.value}</strong>
          {activePoint.detail && <span className={styles.tooltipDetail}>{activePoint.detail}</span>}
        </div>
      )}
    </div>
  )
}

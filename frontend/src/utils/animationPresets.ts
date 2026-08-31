/**
 * Shared Framer Motion animation presets (#422).
 *
 * Import from here instead of defining inline variants — keeps motion values
 * consistent across components and makes global timing tweaks a one-line change.
 *
 * Usage:
 *   import { fadeUp, stagger, listItem } from '../../utils/animationPresets'
 *   <motion.div variants={fadeUp} initial="hidden" animate="visible" />
 */

import type { Variants } from 'framer-motion'

// ─── Fade + slide up ─────────────────────────────────────────────────────────

/** Fade in while sliding up ~20px. Works standalone or as a stagger child. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
}

/** Slightly larger vertical travel (30px). Good for section-level entrances. */
export const fadeUpLg: Variants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: 'easeOut' } },
}

// ─── Stagger containers ───────────────────────────────────────────────────────

/**
 * Container that staggers its children by 80ms.
 * Pair with `listItem` on each child.
 */
export const stagger: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0 },
  },
}

/**
 * Container with a delayed entrance (400ms) — matches the StatsBar pattern
 * where the section should appear after the hero has settled.
 */
export const staggerDelayed: Variants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: 0.4, staggerChildren: 0.08 },
  },
}

// ─── List item ────────────────────────────────────────────────────────────────

/** Child variant for use inside a `stagger` container. */
export const listItem: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
}

// ─── Pop / scale ─────────────────────────────────────────────────────────────

/** Scale up from 90% with a fade. Good for modals, tooltips, popovers. */
export const pop: Variants = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } },
}

// ─── Slide ────────────────────────────────────────────────────────────────────

/** Slide in from the right (e.g. drawers, side panels). */
export const slideFromRight: Variants = {
  hidden: { x: '100%', opacity: 0 },
  visible: { x: 0, opacity: 1, transition: { type: 'spring', damping: 30, stiffness: 400, duration: 0.18 } },
  exit: { x: '100%', opacity: 0, transition: { duration: 0.15 } },
}

/** Slide in from the bottom (e.g. mobile drawers). */
export const slideFromBottom: Variants = {
  hidden: { y: '100%' },
  visible: { y: 0, transition: { type: 'spring', damping: 30, stiffness: 400, duration: 0.18 } },
  exit: { y: '100%', transition: { duration: 0.15 } },
}

// ─── Backdrop ────────────────────────────────────────────────────────────────

/** Semi-transparent overlay fade. */
export const backdrop: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
}

// ─── Card hover ──────────────────────────────────────────────────────────────

/**
 * Per-card entrance for index-staggered lists. Call with the item index:
 *
 *   <motion.div
 *     variants={cardEntrance(index)}
 *     initial="hidden"
 *     whileInView="visible"
 *     viewport={{ once: true, margin: '-30px' }}
 *   />
 */
export function cardEntrance(index: number): Variants {
  return {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.4, delay: index * 0.08, ease: 'easeOut' },
    },
  }
}

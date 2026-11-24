/**
 * Shared Skeleton kit (#719).
 *
 * Canonical placeholder primitives. `Skeleton`, `SkeletonText`,
 * `SkeletonCard`, `SkeletonTable` (plus `SkeletonAvatar`) live in
 * `components/common/Skeleton.tsx` and are re-exported here so new code has
 * a single import path; `SkeletonChart` is defined in this folder.
 *
 * Do NOT hand-roll `animate-pulse` skeleton markup in pages — compose this kit
 * instead. Shimmer already respects `prefers-reduced-motion` via
 * `Skeleton.module.css`.
 */
export {
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonTable,
  SkeletonAvatar,
  SkeletonDashboard,
  SkeletonTaskDetail,
} from '../../common/Skeleton';
export type {
  SkeletonVariant,
  SkeletonProps,
  SkeletonTextProps,
  SkeletonCardProps,
  SkeletonAvatarProps,
  SkeletonTableProps,
} from '../../common/Skeleton';
export { SkeletonChart } from './SkeletonChart';
export type { SkeletonChartProps } from './SkeletonChart';

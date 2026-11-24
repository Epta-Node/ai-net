import React from 'react';
import { MotionConfig, useReducedMotion } from 'framer-motion';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

interface MotionProviderProps {
  children: React.ReactNode;
}

/**
 * Global reduced-motion boundary (#721).
 *
 * `MotionConfig reducedMotion="user"` makes every `motion.*` component and
 * `useSpring`/`useAnimate` below it honour the OS "reduce motion" setting
 * automatically — page transitions, toast/notification entrances, drawer
 * slides, KPI hover lifts, and DAG tooltips all freeze without touching
 * each call site. The exported `useMotionSafe()` hook covers JS-driven
 * effects (counters, typing) that MotionConfig cannot freeze.
 */
export const MotionProvider: React.FC<MotionProviderProps> = ({ children }) => (
  <MotionConfig reducedMotion="user" transition={{ duration: 0.15 }}>
    {children}
  </MotionConfig>
);

/** True when non-essential animation must be skipped. */
export function useMotionSafe(): boolean {
  // framer-motion's own signal (follows MotionConfig) OR our media-query hook
  // (covers non-motion paths and jsdom where MotionConfig is mocked).
  const framerReduced = useReducedMotion() ?? false;
  const mediaReduced = usePrefersReducedMotion();
  return framerReduced || mediaReduced;
}

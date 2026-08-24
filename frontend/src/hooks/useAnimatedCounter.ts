// src/hooks/useAnimatedCounter.ts
import { useSpring, useTransform, MotionValue } from 'framer-motion';
import { useEffect } from 'react';

interface UseAnimatedCounterOptions {
  /** Spring stiffness (default 100) */
  stiffness?: number;
  /** Spring damping (default 20) */
  damping?: number;
  /** Duration in ms (used with easeOut, default 800) */
  duration?: number;
}

/**
 * Animates a numeric value using framer-motion spring animation.
 * Returns a MotionValue<number> that can be used in components.
 */
export function useAnimatedCounter(
  target: number,
  options: UseAnimatedCounterOptions = {}
): MotionValue<number> {
  const { stiffness = 100, damping = 20 } = options;

  const spring = useSpring(0, {
    stiffness,
    damping,
    duration: 800,
  });

  useEffect(() => {
    spring.set(target);
  }, [target, spring]);

  return useTransform(spring, (v: number) => Math.round(v));
}
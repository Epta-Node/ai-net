// src/hooks/useAnimatedCounter.ts
import { useReducedMotion, useSpring, useMotionValueEvent } from 'framer-motion';
import { useEffect, useState } from 'react';

interface UseAnimatedCounterOptions {
  /** Spring stiffness (default 100) */
  stiffness?: number;
  /** Spring damping (default 20) */
  damping?: number;
}

/**
 * Animates a numeric value using a framer-motion spring, returning a
 * plain React state number so it can be safely rendered as text.
 * Starts from the previous value on updates, avoiding layout shift.
 *
 * Honours `prefers-reduced-motion` (#721): when reduced motion is
 * requested the target is rendered immediately with no spring.
 */
export function useAnimatedCounter(
  target: number,
  options: UseAnimatedCounterOptions = {}
): number {
  const { stiffness = 80, damping = 18 } = options;
  const reduceMotion = useReducedMotion() ?? false;

  const spring = useSpring(reduceMotion ? target : 0, { stiffness, damping });
  const [display, setDisplay] = useState(reduceMotion ? target : 0);

  useEffect(() => {
    if (reduceMotion) {
      setDisplay(target);
      return;
    }
    spring.set(target);
  }, [target, spring, reduceMotion]);

  useMotionValueEvent(spring, 'change', (v) => {
    setDisplay(Math.round(v));
  });

  return display;
}

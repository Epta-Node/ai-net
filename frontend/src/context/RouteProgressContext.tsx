/**
 * RouteProgressContext
 *
 * Provides a lightweight imperative API (`start` / `done` / `error`) used by:
 *   - useRouteProgress  – listens to React Router location changes
 *   - api.ts            – wraps every fetch call
 *
 * The bar value is intentionally a *percentage* (0–100) so callers never have
 * to think about timing; the component handles the visual easing internally.
 */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

interface RouteProgressContextValue {
  /** 0–100, or -1 when hidden */
  value: number;
  isError: boolean;
  start: () => void;
  done: () => void;
  error: () => void;
}

const RouteProgressContext = createContext<RouteProgressContextValue | null>(null);

export const useRouteProgressContext = (): RouteProgressContextValue => {
  const ctx = useContext(RouteProgressContext);
  if (!ctx) throw new Error('useRouteProgressContext must be used inside <RouteProgressProvider>');
  return ctx;
};

/** Tracks in-flight fetch count so overlapping requests keep the bar alive. */
let inflightCount = 0;

/** Module-level reference to the context actions (set after first render). */
let _start: (() => void) | null = null;
let _done: (() => void) | null = null;
let _error: (() => void) | null = null;

/** Called by api.ts before a fetch. */
export const progressStart = () => {
  inflightCount++;
  _start?.();
};

/** Called by api.ts after a fetch resolves (success or non-error). */
export const progressDone = () => {
  inflightCount = Math.max(0, inflightCount - 1);
  if (inflightCount === 0) _done?.();
};

/** Called by api.ts after a fetch rejects. */
export const progressError = () => {
  inflightCount = Math.max(0, inflightCount - 1);
  if (inflightCount === 0) _error?.();
};

export const RouteProgressProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // -1 = hidden, 0-100 = visible
  const [value, setValue] = useState<number>(-1);
  const [isError, setIsError] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (hideRef.current) { clearTimeout(hideRef.current); hideRef.current = null; }
  }, []);

  const start = useCallback(() => {
    clearTimers();
    setIsError(false);
    setValue(10);

    // Trickle toward 90 % while work is in progress
    tickRef.current = setInterval(() => {
      setValue((v) => {
        if (v >= 90) { clearInterval(tickRef.current!); tickRef.current = null; return v; }
        // Progressively slower increments (NProgress style)
        const step = v < 30 ? 5 : v < 60 ? 3 : v < 80 ? 1 : 0.5;
        return Math.min(v + step, 90);
      });
    }, 200);
  }, [clearTimers]);

  const done = useCallback(() => {
    clearTimers();
    setValue(100);
    hideRef.current = setTimeout(() => setValue(-1), 400);
  }, [clearTimers]);

  const error = useCallback(() => {
    clearTimers();
    setIsError(true);
    setValue(100);
    hideRef.current = setTimeout(() => {
      setValue(-1);
      setIsError(false);
    }, 600);
  }, [clearTimers]);

  // Expose to module-level helpers used by api.ts
  _start = start;
  _done = done;
  _error = error;

  return (
    <RouteProgressContext.Provider value={{ value, isError, start, done, error }}>
      {children}
    </RouteProgressContext.Provider>
  );
};

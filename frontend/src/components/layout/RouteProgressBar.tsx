/**
 * RouteProgressBar
 *
 * A fixed, top-of-viewport loading bar (NProgress style).
 * Consumes RouteProgressContext for its value; driven by:
 *   – useRouteProgress hook (route changes)
 *   – progressStart / progressDone / progressError helpers (fetch calls)
 */
import React from 'react';
import { useRouteProgressContext } from '../../context/RouteProgressContext';
import styles from './RouteProgressBar.module.css';

const RouteProgressBar: React.FC = () => {
  const { value, isError } = useRouteProgressContext();
  const visible = value >= 0;

  return (
    <div
      className={[
        styles.track,
        visible ? styles.visible : styles.hidden,
        isError ? styles.error : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={visible ? value : undefined}
      aria-label="Page loading"
      aria-hidden={!visible}
    >
      <div
        className={styles.bar}
        style={{ transform: `scaleX(${visible ? value / 100 : 0})` }}
      />
      {/* Glow puck at the leading edge */}
      {visible && !isError && <div className={styles.puck} style={{ left: `${value}%` }} />}
    </div>
  );
};

export default RouteProgressBar;

import React from 'react';

/**
 * Maps a series onto an SVG polyline inside a `width` × `height` box. A flat
 * series sits on the middle line; a single point is drawn as a flat line.
 */
export function sparklinePoints(data: number[], width: number, height: number): string {
  if (data.length === 0) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;
  const step = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data.map((v, i) => {
    const y = range === 0 ? height / 2 : height - ((v - min) / range) * height;
    return `${+(i * step).toFixed(2)},${+y.toFixed(2)}`;
  });
  return data.length === 1 ? `0,${height / 2} ${width},${height / 2}` : points.join(' ');
}

interface SparklineProps {
  data: number[];
  height?: number;
  stroke?: string;
}

const VIEW_WIDTH = 100;

/** Lightweight trend line, plain SVG with no charting library. */
export const Sparkline: React.FC<SparklineProps> = ({
  data,
  height = 40,
  stroke = 'var(--color-accent, #8884d8)',
}) => {
  if (data.length === 0) return null;
  const points = sparklinePoints(data, VIEW_WIDTH, height);
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

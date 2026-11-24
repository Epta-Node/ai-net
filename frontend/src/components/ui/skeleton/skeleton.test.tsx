import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SkeletonChart } from './SkeletonChart';
import { Skeleton, SkeletonText, SkeletonCard, SkeletonTable } from './index';

describe('SkeletonChart', () => {
  it('renders the requested number of bars', () => {
    render(<SkeletonChart bars={8} />);
    expect(screen.getAllByTestId('skeleton-chart-bar')).toHaveLength(8);
  });

  it('is aria-hidden and deterministic', () => {
    const { rerender } = render(<SkeletonChart bars={5} />);
    const first = screen.getAllByTestId('skeleton-chart-bar').map((el) => el.getAttribute('style'));
    rerender(<SkeletonChart bars={5} />);
    const second = screen.getAllByTestId('skeleton-chart-bar').map((el) => el.getAttribute('style'));
    expect(first).toEqual(second);
    expect(screen.getByTestId('skeleton-chart')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('skeleton kit re-exports', () => {
  it('exposes the shared primitives from a single entrypoint', () => {
    expect(Skeleton).toBeDefined();
    expect(SkeletonText).toBeDefined();
    expect(SkeletonCard).toBeDefined();
    expect(SkeletonTable).toBeDefined();
    expect(SkeletonChart).toBeDefined();
  });
});

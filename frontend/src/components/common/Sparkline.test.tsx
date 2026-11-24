import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Sparkline, sparklinePoints } from './Sparkline';

describe('sparklinePoints', () => {
  it('spreads points across the width and scales to the height', () => {
    expect(sparklinePoints([0, 5, 10], 100, 40)).toBe('0,40 50,20 100,0');
  });

  it('draws a flat series on the middle line', () => {
    expect(sparklinePoints([3, 3, 3], 100, 40)).toBe('0,20 50,20 100,20');
  });

  it('draws a single value as a flat line', () => {
    expect(sparklinePoints([7], 100, 40)).toBe('0,20 100,20');
  });

  it('returns nothing for an empty series', () => {
    expect(sparklinePoints([], 100, 40)).toBe('');
  });
});

describe('Sparkline', () => {
  it('renders a 7 day series as one polyline', () => {
    const { container } = render(<Sparkline data={[1, 2, 3, 2, 4, 5, 3]} />);
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
  });

  it('renders nothing without data', () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

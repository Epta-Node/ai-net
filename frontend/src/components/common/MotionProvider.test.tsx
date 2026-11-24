import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MotionProvider, useMotionSafe } from './MotionProvider';

function Probe(): React.JSX.Element {
  const reduced = useMotionSafe();
  return <div data-testid="probe">{reduced ? 'reduced' : 'full'}</div>;
}

describe('MotionProvider', () => {
  it('renders children inside the reduced-motion boundary', () => {
    render(
      <MotionProvider>
        <span data-testid="child">hello</span>
      </MotionProvider>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('reports full motion when the OS does not request it', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })),
    });
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('full');
  });

  it('reports reduced motion when the OS requests it', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })),
    });
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('reduced');
  });
});

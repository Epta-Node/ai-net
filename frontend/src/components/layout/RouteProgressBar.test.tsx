import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { RouteProgressProvider, useRouteProgressContext } from '../../../src/context/RouteProgressContext';
import RouteProgressBar from '../../../src/components/layout/RouteProgressBar';
import { useRouteProgress } from '../../../src/hooks/useRouteProgress';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mounts the bar inside a provider + router so we can test navigation. */
function BarFixture({ initialPath = '/' }: { initialPath?: string }) {
  return (
    <RouteProgressProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <RouteProgressBar />
        <RouteProgressBarTestRoutes />
      </MemoryRouter>
    </RouteProgressProvider>
  );
}

function RouteProgressBarTestRoutes() {
  useRouteProgress();
  return (
    <Routes>
      <Route path="/" element={<div>home</div>} />
      <Route path="/about" element={<div>about</div>} />
    </Routes>
  );
}

// ---------------------------------------------------------------------------
// RouteProgressBar rendering
// ---------------------------------------------------------------------------

describe('RouteProgressBar', () => {
  it('renders a progressbar role element', () => {
    render(
      <RouteProgressProvider>
        <MemoryRouter>
          <RouteProgressBar />
        </MemoryRouter>
      </RouteProgressProvider>
    );
    // aria-hidden when idle; query with hidden:true so the element is still found
    expect(screen.getByRole('progressbar', { hidden: true })).toBeInTheDocument();
  });

  it('is aria-hidden when no progress is active', () => {
    render(
      <RouteProgressProvider>
        <MemoryRouter>
          <RouteProgressBar />
        </MemoryRouter>
      </RouteProgressProvider>
    );
    expect(screen.getByRole('progressbar', { hidden: true })).toHaveAttribute('aria-hidden', 'true');
  });
});

// ---------------------------------------------------------------------------
// RouteProgressContext imperative API
// ---------------------------------------------------------------------------

describe('RouteProgressContext', () => {
  it('exposes start / done / error without throwing', () => {
    let ctx: ReturnType<typeof useRouteProgressContext> | null = null;
    function Capture() {
      ctx = useRouteProgressContext();
      return null;
    }
    render(
      <RouteProgressProvider>
        <Capture />
      </RouteProgressProvider>
    );
    expect(ctx).not.toBeNull();
    expect(() => {
      act(() => ctx!.start());
      act(() => ctx!.done());
    }).not.toThrow();
  });

  it('sets value to 100 after done()', () => {
    let ctx: ReturnType<typeof useRouteProgressContext> | null = null;
    function Capture() {
      ctx = useRouteProgressContext();
      return null;
    }
    render(
      <RouteProgressProvider>
        <Capture />
      </RouteProgressProvider>
    );
    act(() => ctx!.start());
    act(() => ctx!.done());
    expect(ctx!.value).toBe(100);
  });

  it('sets isError after error()', () => {
    let ctx: ReturnType<typeof useRouteProgressContext> | null = null;
    function Capture() {
      ctx = useRouteProgressContext();
      return null;
    }
    render(
      <RouteProgressProvider>
        <Capture />
      </RouteProgressProvider>
    );
    act(() => ctx!.error());
    expect(ctx!.isError).toBe(true);
  });
});

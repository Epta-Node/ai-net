/**
 * Per-type icon coverage for the toast stack (#622).
 *
 * `Toast.test.tsx` cannot assert on icons: three of its cases query by
 * `element.textContent`, which matches every ancestor of the message, so
 * `getByText` throws "multiple elements" before reaching any icon
 * assertion. This suite covers the icons directly.
 *
 * The assertions compare the rendered `<path>` data against the corresponding
 * Lucide component rendered on its own, rather than matching a CSS class —
 * Lucide renames its classes between releases (`CheckCircle` renders as
 * `lucide-circle-check-big` in 0.469), so class names are not a stable
 * contract, but the glyph geometry is.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AlertTriangle, CheckCircle, Info, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ToastProvider, useToast, type ToastType } from '../../context/ToastContext';

const CASES: ReadonlyArray<{ type: ToastType; Icon: LucideIcon }> = [
  { type: 'success', Icon: CheckCircle },
  { type: 'error', Icon: XCircle },
  { type: 'warning', Icon: AlertTriangle },
  { type: 'info', Icon: Info },
];

function Harness({ type }: { type: ToastType }) {
  const { showToast } = useToast();
  return <button onClick={() => showToast('Body copy', type)}>Show {type} toast</button>;
}

/** Ordered `d` attributes of every `<path>` in the icon rendered inside `host`. */
function glyph(host: Element | null): string[] {
  return Array.from(host?.querySelectorAll('svg path') ?? []).map(
    (path) => path.getAttribute('d') ?? '',
  );
}

/** The same measurement, taken from a bare render of the Lucide component. */
function glyphOfIcon(Icon: LucideIcon): string[] {
  const { container, unmount } = render(<Icon />);
  const measured = glyph(container);
  unmount();
  return measured;
}

describe('Toast icons', () => {
  it.each(CASES)('renders the matching icon for a $type toast', ({ type, Icon }) => {
    render(
      <ToastProvider>
        <Harness type={type} />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: `Show ${type} toast` }));

    const slot = screen.getByTestId(`toast-icon-${type}`);
    expect(slot).toBeInTheDocument();
    expect(glyph(slot)).toEqual(glyphOfIcon(Icon));
  });

  it('uses four visually distinct icons', () => {
    // Guards the per-type case above from passing trivially: it compares the
    // toast's glyph against whatever the map points at, so a map that sent two
    // types to the same icon would still go green. This pins the expectation
    // that the four targets really are different glyphs.
    for (const { type, Icon: a } of CASES) {
      expect(glyphOfIcon(a).length).toBeGreaterThan(0);
      for (const { type: otherType, Icon: b } of CASES) {
        if (otherType === type) continue;
        expect(glyphOfIcon(a)).not.toEqual(glyphOfIcon(b));
      }
    }
  });

  it('keeps the icon decorative so it is not announced twice', () => {
    render(
      <ToastProvider>
        <Harness type="success" />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show success toast' }));

    const icon = screen.getByTestId('toast-icon-success').querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('labels the icon slot with the toast type', () => {
    render(
      <ToastProvider>
        <Harness type="warning" />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show warning toast' }));

    const slot = screen.getByTestId('toast-icon-warning');
    expect(slot).toHaveClass('toast__icon');
    expect(slot).toHaveClass('toast__icon--warning');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AgentsPageSkeleton } from './AgentsPageSkeleton';

describe('AgentsPageSkeleton', () => {
  it('renders the filter, card grid and table placeholders', () => {
    render(<AgentsPageSkeleton />);

    const skeleton = screen.getByTestId('agents-page-skeleton');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveAccessibleName('Loading agent registry');
    expect(screen.getAllByTestId('agents-skeleton-card')).toHaveLength(6);
    expect(screen.getAllByTestId('agents-skeleton-row')).toHaveLength(5);
  });

  it('honours custom card and row counts', () => {
    render(<AgentsPageSkeleton cards={3} rows={2} />);

    expect(screen.getAllByTestId('agents-skeleton-card')).toHaveLength(3);
    expect(screen.getAllByTestId('agents-skeleton-row')).toHaveLength(2);
  });

  it('supports a custom test id', () => {
    render(<AgentsPageSkeleton data-testid="custom-agents-skeleton" />);

    expect(screen.getByTestId('custom-agents-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('agents-page-skeleton')).not.toBeInTheDocument();
  });
});

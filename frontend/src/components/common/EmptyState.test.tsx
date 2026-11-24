import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { Inbox, Plus } from 'lucide-react';
import { EmptyState } from './EmptyState';

describe('EmptyState Component', () => {
  it('renders title and description correctly', () => {
    render(
      <MemoryRouter>
        <EmptyState
          title="No items found"
          description="Try creating a new item to get started."
          icon={<Inbox size={32} data-testid="inbox-icon" />}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('No items found')).toBeInTheDocument();
    expect(screen.getByText('Try creating a new item to get started.')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-icon')).toBeInTheDocument();
  });

  it('triggers primary and secondary CTA callbacks when clicked', () => {
    const handlePrimary = vi.fn();
    const handleSecondary = vi.fn();

    render(
      <MemoryRouter>
        <EmptyState
          title="Empty list"
          primaryAction={{ label: 'Create New', onClick: handlePrimary, icon: <Plus size={16} /> }}
          secondaryAction={{ label: 'Learn More', onClick: handleSecondary }}
        />
      </MemoryRouter>
    );

    const primaryBtn = screen.getByTestId('empty-state-primary-cta');
    const secondaryBtn = screen.getByTestId('empty-state-secondary-cta');

    expect(primaryBtn).toHaveTextContent('Create New');
    expect(secondaryBtn).toHaveTextContent('Learn More');

    fireEvent.click(primaryBtn);
    expect(handlePrimary).toHaveBeenCalledTimes(1);

    fireEvent.click(secondaryBtn);
    expect(handleSecondary).toHaveBeenCalledTimes(1);
  });
});

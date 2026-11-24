import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Badge, Button, Spinner } from './index';

describe('UI primitives (#819)', () => {
  it('Button loading disables the button and shows a spinner (no double submit)', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: /save/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Button defaults to type="button" and forwards ARIA props', () => {
    render(<Button variant="danger" size="lg" aria-describedby="hint">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-describedby', 'hint');
    expect(button).toHaveAttribute('data-variant', 'danger');
  });

  it('Badge renders a dismiss button only when dismissible', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Badge variant="success">Paid</Badge>);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<Badge variant="error" onDismiss={onDismiss}>Failed</Badge>);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('Spinner exposes an accessible status label', () => {
    render(<Spinner size="lg" label="Fetching tasks" />);
    expect(screen.getByRole('status', { name: 'Fetching tasks' })).toHaveAttribute('data-size', 'lg');
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionStatus } from './ConnectionStatus';

describe('ConnectionStatus', () => {
  it('renders nothing while connected', () => {
    const { container } = render(<ConnectionStatus status="connected" reconnectIn={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows connecting', () => {
    render(<ConnectionStatus status="connecting" reconnectIn={0} />);
    expect(screen.getByRole('status').textContent).toBe('Connecting…');
  });

  it('counts down to the next reconnect', () => {
    render(<ConnectionStatus status="disconnected" reconnectIn={8000} />);
    expect(screen.getByRole('status').textContent).toBe('Reconnecting in 8s…');
  });

  it('asks for a refresh once retries are exhausted', () => {
    render(<ConnectionStatus status="disconnected" reconnectIn={0} />);
    expect(screen.getByRole('status').textContent).toBe('Disconnected. Refresh to reconnect.');
  });
});

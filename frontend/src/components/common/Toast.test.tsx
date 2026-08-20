import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToastProvider, useToast } from '../../context/ToastContext';
import { useState } from 'react';

function TestComponent() {
  const { showToast } = useToast();
  const [retryCount, setRetryCount] = useState(0);

  return (
    <div>
      <button onClick={() => showToast('Success!', 'success')}>Add Success</button>
      <button onClick={() => showToast('Info msg', 'info')}>Add Info</button>
      <button onClick={() => showToast('Error msg', 'error')}>Add Error</button>
      <button
        onClick={() =>
          showToast('Action required', 'error', {
            label: 'Retry',
            onClick: () => setRetryCount((c) => c + 1),
          })
        }
      >
        Add Action
      </button>
      <span data-testid="retry-count">{retryCount}</span>
    </div>
  );
}

describe('Toast behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders a toast and auto-dismisses based on type', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Add Success'));
    expect(screen.getByText('Success!')).toBeInTheDocument();

    // Success auto-dismisses in 5s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4900);
    });
    expect(screen.getByText('Success!')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await waitFor(() => {
      expect(screen.queryByText('Success!')).not.toBeInTheDocument();
    });
  });

  it('does not auto-dismiss error toasts', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Add Error'));
    expect(screen.getByText('Error msg')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText('Error msg')).toBeInTheDocument();
  });

  it('pauses auto-dismiss on hover', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Add Success'));
    const toastMessage = screen.getByText('Success!');

    // Hover over the toast
    fireEvent.mouseEnter(toastMessage.parentElement!);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    
    // Should still be there because of hover
    expect(screen.getByText('Success!')).toBeInTheDocument();

    // Mouse leave
    fireEvent.mouseLeave(toastMessage.parentElement!);
    
    // Now it should auto-dismiss after its duration
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    await waitFor(() => {
      expect(screen.queryByText('Success!')).not.toBeInTheDocument();
    });
  });

  it('limits visible toasts to 3 and queues the rest', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    // Add 4 error toasts (no auto-dismiss)
    fireEvent.click(screen.getByText('Add Error'));
    fireEvent.click(screen.getByText('Add Error'));
    fireEvent.click(screen.getByText('Add Error'));
    fireEvent.click(screen.getByText('Add Error'));

    // The oldest one should be dismissed to make room for the 4th
    await waitFor(() => {
      const errorToasts = screen.getAllByText('Error msg');
      expect(errorToasts).toHaveLength(3);
    });
  });

  it('supports action buttons', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Add Action'));
    expect(screen.getByText('Action required')).toBeInTheDocument();

    const retryBtn = screen.getByText('Retry');
    fireEvent.click(retryBtn);

    expect(screen.getByTestId('retry-count')).toHaveTextContent('1');
    
    // Toast should dismiss after action is clicked
    await waitFor(() => {
      expect(screen.queryByText('Action required')).not.toBeInTheDocument();
    });
  });
});

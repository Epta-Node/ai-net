import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopyButton } from './CopyButton';

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockImplementation(() => Promise.resolve()),
  },
});

describe('CopyButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with the provided label', () => {
    render(<CopyButton text="hello" label="Copy Code" />);
    expect(screen.getByTestId('copy-button')).toHaveTextContent('Copy Code');
  });

  it('writes text to the clipboard and shows copied feedback on click', async () => {
    render(<CopyButton text="const a = 10;" label="Copy" />);

    fireEvent.click(screen.getByTestId('copy-button'));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 10;');

    await waitFor(() => {
      expect(screen.getByTestId('copy-button')).toHaveTextContent('✓ Copied!');
    });
  });

  it('calls the onCopy callback after a successful copy', async () => {
    const onCopy = vi.fn();
    render(<CopyButton text="GABC123" label="Copy" onCopy={onCopy} />);

    fireEvent.click(screen.getByTestId('copy-button'));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('GABC123');
      expect(onCopy).toHaveBeenCalledTimes(1);
    });
  });

  it('does not call onCopy when the clipboard write fails', async () => {
    const onCopy = vi.fn();
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<CopyButton text="fail" label="Copy" onCopy={onCopy} />);

    fireEvent.click(screen.getByTestId('copy-button'));

    await waitFor(() => {
      expect(onCopy).not.toHaveBeenCalled();
    });

    spy.mockRestore();
    vi.mocked(navigator.clipboard.writeText).mockResolvedValue(undefined);
  });

  it('renders icon-only when label and copiedLabel are empty strings', () => {
    render(<CopyButton text="icon-only" label="" copiedLabel="" />);

    const button = screen.getByTestId('copy-button');
    // No text content — only the icon
    expect(button).not.toHaveTextContent('Copy');
    expect(button).not.toHaveTextContent('Copied');
  });

  it('sets aria-label on the button when aria-label prop is provided', () => {
    render(<CopyButton text="GABCD123" label="" copiedLabel="" aria-label="Copy public key" />);

    const button = screen.getByRole('button', { name: 'Copy public key' });
    expect(button).toBeInTheDocument();
  });
});

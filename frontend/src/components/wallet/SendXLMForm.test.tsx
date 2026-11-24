/**
 * @vitest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { SendXLMForm } from './SendXLMForm';
import { useWallet } from '../../context/WalletContext';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

const connectedWallet = {
  publicKey: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H',
  keypair: { publicKey: () => 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' },
  connected: true,
  connectionMethod: 'secret-key',
};

// The form only reads these four fields, so a partial wallet is enough.
const mockWallet = (wallet: Record<string, unknown>) =>
  vi.mocked(useWallet).mockReturnValue(wallet as unknown as ReturnType<typeof useWallet>);

// Mock wallet context
vi.mock('../../context/WalletContext', () => ({
  useWallet: vi.fn(),
}));

// Mock wallet balance hook
vi.mock('../../hooks/useWalletBalance', () => ({
  useWalletBalance: vi.fn(() => ({
    balance: '100.0000000',
    balances: [{ asset_type: 'native', balance: '100.0000000' }],
    loading: false,
    error: null,
  })),
}));

// Mock toast hook
vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ showToast }),
}));

// Mock freighter service
vi.mock('../../services/freighter', () => ({
  signTransactionWithFreighter: vi.fn(),
}));

// Mock Stellar SDK
vi.mock('@stellar/stellar-sdk', () => ({
  TransactionBuilder: vi.fn(() => {
    const builder = {
      addOperation: vi.fn(() => builder),
      addMemo: vi.fn(() => builder),
      setTimeout: vi.fn(() => builder),
      build: vi.fn(() => ({
        sign: vi.fn(),
        toEnvelope: () => ({ toXDR: () => 'signed-xdr' }),
      })),
    };
    return builder;
  }),
  Operation: { payment: vi.fn(() => ({})) },
  Asset: { native: vi.fn(() => ({})) },
  BASE_FEE: '100',
  Networks: { TESTNET: 'testnet' },
  Memo: { text: vi.fn(() => ({})) },
  Horizon: {
    Server: vi.fn(() => ({
      loadAccount: vi.fn(() => Promise.resolve({})),
    })),
  },
  Keypair: {
    fromPublicKey: vi.fn((key: string) => {
      if (!key || key.length !== 56) throw new Error('Invalid key');
      return { publicKey: () => key };
    }),
  },
  Transaction: vi.fn(),
}));

describe('SendXLMForm Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWallet(connectedWallet);
  });

  describe('Disconnected State', () => {
    it('shows disconnected message when wallet is not connected', () => {
      (useWallet as unknown as Mock).mockReturnValue({
        publicKey: null,
        keypair: null,
        connected: false,
        connectionMethod: null,
      });

      render(<SendXLMForm />);

      expect(screen.getByText(/Connect your wallet to send XLM/)).toBeInTheDocument();
    });
  });

  describe('Form Rendering', () => {
    it('renders form with all input fields', () => {
      render(<SendXLMForm />);

      expect(screen.getByLabelText(/destination/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/memo/i)).toBeInTheDocument();
    });

    it('renders send button', () => {
      render(<SendXLMForm />);

      expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    });

    it('displays available balance hint', () => {
      render(<SendXLMForm />);

      expect(screen.getByText(/100\.0000000/)).toBeInTheDocument();
    });

    it('disables inputs when submitting', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i) as HTMLInputElement;
      const amountInput = screen.getByLabelText(/amount/i) as HTMLInputElement;
      const sendBtn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;

      // Initially enabled
      expect(destInput.disabled).toBe(false);
      expect(amountInput.disabled).toBe(false);
      expect(sendBtn.disabled).toBe(false);

      // Keep the Horizon submission pending so the form stays in its submitting state
      global.fetch = vi.fn(() => new Promise<Response>(() => {}));

      // Fill and submit form
      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);
      fireEvent.click(await screen.findByRole('button', { name: /confirm & send/i }));

      // While the payment is being submitted, the form is locked
      await waitFor(() => {
        expect(sendBtn).toHaveAttribute('disabled');
        expect(destInput.disabled).toBe(true);
        expect(amountInput.disabled).toBe(true);
      });
    });
  });

  describe('Form Validation', () => {
    it('shows error for invalid destination address', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'invalid-address' } });
      fireEvent.click(sendBtn);

      expect(await screen.findByText('Invalid Stellar address')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows error for amount exceeding balance', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '150' } }); // Exceeds 100 balance
      fireEvent.click(sendBtn);

      await waitFor(() => {
        const errorRole = screen.queryByRole('alert');
        expect(errorRole).toBeInTheDocument();
      });
    });

    it('shows error for empty destination', async () => {
      render(<SendXLMForm />);

      const sendBtn = screen.getByRole('button', { name: /send/i });
      fireEvent.click(sendBtn);

      expect(await screen.findByText('Destination address is required')).toBeInTheDocument();
    });

    it('shows error for zero or negative amount', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '0' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        const errorRole = screen.queryByRole('alert');
        expect(errorRole).toBeInTheDocument();
      });
    });

    it('enforces memo length limit of 28 characters', () => {
      render(<SendXLMForm />);

      const memoInput = screen.getByLabelText(/memo/i) as HTMLInputElement;
      expect(memoInput.maxLength).toBe(28);
    });
  });

  describe('Confirmation Modal', () => {
    it('shows confirmation modal when form is submitted', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
    });

    it('displays confirmation details', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      const testAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H';
      fireEvent.change(destInput, { target: { value: testAddress } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        expect(screen.getByText(testAddress)).toBeInTheDocument();
        expect(screen.getByText(/10 XLM/)).toBeInTheDocument();
      });
    });

    it('closes confirmation when cancel is clicked', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      const cancelBtn = screen.getByRole('button', { name: /cancel/i });
      fireEvent.click(cancelBtn);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('closes confirmation when backdrop is clicked', async () => {
      const { container } = render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      const overlay = container.querySelector('[class*="overlay"]');
      if (overlay) {
        fireEvent.click(overlay);

        await waitFor(() => {
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        });
      }
    });
  });

  describe('Transaction Submission', () => {
    it('displays submitting state during transaction', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      const confirmBtn = screen.getByRole('button', { name: /confirm & send/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(confirmBtn).toHaveAttribute('disabled');
      });
    });

    it('shows error message on submission failure', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ extras: { result_codes: { transaction: 'TX_FAILED' } } }),
        } as Response)
      );

      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      const confirmBtn = screen.getByRole('button', { name: /confirm & send/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const errorAlert = screen.queryByRole('alert');
        expect(errorAlert).toBeInTheDocument();
      });
    });
  });

  describe('Success State', () => {
    it('shows success message after transaction sent', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ hash: 'tx-hash-123' }),
        } as Response)
      );

      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      const confirmBtn = screen.getByRole('button', { name: /confirm & send/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const successMsg = screen.queryByRole('status');
        expect(successMsg).toBeInTheDocument();
      });
    });

    it('displays transaction hash in success message', async () => {
      const txHash = 'abc123def456';
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ hash: txHash }),
        } as Response)
      );

      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        const confirmBtn = screen.getByRole('button', { name: /confirm & send/i });
        fireEvent.click(confirmBtn);
      });

      await waitFor(() => {
        expect(screen.queryByText(txHash)).toBeInTheDocument();
      });
    });

    it('disables form inputs during success state', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ hash: 'tx-hash' }),
        } as Response)
      );

      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i) as HTMLInputElement;
      const amountInput = screen.getByLabelText(/amount/i) as HTMLInputElement;
      const sendBtn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        const confirmBtn = screen.getByRole('button', { name: /confirm & send/i });
        fireEvent.click(confirmBtn);
      });

      await waitFor(() => {
        expect(destInput.disabled).toBe(true);
        expect(amountInput.disabled).toBe(true);
        expect(sendBtn.disabled).toBe(true);
      });
    });

    it('allows dismissing success message', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ hash: 'tx-hash' }),
        } as Response)
      );

      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        const confirmBtn = screen.getByRole('button', { name: /confirm & send/i });
        fireEvent.click(confirmBtn);
      });

      await waitFor(() => {
        expect(screen.queryByRole('status')).toBeInTheDocument();
      });

      const dismissBtn = screen.getByRole('button', { name: /dismiss/i });
      fireEvent.click(dismissBtn);

      await waitFor(() => {
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
      });
    });
  });

  describe('Toasts', () => {
    const submitPayment = async () => {
      fireEvent.change(screen.getByLabelText(/destination/i), {
        target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' },
      });
      fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '10' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      fireEvent.click(await screen.findByRole('button', { name: /confirm & send/i }));
    };

    it('shows a success toast once the payment is submitted', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ hash: 'tx-hash' }),
        } as Response)
      );

      render(<SendXLMForm />);
      await submitPayment();

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          'Payment sent successfully!',
          'success',
          expect.objectContaining({ duration: 8000 }),
        );
      });
      expect(showToast).not.toHaveBeenCalledWith(expect.anything(), 'error', expect.anything());
    });

    it('shows an error toast with the Horizon result code when submission fails', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ extras: { result_codes: { transaction: 'tx_bad_seq' } } }),
        } as Response)
      );

      render(<SendXLMForm />);
      await submitPayment();

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          'tx_bad_seq',
          'error',
          expect.objectContaining({ duration: 7000 }),
        );
      });
      expect(showToast).not.toHaveBeenCalledWith(expect.anything(), 'success', expect.anything());
    });

    it('does not submit or toast when the destination address is invalid', async () => {
      global.fetch = vi.fn();

      render(<SendXLMForm />);

      fireEvent.change(screen.getByLabelText(/destination/i), {
        target: { value: 'GNOTAREALADDRESS' },
      });
      fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '10' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(await screen.findByText('Invalid Stellar address')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    it('has accessible form labels', () => {
      render(<SendXLMForm />);

      expect(screen.getByLabelText(/destination/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/memo/i)).toBeInTheDocument();
    });

    it('has alert role for error messages', async () => {
      render(<SendXLMForm />);

      const sendBtn = screen.getByRole('button', { name: /send/i });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        const errors = screen.queryAllByRole('alert');
        expect(errors.length).toBeGreaterThan(0);
      });
    });

    it('has proper dialog attributes on confirmation modal', async () => {
      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
      });
    });
  });

  describe('Freighter Integration', () => {
    it('uses freighter signing when connectionMethod is freighter', async () => {
      (useWallet as unknown as Mock).mockReturnValue({
        publicKey: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H',
        keypair: null,
        connected: true,
        connectionMethod: 'freighter',
      });
      // Leave the Freighter signature pending so the signing state is visible
      vi.mocked(signTransactionWithFreighter).mockReturnValue(new Promise<string>(() => {}));

      render(<SendXLMForm />);

      const destInput = screen.getByLabelText(/destination/i);
      const amountInput = screen.getByLabelText(/amount/i);
      const sendBtn = screen.getByRole('button', { name: /send/i });

      fireEvent.change(destInput, { target: { value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H' } });
      fireEvent.change(amountInput, { target: { value: '10' } });
      fireEvent.click(sendBtn);

      fireEvent.click(await screen.findByRole('button', { name: /confirm & send/i }));

      await waitFor(() => {
        expect(signTransactionWithFreighter).toHaveBeenCalledWith('signed-xdr', connectedWallet.publicKey);
        expect(document.getElementById('btn-confirm-payment')).toHaveTextContent('Signing with Freighter');
      });
    });
  });
});
